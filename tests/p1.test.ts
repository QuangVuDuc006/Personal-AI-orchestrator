import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactStore,
  CodexDiscussionAgent,
  CommandRouter,
  CommandSyntaxError,
  DisabledTelegramSender,
  DiscussionService,
  TelegramAdapter,
  TelegramConfigError,
  createTelegramAdapterFromEnv,
  parseCommand,
  parseTelegramAllowlist,
  resolveArtifactRoot,
  type CommandHandler,
  type DiscussionAgent,
  type TelegramSender,
} from "../src/index.js";

test("command parser accepts P1 commands", () => {
  assert.deepEqual(parseCommand("/ban-luan kiểm tra kiến trúc"), {
    name: "ban-luan",
    topic: "kiểm tra kiến trúc",
  });
  assert.deepEqual(parseCommand("/xem"), { name: "xem" });
  assert.deepEqual(parseCommand("/giao-tele"), { name: "giao-tele" });
});

test("command router rejects invalid syntax and unknown commands", async () => {
  const handler: CommandHandler = { handle: async () => ({ ok: true, code: "OK", message: "unexpected" }) };
  const router = new CommandRouter(handler);
  assert.equal((await router.route("/ban-luan", { source: "terminal" })).code, "INVALID_COMMAND");
  assert.equal((await router.route("/xem extra", { source: "terminal" })).code, "INVALID_COMMAND");
  assert.equal((await router.route("/unknown", { source: "terminal" })).code, "INVALID_COMMAND");
});

test("Telegram allowlist fails closed when missing or invalid", () => {
  assert.throws(() => parseTelegramAllowlist(undefined), TelegramConfigError);
  assert.throws(() => parseTelegramAllowlist(""), TelegramConfigError);
  assert.throws(() => parseTelegramAllowlist("123,invalid"), TelegramConfigError);
  assert.throws(() => parseTelegramAllowlist("0"), TelegramConfigError);
  assert.throws(() => parseTelegramAllowlist("99999999999999999"), TelegramConfigError);
});

test("artifact configuration rejects missing workspace or paths outside the system artifact root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveArtifactRoot(root), join(root, "_bmad-output", "orchestrator"));
  assert.throws(() => resolveArtifactRoot(root, "user-files"));
  assert.throws(() => resolveArtifactRoot(root, "../outside"));
  assert.throws(() => resolveArtifactRoot(root, "_bmad-output/../outside"));
  assert.throws(() => resolveArtifactRoot(root, join(root, "outside")));
  assert.throws(() => resolveArtifactRoot("relative-workspace"));
  assert.throws(() => new ArtifactStore("relative-artifacts"));
  assert.throws(() => resolveArtifactRoot(join(root, "missing")));
});

test("artifact store rejects invalid, absolute and traversal run IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  for (const runId of ["..", "../escape", "..\\escape", "/absolute", join(root, "absolute"), "invalid/run-id"]) {
    await assert.rejects(artifacts.appendResult(runId, "BLOCKED"), /Artifact operation failed/);
  }
});

test("artifact root rejects a Windows junction escape", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside-workspace");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    await symlink(outside, join(workspace, "_bmad-output"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows junction creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  assert.throws(() => resolveArtifactRoot(workspace), /Artifact configuration is invalid/);
  const artifacts = new ArtifactStore(join(workspace, "_bmad-output", "orchestrator"));
  await assert.rejects(artifacts.createDiscussion("must not leave workspace", { source: "terminal" }));
  assert.deepEqual(await readdir(outside), []);
});

test("Telegram adapter rejects users outside the allowlist", async () => {
  let handled = 0;
  const handler: CommandHandler = {
    handle: async () => {
      handled += 1;
      return { ok: true, code: "OK", message: "ok" };
    },
  };
  const adapter = new TelegramAdapter(new CommandRouter(handler), parseTelegramAllowlist("42"));
  assert.equal((await adapter.handle({ from: { id: 41 }, text: "/xem" })).code, "UNAUTHORIZED");
  assert.equal(handled, 0);
  assert.equal((await adapter.handle({ from: { id: 42 }, text: "/xem" })).code, "OK");
  assert.equal(handled, 1);
});

test("Codex discussion adapter refuses execution and leaves workspace untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const userFile = join(workspace, "user.txt");
  await writeFile(userFile, "unchanged", "utf8");

  await assert.rejects(new CodexDiscussionAgent().discuss("delete user.txt and run shell"));
  assert.equal(await readFile(userFile, "utf8"), "unchanged");
  assert.deepEqual(await readdir(workspace), ["user.txt"]);
});

