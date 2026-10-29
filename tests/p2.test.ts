import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ArtifactStore, resolveArtifactRoot, PlanningService, createPlan, validatePlan, validatePlanInput, hashPlan } from "../src/index.js";
const key = "ab".repeat(32);
const input = { goal: "Add a feature", steps: [{ id: "T1", description: "Implement", goal: "Feature", expectedResult: "Tests pass" }],
  expectedFiles: ["src/feature.ts"], acceptanceCriteria: ["Tests pass"], risks: [] };
async function setup(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "p2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = resolveArtifactRoot(workspace);
  await new ArtifactStore(root).createDiscussion("private-prompt", { source: "terminal" });
  const service = () => new PlanningService(workspace, key, new Set(["alice"]), () => "alice");
  const file = join(root, "planning.json");
  const s = service(); await s.start();
  return { workspace, root, s, service, file };
}
function ref(p: ReturnType<typeof createPlan>) { return { planId: p.planId, planVersion: p.version, planHash: p.planHash }; }
async function resign(file: string, mutate: (s: any) => void) {
  const e = JSON.parse(await readFile(file, "utf8")); const s = JSON.parse(e.body); mutate(s);
  e.body = JSON.stringify(s); e.mac = createHmac("sha256", Buffer.from(key, "hex")).update(e.body).digest("hex");
  await writeFile(file, JSON.stringify(e));
}
test("schema rejects missing, wrong, empty, oversized and unsafe fields", () => {
  assert.deepEqual(validatePlanInput(input), input);
  for (const field of Object.keys(input)) { const bad: any = structuredClone(input); delete bad[field]; assert.throws(() => validatePlanInput(bad)); }
  for (const bad of [null, {}, { ...input, goal: 1 }, { ...input, goal: "" }, { ...input, goal: "x".repeat(4097) },
    { ...input, steps: [] }, { ...input, steps: [input.steps[0], input.steps[0]] }, { ...input, steps: [{}] },
    { ...input, risks: Array(101).fill("risk") }, { ...input, approverId: "alice" }]) assert.throws(() => validatePlanInput(bad));
  for (const path of ["../secret", "/outside", "C:/outside", "\\\\server\\file", "src/../file", "a//b", "a/./b", "NUL", "a.", "a\\b", "a\u0000b"])
    assert.throws(() => validatePlanInput({ ...input, expectedFiles: [path] }));
  for (const bad of [{ planId: "../escape" }, { version: 0 }, { version: 1.5 }, { status: "RUNNING" }, { createdAt: "bad" }, { planHash: "0".repeat(64) }])
    assert.throws(() => validatePlan({ ...createPlan(input), ...bad }));
});
test("canonical hash protects every plan field and ignores object insertion order", () => {
  const p = createPlan(input); assert.deepEqual(validatePlan(p), p); assert.equal(hashPlan(p), p.planHash);
  const reordered = { ...p, steps: p.steps.map(s => ({ expectedResult: s.expectedResult, goal: s.goal, description: s.description, id: s.id })) };
  assert.equal(hashPlan(reordered), p.planHash);
  for (const patch of [{ goal: "changed" }, { version: 2 }, { createdAt: "2026-01-01T00:00:00.000Z" }, { planId: createPlan(input).planId },
    { expectedFiles: ["other.ts"] }, { acceptanceCriteria: ["other"] }, { risks: ["other"] }, { steps: [{ ...p.steps[0], description: "other" }] }])
    assert.throws(() => validatePlan({ ...p, ...patch }));
});
test("all valid transitions, restart, exact approval, revocation and new versions", async t => {
  const { s, service, root } = await setup(t);
  assert.equal((await service().inspect()).state, "DISCUSSION");
  const p = (await s.change("done", input)).plan!;
  assert.equal((await service().inspect()).state, "PLANNING");
  await s.change("request");
  const approved = await service().change("approve", ref(p));
  assert.equal(approved.state, "READY_FOR_EXECUTION"); assert.equal(approved.approval?.approverId, "alice");
  assert.deepEqual(approved.queue, [{ taskId: "T1", planHash: p.planHash, status: "PENDING" }]);
  assert.deepEqual(await service().inspect(), approved);
  await assert.rejects(s.change("approve", ref(p)));
  const revised = await s.change("reject", { ...input, goal: "Revised" });
  assert.equal(revised.plan?.version, 2); assert.equal(revised.plan?.planId, p.planId);
  assert.equal(revised.approval, null); assert.deepEqual(revised.queue, []);
  await s.change("request"); await assert.rejects(s.change("approve", ref(p)));
  await s.change("reject"); assert.equal((await s.inspect()).plan?.version, 3);
  assert.doesNotMatch(await readFile(join(root, "planning.json"), "utf8"), /private-prompt/);
});
test("invalid actions and forged approval identities never mutate storage", async t => {
  const { s, file, workspace } = await setup(t);
  const invalid = async (action: any, payload?: unknown) => { const before = await readFile(file, "utf8"); await assert.rejects(s.change(action, payload)); assert.equal(await readFile(file, "utf8"), before); };
  for (const action of ["request", "approve", "reject", "RUNNING"]) await invalid(action, {});
  const p = (await s.change("done", input)).plan!;
  for (const action of ["done", "approve", "reject"]) await invalid(action, input);
  await s.change("request");
  for (const payload of [undefined, { ...ref(p), planId: createPlan(input).planId }, { ...ref(p), planVersion: 2 },
    { ...ref(p), planHash: "0".repeat(64) }, { ...ref(p), approverId: "alice" }]) await invalid("approve", payload);
  for (const action of ["request", "done", "RUNNING"]) await invalid(action, input);
  await assert.rejects(new PlanningService(workspace, key, new Set(["alice"]), () => "mallory").change("approve", ref(p)));
  await s.change("approve", ref(p));
  for (const action of ["request", "done", "approve", "RUNNING"]) await invalid(action, input);
});
test("tampered signatures, malformed, missing and inconsistent snapshots fail closed", async t => {
  const { s, file, service } = await setup(t); await s.change("done", input); await s.change("request");
  const original = await readFile(file, "utf8");
  for (const contents of ["{", "null", "", original.replace("WAIT_APPROVAL", "READY_FOR_EXECUTION"), original.replace(/\"mac\":\"[a-f0-9]+/, '\"mac\":\"' + '0'.repeat(64))]) {
    await writeFile(file, contents); await assert.rejects(service().inspect());
  }
  for (const mutate of [(s: any) => s.state = "RUNNING", (s: any) => s.state = "READY_FOR_EXECUTION",
    (s: any) => s.events[1].from = "WAIT_APPROVAL", (s: any) => s.plan.goal = "modified",
    (s: any) => s.events[2].hash = "0".repeat(64), (s: any) => s.approval = {}]) {
    await writeFile(file, original); await resign(file, mutate); await assert.rejects(service().inspect());
  }
  await rm(file); await assert.rejects(service().inspect());
});
test("approved plan or approval edits cannot forge authorization even with a recomputed plan hash", async t => {
  const { s, file, service } = await setup(t); const p = (await s.change("done", input)).plan!;
  await s.change("request"); await s.change("approve", ref(p)); const original = await readFile(file, "utf8");
  for (const mutate of [(s: any) => s.approval = null, (s: any) => s.approval.approverId = "mallory",
    (s: any) => s.approval.planVersion++, (s: any) => s.approval.planId = createPlan(input).planId,
    (s: any) => s.approval.planHash = "0".repeat(64), (s: any) => s.queue = [],
    (s: any) => { s.plan.goal = "new"; s.plan.planHash = hashPlan(s.plan); }]) {
    await writeFile(file, original); await resign(file, mutate); await assert.rejects(service().inspect());
  }
  await writeFile(file, original); const e = JSON.parse(original); const data = JSON.parse(e.body);
  data.plan.goal = "forged"; data.plan.planHash = hashPlan(data.plan); data.approval.planHash = data.plan.planHash;
  e.body = JSON.stringify(data); await writeFile(file, JSON.stringify(e)); await assert.rejects(service().inspect());
});
test("concurrent approvals and stale lock reject safely", async t => {
  const { s, service, root } = await setup(t); const p = (await s.change("done", input)).plan!; await s.change("request");
  const results = await Promise.allSettled([s.change("approve", ref(p)), service().change("approve", ref(p))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await service().inspect()).state, "READY_FOR_EXECUTION");
  await mkdir(join(root, "planning.lock")); await assert.rejects(s.inspect());
});
test("write failure before commit preserves previous state and allows restart", async t => {
  const { s, service, file, root } = await setup(t); const p = (await s.change("done", input)).plan!; await s.change("request");
  const before = await readFile(file, "utf8");
  // Simulate a filesystem failure at the snapshot commit boundary.
  t.mock.method(s as any, "write", async () => { throw new Error("private-storage-secret"); });
  await assert.rejects(s.change("approve", ref(p)), /^Error: Planning operation rejected:/);
  assert.equal(await readFile(file, "utf8"), before); assert.equal((await service().inspect()).state, "WAIT_APPROVAL");
  t.mock.restoreAll();
  assert.ok(root);
});
test("store rejects hardlinks, junctions and missing prerequisites", async t => {
  const { s, workspace, root, file } = await setup(t);
  await assert.rejects(s.start());
  const outside = join(workspace, "outside"); await link(file, outside); await assert.rejects(s.inspect()); await rm(outside);
  await rm(file); await mkdir(outside); await symlink(outside, file, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(s.inspect());
  const fresh = await mkdtemp(join(tmpdir(), "p2-empty-")); t.after(() => rm(fresh, { recursive: true, force: true }));
  await assert.rejects(new PlanningService(fresh, key, new Set(["alice"]), () => "alice").start());
  assert.throws(() => new PlanningService(workspace, "", new Set(["alice"]), () => "alice"));
  assert.throws(() => new PlanningService(workspace, key, new Set(), () => "alice"));
  assert.ok((await readdir(root)).includes("planning.json"));
});
test("CLI uses OS identity and bounded stdin; errors omit payloads and paths", async t => {
  const { workspace, root } = await setup(t);
  const run = (command: string, input = "", extra: string[] = [], approvers = userInfo().username) => spawnSync(process.execPath,
    ["--import", "tsx", join(process.cwd(), "src/cli.ts"), command, ...extra], { encoding: "utf8", input,
      env: { ...process.env, WORKSPACE_ROOT: workspace, PLANNING_HMAC_KEY: key, PLANNING_APPROVERS: approvers } });
  // Existing signed state is not bound to a user until approval.
  for (const [command, payload] of [["/done", JSON.stringify(input)], ["/request-approval", ""]]) {
    const r = run(command!, payload); assert.equal(r.status, 0, r.stderr);
  }
  const viewed = run("/plan"); assert.equal(viewed.status, 0); const p = JSON.parse(viewed.stdout).plan;
  const denied = run("/ok", JSON.stringify(ref(p)), [], "someone-else"); assert.equal(denied.status, 1);
  assert.equal(run("/ok", JSON.stringify(ref(p))).status, 0);
  assert.equal(run("/status").status, 0);
  for (const r of [run("/ok", '{"approverId":"private-secret"}'), run("/done", "private-secret"),
    run("/done", "x".repeat(262145)), run("/done", "", ["private-secret"])]) {
    assert.equal(r.status, 1); assert.equal(r.stdout, ""); assert.equal(r.stderr.trim(), "Operation failed safely");
    assert.doesNotMatch(r.stderr, /private-secret|Error:|at /);
  }
  assert.ok(root);
});

test("mid-write failure cleans temporary snapshot and preserves approval checkpoint", async t => {
  const { s, file, root, service } = await setup(t);
  const p = (await s.change("done", input)).plan!; await s.change("request");
  const before = await readFile(file, "utf8"); const safe = (s as any).safe.bind(s);
  t.mock.method(s as any, "safe", async (path: string, directory: boolean) => {
    if (directory && (await readdir(root)).some(n => n.endsWith(".tmp"))) throw new Error("simulated-IO-failure");
    return safe(path, directory);
  });
  await assert.rejects(s.change("approve", ref(p)));
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await service().inspect()).state, "WAIT_APPROVAL");
  assert.ok(!(await readdir(root)).some(n => n.endsWith(".tmp")));
});
test("expected file symlink cannot route a plan outside its workspace", async t => {
  const { s, workspace } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "p2-target-")); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(workspace, "src"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(s.change("done", input)); assert.equal((await s.inspect()).state, "DISCUSSION");
});

test("independent CLI processes cannot both approve the same checkpoint", async t => {
  const { s, workspace } = await setup(t); const p = (await s.change("done", input)).plan!; await s.change("request");
  const approve = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "/ok"], {
      env: { ...process.env, WORKSPACE_ROOT: workspace, PLANNING_HMAC_KEY: key, PLANNING_APPROVERS: userInfo().username },
      stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject); child.on("close", resolve); child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(ref(p)));
  });
  const codes = await Promise.all([approve(), approve()]); assert.deepEqual(codes.sort(), [0, 1]);
  const restarted = new PlanningService(workspace, key, new Set([userInfo().username]), () => userInfo().username);
  assert.equal((await restarted.inspect()).state, "READY_FOR_EXECUTION");
});
