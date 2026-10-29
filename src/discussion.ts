import type { ThreadOptions } from "@openai/codex-sdk";
import type { ArtifactStore } from "./artifacts.js";
import type { Command, CommandContext, CommandHandler, CommandResult } from "./commands.js";

export interface DiscussionAgent {
  discuss(prompt: string): Promise<string>;
}

export interface TelegramSender {
  send(text: string): Promise<void>;
}

export const CODEX_DISCUSSION_OPTIONS: Readonly<ThreadOptions> = Object.freeze({
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
});

export class CodexDiscussionAgent implements DiscussionAgent {
  async discuss(_prompt: string): Promise<never> {
    // Read-only sandboxing does not prove that shell execution is impossible.
    throw new Error("Codex discussion execution is disabled in P1");
  }
}

export class DisabledTelegramSender implements TelegramSender {
  async send(_text: string): Promise<never> {
    throw new Error("Telegram transport is not configured in P1");
  }
}

export class DiscussionService implements CommandHandler {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly agent: DiscussionAgent,
    private readonly telegram: TelegramSender,
  ) {}

  async handle(command: Command, context: CommandContext): Promise<CommandResult> {
    switch (command.name) {
      case "ban-luan": {
        const artifact = await this.artifacts.createDiscussion(command.topic, context);
        let response: string;
        try {
          response = await this.agent.discuss(command.topic);
        } catch {
          await this.artifacts.appendResult(artifact.runId, "BLOCKED");
          return {
            ok: false,
            code: "AI_UNAVAILABLE",
            message: "Đã lưu yêu cầu nhưng không chạy AI vì chưa có sandbox cấm shell đã được kiểm chứng",
            runId: artifact.runId,
          };
        }
        await this.artifacts.appendResult(artifact.runId, "DISCUSSION_READY", response);
        return { ok: true, code: "OK", message: "Đã ghi nhận phản hồi thảo luận", runId: artifact.runId };
      }
      case "xem": {
        const artifact = await this.artifacts.latest();
        return artifact
          ? { ok: true, code: "OK", message: artifact.content, runId: artifact.runId }
          : { ok: false, code: "NOT_FOUND", message: "Chưa có artifact thảo luận" };
      }
      case "giao-tele": {
        const artifact = await this.artifacts.latest();
        if (!artifact) return { ok: false, code: "NOT_FOUND", message: "Chưa có artifact thảo luận" };
        try {
          await this.telegram.send(artifact.content);
          return { ok: true, code: "OK", message: "Đã gửi artifact sang Telegram", runId: artifact.runId };
        } catch {
          return {
            ok: false,
            code: "TELEGRAM_UNAVAILABLE",
            message: "Telegram transport chưa được cấu hình",
            runId: artifact.runId,
          };
        }
      }
    }
  }
}