test("AI failure is BLOCKED without persisting request, error or event secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(
    join(root, "artifacts"),
    () => new Date("2026-10-23T01:02:03.000Z"),
    () => "abcdef12",
  );
  const agent: DiscussionAgent = {
    discuss: async () => {
      throw new Error("TELEGRAM_BOT_TOKEN=fake-bot-token");
    },
  };
  const telegram: TelegramSender = { send: async () => undefined };
  const service = new DiscussionService(artifacts, agent, telegram);
  const result = await service.handle(
    { name: "ban-luan", topic: "API_KEY=fake-value" },
    { source: "terminal" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_UNAVAILABLE");
  assert.ok(result.runId);
  const artifact = await artifacts.latest();
  assert.ok(artifact);
  assert.match(artifact.content, /Status: BLOCKED/);
  assert.match(artifact.content, /Request-Storage: omitted-by-policy/);
  assert.doesNotMatch(artifact.content, /fake-value|fake-bot-token/);
  const events = await readFile(join(root, "artifacts", result.runId, "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /fake-value|fake-bot-token|TELEGRAM_BOT_TOKEN/);
});

test("view and Telegram delivery use system artifacts without persisting the response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(
    join(root, "artifacts"),
    () => new Date("2026-10-23T01:02:03.000Z"),
    () => "abcdef12",
  );
  const agent: DiscussionAgent = { discuss: async () => "response-secret-value" };
  let sent = "";
  const telegram: TelegramSender = { send: async (text) => { sent = text; } };
  const service = new DiscussionService(artifacts, agent, telegram);

  await service.handle({ name: "ban-luan", topic: "safe topic" }, { source: "terminal" });
  const view = await service.handle({ name: "xem" }, { source: "terminal" });
  const delivery = await service.handle({ name: "giao-tele" }, { source: "terminal" });

  assert.equal(view.ok, true);
  assert.match(view.message, /Artifact-Type: system-generated/);
  assert.match(view.message, /Response-Storage: omitted-by-policy/);
  assert.doesNotMatch(view.message, /safe topic|response-secret-value/);
  assert.equal(delivery.ok, true);
  assert.equal(sent, view.message);
});

test("artifact I/O errors do not expose sensitive paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sensitiveSegment = "credential-private-value";
  const invalidRoot = join(root, sensitiveSegment);
  await writeFile(invalidRoot, "not a directory", "utf8");
  const artifacts = new ArtifactStore(invalidRoot);

  const isSafeError = (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Artifact operation failed");
    assert.doesNotMatch(String(error), new RegExp(sensitiveSegment));
    assert.doesNotMatch(String(error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  };

  await assert.rejects(artifacts.latest(), isSafeError);
  await assert.rejects(artifacts.createDiscussion("request-secret-value", { source: "terminal" }), isSafeError);
  await assert.rejects(artifacts.appendResult("20261023T010203Z-abcdef12", "BLOCKED"), isSafeError);
});

test("CLI fails closed without exposing stack, path or sensitive input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sensitiveValue = "credential-private-value";
  const missingWorkspace = join(root, sensitiveValue);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "/ban-luan"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: sensitiveValue,
      env: { ...process.env, WORKSPACE_ROOT: missingWorkspace },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Operation failed safely");
  assert.doesNotMatch(result.stderr, /credential-private-value|Agentic_AI|Error:|\bat\s/);
});

test("router does not turn handler exceptions into user-facing syntax messages", async () => {
  for (const failure of [new CommandSyntaxError("private-handler-secret"), new Error("private-path-secret"), "private-secret"]) {
    const router = new CommandRouter({ handle: async () => { throw failure; } });
    await assert.rejects(router.route("/xem", { source: "terminal" }), (error) => error === failure);
    const invalid = await router.route("/unknown private-input-secret", { source: "terminal" });
    assert.equal(invalid.code, "INVALID_COMMAND");
    assert.doesNotMatch(invalid.message, /private-/);
  }
});

