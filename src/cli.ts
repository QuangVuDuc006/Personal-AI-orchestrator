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
  let input = args.join(" ");
  if (args[0] === "/ban-luan") {
    if (args.length !== 1 || process.stdin.isTTY) throw new Error("Stdin is required");
    let topic = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) topic += chunk;
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
} catch {
  console.error("Operation failed safely");
  process.exitCode = 1;
}
