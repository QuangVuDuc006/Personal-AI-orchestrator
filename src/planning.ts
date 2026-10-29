import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join, parse, relative, sep } from "node:path";
import { ArtifactStore, resolveArtifactRoot } from "./artifacts.js";

const FAIL = "Planning operation rejected: invalid input, state, authorization or storage";
const MAX = 262144;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
type State = "DISCUSSION" | "PLANNING" | "WAIT_APPROVAL" | "READY_FOR_EXECUTION";
export type PlanInput = { goal: string; steps: { id: string; description: string; goal: string; expectedResult: string }[];
  expectedFiles: string[]; acceptanceCriteria: string[]; risks: string[] };
export type Plan = PlanInput & { planId: string; version: number; createdAt: string; status: "PROPOSED"; planHash: string };
export type Approval = { planId: string; planVersion: number; planHash: string; approverId: string; approvedAt: string };
type Event = { from: State | null; to: State; at: string; version: number; hash: string | null };
export type PlanningSnapshot = { runId: string; state: State; plan: Plan | null; approval: Approval | null;
  queue: { taskId: string; planHash: string; status: "PENDING" }[]; events: Event[] };
function reject(): never { throw new Error(FAIL); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).sort().join() !== names.sort().join()) reject();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) reject();
}
function date(value: unknown): void {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) reject();
}
function list(value: unknown, nonempty = true): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100 || (nonempty && !value.length)) reject();
  value.forEach(text);
}
export function validatePlanInput(value: unknown): PlanInput {
  const v = object(value);
  keys(v, ["goal", "steps", "expectedFiles", "acceptanceCriteria", "risks"]);
  if (Buffer.byteLength(JSON.stringify(v)) > MAX) reject();
  text(v.goal); list(v.expectedFiles); list(v.acceptanceCriteria); list(v.risks, false);
  for (const path of v.expectedFiles) {
    if (path.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") ||
        path.split("/").some(p => !p || p === "." || p === ".." || p.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) reject();
  }
  if (!Array.isArray(v.steps) || !v.steps.length || v.steps.length > 100) reject();
  const ids = new Set();
  for (const step of v.steps) {
    const s = object(step); keys(s, ["id", "description", "goal", "expectedResult"]);
    Object.values(s).forEach(text);
    if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id) || ids.has(s.id)) reject();
    ids.add(s.id);
  }
  return structuredClone(v) as PlanInput;
}
// Fixed field order, UTF-8 JSON, all plan fields except planHash; array order is significant.
export function hashPlan(plan: Omit<Plan, "planHash"> | Plan): string {
  return createHash("sha256").update(JSON.stringify({ planId: plan.planId, version: plan.version,
    createdAt: plan.createdAt, ...validatePlanInput({ goal: plan.goal, steps: plan.steps.map(s => ({ id: s.id,
      description: s.description, goal: s.goal, expectedResult: s.expectedResult })), expectedFiles: plan.expectedFiles,
      acceptanceCriteria: plan.acceptanceCriteria, risks: plan.risks }), status: plan.status })).digest("hex");
}
export function validatePlan(value: unknown): Plan {
  const v = object(value);
  keys(v, ["planId", "version", "createdAt", "goal", "steps", "expectedFiles", "acceptanceCriteria", "risks", "status", "planHash"]);
  if (typeof v.planId !== "string" || !ID.test(v.planId) || !Number.isSafeInteger(v.version) || (v.version as number) < 1 || v.status !== "PROPOSED") reject();
  date(v.createdAt);
  validatePlanInput({ goal: v.goal, steps: v.steps, expectedFiles: v.expectedFiles, acceptanceCriteria: v.acceptanceCriteria, risks: v.risks });
  const p = v as Plan;
  if (typeof p.planHash !== "string" || !HASH.test(p.planHash) || hashPlan(p) !== p.planHash) reject();
  return structuredClone(p);
}
export function createPlan(input: unknown, previous?: Plan): Plan {
  if (previous) validatePlan(previous);
  const p = { planId: previous?.planId ?? randomUUID(), version: (previous?.version ?? 0) + 1,
    createdAt: new Date().toISOString(), ...validatePlanInput(input), status: "PROPOSED" as const };
  return validatePlan({ ...p, planHash: hashPlan(p) });
}
const edges: Record<State, State[]> = { DISCUSSION: ["PLANNING"], PLANNING: ["WAIT_APPROVAL"],
  WAIT_APPROVAL: ["PLANNING", "READY_FOR_EXECUTION"], READY_FOR_EXECUTION: ["PLANNING"] };