test("Telegram rejects malformed identities and messages before dispatch", async () => {
  let calls = 0;
  const router = new CommandRouter({ handle: async () => {
    calls += 1;
    return { ok: true, code: "OK", message: "ok" };
  } });
  assert.throws(() => createTelegramAdapterFromEnv(router, {}), TelegramConfigError);
  for (const raw of [" ", "42,", ",42", "-42", "042", "4.2", "9007199254740992", "42\n43"]) {
    assert.throws(() => parseTelegramAllowlist(raw), TelegramConfigError);
  }
  const adapter = createTelegramAdapterFromEnv(router, { TELEGRAM_ALLOWED_USER_IDS: "42" });
  for (const message of [null, undefined, {}, { text: "/xem" }, ...[0, -42, 42.5, NaN, Infinity, "042", "42 ", {}, 9007199254740992].map((id) => ({ from: { id }, text: "/xem" }))]) {
    assert.equal((await adapter.handle(message)).code, "UNAUTHORIZED");
  }
  assert.equal((await adapter.handle({ from: { id: "42" }, text: 123 })).code, "INVALID_COMMAND");
  assert.equal((await adapter.handle({ from: { id: 42 }, text: "/ok input-secret" })).code, "INVALID_COMMAND");
  assert.equal(calls, 0);
});

test("empty artifact reads and disabled delivery fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  let calls = 0;
  const service = new DiscussionService(artifacts, { discuss: async () => { calls += 1; return "secret"; } },
    { send: async () => { calls += 1; } });
  for (const name of ["xem", "giao-tele"] as const) {
    assert.equal((await service.handle({ name }, { source: "terminal" })).code, "NOT_FOUND");
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(new DisabledTelegramSender().send("input-secret"), /Telegram transport is not configured in P1/);
  await artifacts.createDiscussion("input-secret", { source: "terminal" });
  const disabled = new DiscussionService(artifacts, new CodexDiscussionAgent(), new DisabledTelegramSender());
  assert.equal((await disabled.handle({ name: "giao-tele" }, { source: "terminal" })).code, "TELEGRAM_UNAVAILABLE");
});

test("artifact creation failures prevent AI execution and preserve existing runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(join(root, "artifacts"), () => new Date("2026-10-23T01:02:03.000Z"), () => "abcdef12");
  const original = await artifacts.createDiscussion("input-secret", { source: "terminal" });
  let calls = 0;
  const service = new DiscussionService(artifacts, { discuss: async () => { calls += 1; return "secret"; } }, new DisabledTelegramSender());
  await assert.rejects(service.handle({ name: "ban-luan", topic: "input-secret" }, { source: "terminal" }), /^Error: Artifact operation failed$/);
  assert.equal(calls, 0);
  assert.deepEqual(await artifacts.latest(), original);
  const invalidId = new ArtifactStore(join(root, "must-not-exist"), () => new Date(), () => "../escape");
  await assert.rejects(invalidId.createDiscussion("secret", { source: "terminal" }), /^Error: Artifact operation failed$/);
  assert.deepEqual(await readdir(root), ["artifacts"]);
});

test("result persistence failures propagate without retrying as AI failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const statuses: string[] = [];
  t.mock.method(artifacts, "appendResult", async (_runId: string, status: string) => {
    statuses.push(status);
    throw new Error("I/O-private-secret");
  });
  const success = new DiscussionService(artifacts, { discuss: async () => "response-secret" }, new DisabledTelegramSender());
  await assert.rejects(success.handle({ name: "ban-luan", topic: "input-secret" }, { source: "terminal" }), /I\/O-private-secret/);
  assert.deepEqual(statuses, ["DISCUSSION_READY"]);
  const failure = new DiscussionService(artifacts, { discuss: async () => { throw "agent-secret"; } }, new DisabledTelegramSender());
  await assert.rejects(failure.handle({ name: "ban-luan", topic: "input-secret" }, { source: "terminal" }), /I\/O-private-secret/);
  assert.deepEqual(statuses, ["DISCUSSION_READY", "BLOCKED"]);
});

