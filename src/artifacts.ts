import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { CommandContext } from "./commands.js";

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const ARTIFACT_DIRECTORY = "_bmad-output/orchestrator";
const SAFE_ERROR = "Artifact operation failed";

export type DiscussionArtifact = {
  runId: string;
  content: string;
};

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(comparisonPath(root), comparisonPath(candidate));
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

function hasUnsafeSegments(value: string): boolean {
  return value.includes("\0") || value.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function assertNoReparsePointsSync(target: string): void {
  const root = parse(target).root;
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error(SAFE_ERROR);
  }
}

async function assertNoReparsePoints(target: string): Promise<void> {
  const root = parse(target).root;
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(SAFE_ERROR);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function resolveArtifactRoot(workspaceRoot: string, configuredPath?: string): string {
  try {
    if (!workspaceRoot.trim() || !isAbsolute(workspaceRoot) || hasUnsafeSegments(workspaceRoot)) {
      throw new Error(SAFE_ERROR);
    }

    const workspace = resolve(workspaceRoot);
    assertNoReparsePointsSync(workspace);
    const workspaceEntry = lstatSync(workspace, { throwIfNoEntry: false });
    if (!workspaceEntry?.isDirectory() || comparisonPath(realpathSync(workspace)) !== comparisonPath(workspace)) {
      throw new Error(SAFE_ERROR);
    }

    const configured = configuredPath?.trim() || ARTIFACT_DIRECTORY;
    if (isAbsolute(configured) || hasUnsafeSegments(configured) || configured.replace(/\\/g, "/") !== ARTIFACT_DIRECTORY) {
      throw new Error(SAFE_ERROR);
    }

    const artifactRoot = join(workspace, ...ARTIFACT_DIRECTORY.split("/"));
    assertNoReparsePointsSync(artifactRoot);
    return artifactRoot;
  } catch {
    throw new Error("Artifact configuration is invalid");
  }
}

export class ArtifactStore {
  private readonly root: string;

  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly randomId: () => string = () => randomUUID().slice(0, 8),
  ) {
    if (!root.trim() || !isAbsolute(root) || hasUnsafeSegments(root)) {
      throw new Error("Artifact configuration is invalid");
    }
    this.root = resolve(root);
  }

  async createDiscussion(_topic: string, context: CommandContext): Promise<DiscussionArtifact> {
    try {
      const timestamp = this.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const runId = `${timestamp}-${this.randomId()}`;
      this.assertRunId(runId);

      await this.ensureRootForWrite();
      const directory = this.runDirectory(runId);
      await mkdir(directory, { recursive: false });
      await this.assertSafeDirectory(directory);

      const content = [
        "# Discussion",
        "",
        "Artifact-Type: system-generated",
        `Run-ID: ${runId}`,
        `Source: ${context.source}`,
        "Status: RECORDED",
        "Request-Storage: omitted-by-policy",
        "",
      ].join("\n");

      // shortcut: path checks reduce but cannot eliminate filesystem TOCTOU without handle-relative OS APIs.
      await writeFile(this.artifactPath(directory, "ban-luan.md"), content, { encoding: "utf8", flag: "wx" });
      await writeFile(
        this.artifactPath(directory, "events.jsonl"),
        `${JSON.stringify({ timestamp: this.now().toISOString(), run_id: runId, actor: context.source, event: "discussion.recorded", status: "RECORDED" })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return { runId, content };
    } catch {
      throw new Error(SAFE_ERROR);
    }
  }

  async appendResult(runId: string, status: "DISCUSSION_READY" | "BLOCKED", response?: string): Promise<void> {
    try {
      this.assertRunId(runId);
      await this.assertSafeDirectory(this.root);
      const directory = this.runDirectory(runId);
      await this.assertSafeDirectory(directory);
      const discussionPath = this.artifactPath(directory, "ban-luan.md");
      const eventsPath = this.artifactPath(directory, "events.jsonl");
      await this.assertSafeFile(discussionPath);
      await this.assertSafeFile(eventsPath);
      const content = await readFile(discussionPath, "utf8");
      const events = await readFile(eventsPath, "utf8");
      this.assertValidArtifact(runId, content, events);
      if (events.split("\n").length !== 2 || (status !== "DISCUSSION_READY" && status !== "BLOCKED")) {
        throw new Error(SAFE_ERROR);
      }
      const responsePolicy = response === undefined ? "" : "\nResponse-Storage: omitted-by-policy\n";
      await appendFile(discussionPath, `${responsePolicy}\nStatus: ${status}\n`, "utf8");
      await appendFile(
        eventsPath,
        `${JSON.stringify({ timestamp: this.now().toISOString(), run_id: runId, actor: "system", event: status === "BLOCKED" ? "discussion.blocked" : "discussion.ready", status })}\n`,
        "utf8",
      );
    } catch {
      throw new Error(SAFE_ERROR);
    }
  }

  async latest(): Promise<DiscussionArtifact | null> {
    try {
      try {
        await lstat(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      await this.assertSafeDirectory(this.root);

      const entries = await readdir(this.root, { withFileTypes: true });
      const artifacts: { runId: string; content: string; createdAt: number }[] = [];
      for (const entry of entries.filter((entry) => RUN_ID_PATTERN.test(entry.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(SAFE_ERROR);
        const runId = entry.name;
        const directory = this.runDirectory(runId);
        await this.assertSafeDirectory(directory);
        const discussionPath = this.artifactPath(directory, "ban-luan.md");
        const eventsPath = this.artifactPath(directory, "events.jsonl");
        await this.assertSafeFile(discussionPath);
        await this.assertSafeFile(eventsPath);
        const content = await readFile(discussionPath, "utf8");
        const events = await readFile(eventsPath, "utf8");
        const createdAt = this.assertValidArtifact(runId, content, events);
        artifacts.push({ runId, content, createdAt });
      }
      artifacts.sort((a, b) => b.createdAt - a.createdAt);
      const latest = artifacts[0];
      if (!latest) return null;
      if (artifacts[1]?.createdAt === latest.createdAt) throw new Error(SAFE_ERROR);
      return { runId: latest.runId, content: latest.content };
    } catch {
      throw new Error(SAFE_ERROR);
    }
  }

  private assertValidArtifact(runId: string, content: string, events: string): number {
    // Only the system-generated format may reach the CLI or Telegram.
    const match = new RegExp(
      `^# Discussion\n\nArtifact-Type: system-generated\nRun-ID: ${runId}\nSource: (terminal|telegram)\nStatus: RECORDED\nRequest-Storage: omitted-by-policy\n(?:` +
      `(?:\nResponse-Storage: omitted-by-policy\n)?\nStatus: (?:DISCUSSION_READY|BLOCKED)\n)?$`,
    ).exec(content);
    if (!match || match[0] !== content || !events.endsWith("\n")) throw new Error(SAFE_ERROR);

    const statuses = [...content.matchAll(/^Status: (RECORDED|DISCUSSION_READY|BLOCKED)$/gm)].map((status) => status[1]);
    const lines = events.slice(0, -1).split("\n");
    if (lines.length !== statuses.length) throw new Error(SAFE_ERROR);
    let createdAt = 0;
    for (const [index, line] of lines.entries()) {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || !("timestamp" in event) ||
          typeof event.timestamp !== "string" || new Date(event.timestamp).toISOString() !== event.timestamp) {
        throw new Error(SAFE_ERROR);
      }
      const status = statuses[index];
      const expected = {
        timestamp: event.timestamp,
        run_id: runId,
        actor: index === 0 ? match[1] : "system",
        event: index === 0 ? "discussion.recorded" : status === "BLOCKED" ? "discussion.blocked" : "discussion.ready",
        status,
      };
      if (line !== JSON.stringify(expected)) throw new Error(SAFE_ERROR);
      const timestamp = Date.parse(event.timestamp);
      if (index === 0) createdAt = timestamp;
    }
    return createdAt;
  }

  private assertRunId(runId: string): void {
    if (isAbsolute(runId) || hasUnsafeSegments(runId) || !RUN_ID_PATTERN.test(runId)) {
      throw new Error(SAFE_ERROR);
    }
  }

  private runDirectory(runId: string): string {
    this.assertRunId(runId);
    const directory = join(this.root, runId);
    if (!isContained(this.root, directory)) throw new Error(SAFE_ERROR);
    return directory;
  }

  private artifactPath(directory: string, name: "ban-luan.md" | "events.jsonl"): string {
    const path = join(directory, name);
    if (!isContained(this.root, path)) throw new Error(SAFE_ERROR);
    return path;
  }

  private async ensureRootForWrite(): Promise<void> {
    await assertNoReparsePoints(this.root);
    await mkdir(this.root, { recursive: true });
    await this.assertSafeDirectory(this.root);
  }

  private async assertSafeDirectory(path: string): Promise<void> {
    if (!isContained(this.root, path)) throw new Error(SAFE_ERROR);
    await assertNoReparsePoints(path);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(SAFE_ERROR);
    const canonicalRoot = await realpath(this.root);
    const canonicalPath = await realpath(path);
    if (!isContained(canonicalRoot, canonicalPath)) throw new Error(SAFE_ERROR);
  }

  private async assertSafeFile(path: string): Promise<void> {
    if (!isContained(this.root, path)) throw new Error(SAFE_ERROR);
    await assertNoReparsePoints(path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error(SAFE_ERROR);
    const canonicalRoot = await realpath(this.root);
    const canonicalPath = await realpath(path);
    if (!isContained(canonicalRoot, canonicalPath)) throw new Error(SAFE_ERROR);
  }
}