function validateSnapshot(value: unknown, allowed: ReadonlySet<string>): PlanningSnapshot {
  const s = object(value); keys(s, ["runId", "state", "plan", "approval", "queue", "events"]);
  if (typeof s.runId !== "string" || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(s.runId)) reject();
  if (!Array.isArray(s.events) || !s.events.length || s.events.length > 1000) reject();
  let state: State | null = null; let version = 0; let hash: string | null = null;
  for (const raw of s.events) {
    const e = object(raw); keys(e, ["from", "to", "at", "version", "hash"]); date(e.at);
    if (e.from !== state || (state === null ? e.to !== "DISCUSSION" : !edges[state].includes(e.to as State))) reject();
    if (e.to === "PLANNING") { version++; hash = e.hash as string; if (!HASH.test(hash)) reject(); }
    if (e.version !== version || e.hash !== hash) reject();
    state = e.to as State;
  }
  if (state !== s.state) reject();
  if (state === "DISCUSSION") { if (s.plan !== null || s.approval !== null || JSON.stringify(s.queue) !== "[]") reject(); }
  else {
    const p = validatePlan(s.plan);
    if (p.version !== version || p.planHash !== hash) reject();
    if (state === "READY_FOR_EXECUTION") {
      const a = object(s.approval); keys(a, ["planId", "planVersion", "planHash", "approverId", "approvedAt"]); date(a.approvedAt);
      if (a.planId !== p.planId || a.planVersion !== p.version || a.planHash !== p.planHash ||
          typeof a.approverId !== "string" || !allowed.has(a.approverId) || a.approvedAt !== s.events.at(-1).at) reject();
      if (JSON.stringify(s.queue) !== JSON.stringify(queue(p))) reject();
    } else if (s.approval !== null || JSON.stringify(s.queue) !== "[]") reject();
  }
  return structuredClone(s) as PlanningSnapshot;
}
function queue(p: Plan): PlanningSnapshot["queue"] { return p.steps.map(s => ({ taskId: s.id, planHash: p.planHash, status: "PENDING" })); }