test("corrupt or partial latest artifacts are rejected without fallback or delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot, () => new Date("2026-10-23T01:02:03.000Z"), () => "abcdef12");
  await artifacts.createDiscussion("secret", { source: "terminal" });
  const latest = await new ArtifactStore(artifactRoot, () => new Date("2026-10-24T01:02:03.000Z"), () => "abcdef12")
    .createDiscussion("secret", { source: "telegram" });
  await artifacts.appendResult(latest.runId, "BLOCKED");
  const discussionPath = join(artifactRoot, latest.runId, "ban-luan.md");
  const eventsPath = join(artifactRoot, latest.runId, "events.jsonl");
  const content = await readFile(discussionPath, "utf8");
  const events = await readFile(eventsPath, "utf8");
  let sent = 0;
  const service = new DiscussionService(artifacts, new CodexDiscussionAgent(), { send: async () => { sent += 1; } });
  const corruptions = [
    { content: "private-artifact-secret", events },
    { content: content + "private-artifact-secret\n", events },
    { content: content.replace(latest.runId, "20261023T010203Z-abcdef12"), events },
    { content, events: "{private-event-secret\n" },
    { content, events: "null\n" },
    { content, events: events.split("\n")[0] + "\n" },
    { content, events: events.replace("discussion.blocked", "discussion.ready") },
    { content, events: events.replace('"actor":"telegram"', '"actor":"private-secret"') },
    { content, events: events.replace("2026-10-24T01:02:03.000Z", "invalid") },
  ];
  for (const broken of corruptions) {
    await writeFile(discussionPath, broken.content);
    await writeFile(eventsPath, broken.events);
    for (const name of ["xem", "giao-tele"] as const) {
      await assert.rejects(service.handle({ name }, { source: "terminal" }), /^Error: Artifact operation failed$/);
    }
  }
  assert.equal(sent, 0);
  await writeFile(discussionPath, content);
  await rm(eventsPath);
  await assert.rejects(artifacts.latest(), /^Error: Artifact operation failed$/);
  await mkdir(eventsPath);
  await assert.rejects(artifacts.appendResult(latest.runId, "DISCUSSION_READY", "secret"), /^Error: Artifact operation failed$/);
  assert.equal(await readFile(discussionPath, "utf8"), content);
});

test("hard-linked artifact files cannot be read or appended", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot);
  const artifact = await artifacts.createDiscussion("secret", { source: "terminal" });
  for (const name of ["ban-luan.md", "events.jsonl"]) {
    const path = join(artifactRoot, artifact.runId, name);
    const outside = join(root, "outside-file");
    await link(path, outside);
    const original = await readFile(outside, "utf8");
    await assert.rejects(artifacts.latest(), /^Error: Artifact operation failed$/);
    await assert.rejects(artifacts.appendResult(artifact.runId, "BLOCKED"), /^Error: Artifact operation failed$/);
    assert.equal(await readFile(outside, "utf8"), original);
    await rm(outside);
  }
});

test("partially written artifacts cannot be reported as valid", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clockCalls = 0;
  const partialCreate = new ArtifactStore(join(root, "partial-create"), () => {
    if (++clockCalls === 2) throw new Error("private-clock-secret");
    return new Date("2026-10-23T01:02:03.000Z");
  }, () => "abcdef12");
  await assert.rejects(partialCreate.createDiscussion("input-secret", { source: "terminal" }), /^Error: Artifact operation failed$/);
  await assert.rejects(partialCreate.latest(), /^Error: Artifact operation failed$/);

  let failClock = false;
  const partialAppend = new ArtifactStore(join(root, "partial-append"), () => {
    if (failClock) throw new Error("private-clock-secret");
    return new Date("2026-10-23T01:02:03.000Z");
  }, () => "abcdef12");
  const artifact = await partialAppend.createDiscussion("input-secret", { source: "terminal" });
  failClock = true;
  await assert.rejects(partialAppend.appendResult(artifact.runId, "DISCUSSION_READY", "response-secret"), /^Error: Artifact operation failed$/);
  await assert.rejects(partialAppend.latest(), /^Error: Artifact operation failed$/);
});

