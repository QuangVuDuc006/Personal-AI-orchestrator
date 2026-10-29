import { userInfo } from "node:os";
import { PlanningService } from "./planning.js";
import { ArtifactStore, resolveArtifactRoot } from "./artifacts.js";
import { CommandRouter } from "./commands.js";
import type { CommandResult } from "./commands.js";
import { CodexDiscussionAgent, DisabledTelegramSender, DiscussionService } from "./discussion.js";

const ERROR_MESSAGES: Record<Exclude<CommandResult["code"], "OK">, string> = {
  INVALID_COMMAND: "Invalid command. Use /ban-luan with stdin, /xem or /giao-tele",
  UNAUTHORIZED: "Sender is not authorized",
  NOT_FOUND: "No discussion artifact found",
  AI_UNAVAILABLE: "Discussion recorded; AI execution is disabled in P1",
  TELEGRAM_UNAVAILABLE: "Telegram transport is unavailable",
};

try {
  const args = process.argv.slice(2);
  const p2Commands = ["/planning-start", "/done", "/plan", "/status", "/request-approval", "/ok", "/no"];
  if (p2Commands.includes(args[0] ?? "")) {
    if (args.length !== 1) throw new Error("Invalid arguments");
    let payload: unknown;
    if (["/done", "/ok", "/no"].includes(args[0]!)) {
      if (process.stdin.isTTY) throw new Error("Stdin required");
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 262144) throw new Error("Input too large");
      }
      if (input.trim()) payload = JSON.parse(input);
    }
    const service = new PlanningService(process.env.WORKSPACE_ROOT?.trim() || process.cwd(),
      process.env.PLANNING_HMAC_KEY ?? "", new Set((process.env.PLANNING_APPROVERS ?? "").split(",").map(s => s.trim()).filter(Boolean)),
      () => userInfo().username);
    const command = args[0];
    const snapshot = command === "/planning-start" ? await service.start() :
      command === "/plan" || command === "/status" ? await service.inspect() :
      await service.change(command === "/done" ? "done" : command === "/ok" ? "approve" : command === "/no" ? "reject" : "request", payload);
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    let input = args.join(" ");
    if (args[0] === "/ban-luan") {
      if (args.length !== 1 || process.stdin.isTTY) throw new Error("Stdin is required");
      let topic = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        topic += chunk;
        if (Buffer.byteLength(topic) > 262144) throw new Error("Input too large");
      }
      input = `/ban-luan ${topic}`;
    }
    const workspaceRoot = process.env.WORKSPACE_ROOT?.trim() || process.cwd();
    const artifactRoot = resolveArtifactRoot(workspaceRoot, process.env.ARTIFACTS_DIR);
    const service = new DiscussionService(
      new ArtifactStore(artifactRoot),
      new CodexDiscussionAgent(),
      new DisabledTelegramSender(),
    );
    const result = await new CommandRouter(service).route(input, { source: "terminal" });

    if (result.ok) console.log(result.message);
    else console.error(result.code === "OK" ? "Operation failed safely" : ERROR_MESSAGES[result.code]);
    process.exitCode = result.ok ? 0 : 1;
  }
} catch {
  console.error("Operation failed safely");
  process.exitCode = 1;
}
