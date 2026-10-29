export type Command =
  | { name: "ban-luan"; topic: string }
  | { name: "xem" }
  | { name: "giao-tele" };

export type CommandContext = {
  source: "terminal" | "telegram";
};

export type CommandResult = {
  ok: boolean;
  code: "OK" | "INVALID_COMMAND" | "UNAUTHORIZED" | "NOT_FOUND" | "AI_UNAVAILABLE" | "TELEGRAM_UNAVAILABLE";
  message: string;
  runId?: string;
};

export interface CommandHandler {
  handle(command: Command, context: CommandContext): Promise<CommandResult>;
}

export class CommandSyntaxError extends Error {}

export function parseCommand(input: string): Command {
  const [name = "", ...rest] = input.trim().split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (name) {
    case "/ban-luan":
      if (!argument) throw new CommandSyntaxError("Cú pháp: /ban-luan <vấn đề>");
      return { name: "ban-luan", topic: argument };
    case "/xem":
    case "/giao-tele":
      if (argument) throw new CommandSyntaxError(`Lệnh ${name} không nhận tham số`);
      return { name: name.slice(1) as "xem" | "giao-tele" };
    default:
      throw new CommandSyntaxError("Lệnh không hợp lệ");
  }
}

export class CommandRouter {
  constructor(private readonly handler: CommandHandler) {}

  async route(input: string, context: CommandContext): Promise<CommandResult> {
    let command: Command;
    try {
      command = parseCommand(input);
    } catch (error) {
      if (error instanceof CommandSyntaxError) {
        return { ok: false, code: "INVALID_COMMAND", message: error.message };
      }
      throw error;
    }
    return this.handler.handle(command, context);
  }
}