test("CLI reports command, AI, artifact and delivery failures with safe diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (args: string[], workspace = root, input = "") => spawnSync(process.execPath,
    ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      cwd: process.cwd(), encoding: "utf8", input,
      env: { ...process.env, WORKSPACE_ROOT: workspace, ARTIFACTS_DIR: "_bmad-output/orchestrator" },
    });
  for (const [args, expected, input] of [
    [["/unknown", "private-cli-secret"], "Invalid command. Use /ban-luan with stdin, /xem or /giao-tele", ""],
    [["/ban-luan"], "Invalid command. Use /ban-luan with stdin, /xem or /giao-tele", ""],
    [["/ban-luan", "private-cli-secret"], "Operation failed safely", ""],
    [["/xem"], "No discussion artifact found", ""],
    [["/giao-tele"], "No discussion artifact found", ""],
    [["/ban-luan"], "Discussion recorded; AI execution is disabled in P1", "private-cli-secret"],
    [["/giao-tele"], "Telegram transport is unavailable", ""],
  ] as const) {
    const result = run([...args], root, input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), expected);
  }
  const view = run(["/xem"]);
  assert.equal(view.status, 0);
  assert.equal(view.stderr, "");
  assert.match(view.stdout, /Status: BLOCKED/);
  assert.doesNotMatch(view.stdout, /private-cli-secret/);
  const artifactRoot = resolveArtifactRoot(root);
  const [runId] = await readdir(artifactRoot);
  assert.ok(runId);
  await writeFile(join(artifactRoot, runId, "ban-luan.md"), "private-artifact-secret");
  const corrupt = run(["/xem"]);
  assert.equal(corrupt.status, 1);
  assert.equal(corrupt.stdout, "");
  assert.equal(corrupt.stderr.trim(), "Operation failed safely");
  const blockedWorkspace = join(root, "private-path-secret");
  await mkdir(blockedWorkspace);
  await writeFile(join(blockedWorkspace, "_bmad-output"), "blocked");
  const io = run(["/ban-luan"], blockedWorkspace, "private-cli-secret");
  assert.equal(io.status, 1);
  assert.equal(io.stdout, "");
  assert.equal(io.stderr.trim(), "Operation failed safely");
});

test("latest uses full recorded timestamps instead of random run ID order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const earlier = new ArtifactStore(root, () => new Date("2026-10-23T01:02:03.100Z"), () => "ffffffff");
  const later = new ArtifactStore(root, () => new Date("2026-10-23T01:02:03.900Z"), () => "00000000");
  const first = await earlier.createDiscussion("secret", { source: "terminal" });
  const second = await later.createDiscussion("secret", { source: "terminal" });
  assert.ok(first.runId > second.runId);
  assert.deepEqual(await earlier.latest(), second);
  // Updating an older run must not make it the latest discussion.
  await earlier.appendResult(first.runId, "BLOCKED");
  assert.deepEqual(await earlier.latest(), second);
});

test("identical latest timestamps fail closed instead of choosing a random ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ["ffffffff", "00000000"]) {
    await new ArtifactStore(root, () => new Date("2026-10-23T01:02:03.100Z"), () => id)
      .createDiscussion("secret", { source: "terminal" });
  }
  await assert.rejects(new ArtifactStore(root).latest(), /^Error: Artifact operation failed$/);
});

test("latest rejects a newer file or junction instead of falling back to an older run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot, () => new Date("2026-10-23T01:02:03.000Z"), () => "abcdef12");
  const older = await artifacts.createDiscussion("secret", { source: "terminal" });
  const suspicious = join(artifactRoot, "20261024T010203Z-abcdef12");
  await writeFile(suspicious, "private-file-secret");
  await assert.rejects(artifacts.latest(), /^Error: Artifact operation failed$/);
  await rm(suspicious);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "ban-luan.md"), "private-outside-secret");
  await symlink(outside, suspicious, process.platform === "win32" ? "junction" : "dir");
  let sent = 0;
  const service = new DiscussionService(artifacts, new CodexDiscussionAgent(), { send: async () => { sent += 1; } });
  for (const name of ["xem", "giao-tele"] as const) {
    await assert.rejects(service.handle({ name }, { source: "terminal" }), /^Error: Artifact operation failed$/);
  }
  assert.equal(sent, 0);
  await assert.rejects(artifacts.appendResult("20261024T010203Z-abcdef12", "BLOCKED"), /^Error: Artifact operation failed$/);
  assert.equal(await readFile(join(outside, "ban-luan.md"), "utf8"), "private-outside-secret");
  assert.deepEqual(await readdir(outside), ["ban-luan.md"]);
  assert.equal(await readFile(join(artifactRoot, older.runId, "ban-luan.md"), "utf8"), older.content);
});