export class PlanningService {
  private readonly root: string;
  private readonly key: Buffer;
  private readonly allowed: ReadonlySet<string>;
  constructor(private readonly workspace: string, key: string, allowed: ReadonlySet<string>, private readonly authenticate: () => string) {
    this.root = resolveArtifactRoot(workspace);
    if (!/^[a-f0-9]{64}$/.test(key) || !allowed.size) reject();
    this.key = Buffer.from(key, "hex"); this.allowed = new Set(allowed);
  }
  private identity(): string { const id = this.authenticate(); if (!this.allowed.has(id)) reject(); return id; }
  private mac(body: string): string { return createHmac("sha256", this.key).update(body).digest("hex"); }
  private async safe(path: string, directory: boolean): Promise<void> {
    let current = parse(path).root;
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      const st = await lstat(current);
      if (st.isSymbolicLink()) reject();
    }
    const st = await lstat(path);
    if ((directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1 || st.size > MAX * 4) ||
        (await realpath(path)).toLowerCase() !== path.toLowerCase()) reject();
  }
  private async checkExpectedFiles(plan: Plan | null): Promise<void> {
    for (const path of plan?.expectedFiles ?? []) {
      let current = this.workspace;
      for (const part of path.split("/")) {
        current = join(current, part);
        try {
          const st = await lstat(current);
          if (st.isSymbolicLink()) reject();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
    }
  }
  private async read(): Promise<PlanningSnapshot> {
    const file = join(this.root, "planning.json"); await this.safe(file, false);
    const envelope = object(JSON.parse(await readFile(file, "utf8"))); keys(envelope, ["body", "mac"]);
    if (typeof envelope.body !== "string" || typeof envelope.mac !== "string" || !HASH.test(envelope.mac) ||
        !timingSafeEqual(Buffer.from(envelope.mac, "hex"), Buffer.from(this.mac(envelope.body), "hex"))) reject();
    const snapshot = validateSnapshot(JSON.parse(envelope.body), this.allowed);
    await this.checkExpectedFiles(snapshot.plan);
    return snapshot;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.root, "planning.lock");
    try {
      this.identity();
      // Root creation uses the P1 resolver before and after mkdir to reject links.
      resolveArtifactRoot(this.workspace);
      await mkdir(this.root, { recursive: true }); await this.safe(this.root, true);
      await mkdir(lock);
    } catch { reject(); }
    try { return await operation(); } catch { reject(); } finally { await rmdir(lock).catch(() => { throw new Error(FAIL); }); }
  }
  private async write(s: PlanningSnapshot): Promise<void> {
    validateSnapshot(s, this.allowed);
    await this.checkExpectedFiles(s.plan);
    const body = JSON.stringify(s); if (Buffer.byteLength(body) > MAX * 2) reject();
    const temp = join(this.root, `planning-${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify({ body, mac: this.mac(body) })); await handle.sync(); }
      finally { await handle.close(); }
      // shortcut: path checks cannot eliminate hostile local filesystem TOCTOU; use an OS-isolated store before multi-user deployment.
      await this.safe(this.root, true);
      await rename(temp, join(this.root, "planning.json"));
    } finally { await unlink(temp).catch(() => {}); }
  }
  async inspect(): Promise<PlanningSnapshot> { return this.locked(() => this.read()); }
  async start(): Promise<PlanningSnapshot> {
    return this.locked(async () => {
      try { await lstat(join(this.root, "planning.json")); reject(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const discussion = await new ArtifactStore(this.root).latest(); if (!discussion) reject();
      const s: PlanningSnapshot = { runId: discussion.runId, state: "DISCUSSION", plan: null, approval: null, queue: [],
        events: [{ from: null, to: "DISCUSSION", at: new Date().toISOString(), version: 0, hash: null }] };
      await this.write(s); return s;
    });
  }
  async change(action: "done" | "request" | "approve" | "reject", payload?: unknown): Promise<PlanningSnapshot> {
    return this.locked(async () => {
      const s = await this.read(); let to: State;
      if (action === "done") {
        if (s.state !== "DISCUSSION") reject();
        s.plan = createPlan(payload); to = "PLANNING";
      } else if (action === "request") {
        if (s.state !== "PLANNING" || payload !== undefined) reject(); to = "WAIT_APPROVAL";
      } else if (action === "approve") {
        if (s.state !== "WAIT_APPROVAL" || !s.plan) reject();
        const p = object(payload); keys(p, ["planId", "planVersion", "planHash"]);
        if (p.planId !== s.plan.planId || p.planVersion !== s.plan.version || p.planHash !== s.plan.planHash) reject();
        to = "READY_FOR_EXECUTION";
        s.approval = { planId: s.plan.planId, planVersion: s.plan.version, planHash: s.plan.planHash,
          approverId: this.identity(), approvedAt: new Date().toISOString() }; s.queue = queue(s.plan);
      } else if (action === "reject") {
        if ((s.state !== "WAIT_APPROVAL" && s.state !== "READY_FOR_EXECUTION") || !s.plan) reject();
        const { goal, steps, expectedFiles, acceptanceCriteria, risks } = s.plan;
        s.plan = createPlan(payload ?? { goal, steps, expectedFiles, acceptanceCriteria, risks }, s.plan); s.approval = null; s.queue = []; to = "PLANNING";
      } else reject();
      s.events.push({ from: s.state, to, at: s.approval?.approvedAt ?? new Date().toISOString(), version: s.plan!.version, hash: s.plan!.planHash });
      s.state = to; await this.write(s); return s;
    });
  }
}