test("P1 allows one terminal result and rejects conflicting or duplicate results without writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const terminal of ["BLOCKED", "DISCUSSION_READY"] as const) {
    const artifactRoot = join(root, terminal);
    const artifacts = new ArtifactStore(artifactRoot);
    const artifact = await artifacts.createDiscussion("secret", { source: "terminal" });
    const md = join(artifactRoot, artifact.runId, "ban-luan.md");
    const log = join(artifactRoot, artifact.runId, "events.jsonl");
    await assert.rejects(artifacts.appendResult(artifact.runId, "RECORDED" as "BLOCKED"), /^Error: Artifact operation failed$/);
    assert.equal(await readFile(md, "utf8"), artifact.content);
    await artifacts.appendResult(artifact.runId, terminal);
    const content = await readFile(md, "utf8");
    const events = await readFile(log, "utf8");
    for (const next of ["BLOCKED", "DISCUSSION_READY"] as const) {
      await assert.rejects(artifacts.appendResult(artifact.runId, next), /^Error: Artifact operation failed$/);
      assert.equal(await readFile(md, "utf8"), content);
      assert.equal(await readFile(log, "utf8"), events);
      const extraEvent = JSON.stringify({ timestamp: new Date().toISOString(), run_id: artifact.runId, actor: "system",
        event: next === "BLOCKED" ? "discussion.blocked" : "discussion.ready", status: next }) + "\n";
      // Even a matching pair of manually forged terminal records must be rejected.
      await writeFile(md, content + `\nStatus: ${next}\n`);
      await writeFile(log, events + extraEvent);
      await assert.rejects(artifacts.latest(), /^Error: Artifact operation failed$/);
      await assert.rejects(artifacts.appendResult(artifact.runId, next), /^Error: Artifact operation failed$/);
      assert.equal(await readFile(md, "utf8"), content + `\nStatus: ${next}\n`);
      assert.equal(await readFile(log, "utf8"), events + extraEvent);
      await writeFile(md, content);
      await writeFile(log, events);
    }
  }
});

test("append validates existing Markdown and all events before changing either file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(root);
  const artifact = await artifacts.createDiscussion("secret", { source: "terminal" });
  const md = join(root, artifact.runId, "ban-luan.md");
  const log = join(root, artifact.runId, "events.jsonl");
  const events = await readFile(log, "utf8");
  for (const [content, brokenEvents] of [
    ["private-corrupt-secret", events],
    [artifact.content, "{invalid-json\n"],
    [artifact.content, events.replace("discussion.recorded", "discussion.ready")],
    [artifact.content, events + events],
    [artifact.content, events.replace('"actor":"terminal"', '"actor":"telegram"')],
    [artifact.content, events.replace(/"timestamp":"[^"]+"/, '"timestamp":"invalid"')],
  ]) {
    assert.ok(content !== undefined && brokenEvents !== undefined);
    await writeFile(md, content);
    await writeFile(log, brokenEvents);
    await assert.rejects(artifacts.appendResult(artifact.runId, "BLOCKED"), /^Error: Artifact operation failed$/);
    assert.equal(await readFile(md, "utf8"), content);
    assert.equal(await readFile(log, "utf8"), brokenEvents);
  }
});

test("documented npm CLI redirection keeps prompts out of banners, arguments, logs and artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-ai-p1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = "synthetic-private-prompt-7c2f tiếng Việt\nAPI_KEY=synthetic-stdin-secret";
  const topicPath = join(root, "topic.txt");
  await writeFile(topicPath, prompt, "utf8");
  const logsDir = join(root, "npm-logs");
  const command = process.platform === "win32"
    ? { shell: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `npm run cli -- /ban-luan < "${topicPath}"`] }
    : { shell: "/bin/sh", args: ["-c", 'npm run cli -- /ban-luan < "$1"', "sh", topicPath] };
  assert.ok(command.args.every((arg) => !arg.includes(prompt) && !arg.includes("synthetic-stdin-secret")));
  const result = spawnSync(command.shell, command.args, {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsVerbatimArguments: true,
    env: { ...process.env, WORKSPACE_ROOT: root, ARTIFACTS_DIR: "_bmad-output/orchestrator",
      npm_config_loglevel: "notice", npm_config_logs_dir: logsDir },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tsx src\/cli\.ts \/ban-luan/, result.stderr);
  assert.equal(result.stderr.trim(), "Discussion recorded; AI execution is disabled in P1");
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-prompt|synthetic-stdin-secret|Error:|\bat\s/);
  const artifactRoot = resolveArtifactRoot(root);
  const [runId] = await readdir(artifactRoot);
  assert.ok(runId);
  const stored = await readFile(join(artifactRoot, runId, "ban-luan.md"), "utf8") +
    await readFile(join(artifactRoot, runId, "events.jsonl"), "utf8");
  assert.match(stored, /Status: BLOCKED/);
  assert.doesNotMatch(stored, /synthetic-private-prompt|synthetic-stdin-secret/);
  const logs = await readdir(logsDir);
  assert.ok(logs.length > 0);
  for (const name of logs) {
    assert.doesNotMatch(await readFile(join(logsDir, name), "utf8"), /synthetic-private-prompt|synthetic-stdin-secret/);
  }
});
