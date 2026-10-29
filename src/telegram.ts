import type { CommandResult } from "./commands.js";
import { CommandRouter } from "./commands.js";

export class TelegramConfigError extends Error {}

export function parseTelegramAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) throw new TelegramConfigError("TELEGRAM_ALLOWED_USER_IDS is required");
  const ids = raw.split(",").map((value) => value.trim());
  if (ids.some((id) => !/^[1-9]\d{0,15}$/.test(id) || BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new TelegramConfigError("TELEGRAM_ALLOWED_USER_IDS is invalid");
  }
  return new Set(ids);
}

function normalizeTelegramUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return value;
  }
  return null;
}

export class TelegramAdapter {
  constructor(
    private readonly router: CommandRouter,
    private readonly allowedUserIds: ReadonlySet<string>,
  ) {}

  async handle(message: unknown): Promise<CommandResult> {
    const candidate = message as { from?: { id?: unknown }; text?: unknown };
    const userId = normalizeTelegramUserId(candidate?.from?.id);
    if (!userId || !this.allowedUserIds.has(userId)) {
      return { ok: false, code: "UNAUTHORIZED", message: "Telegram sender is not authorized" };
    }
    if (typeof candidate.text !== "string") {
      return { ok: false, code: "INVALID_COMMAND", message: "Telegram message must contain text" };
    }
    return this.router.route(candidate.text, { source: "telegram" });
  }
}

export function createTelegramAdapterFromEnv(
  router: CommandRouter,
  env: Readonly<Record<string, string | undefined>>,
): TelegramAdapter {
  return new TelegramAdapter(router, parseTelegramAllowlist(env.TELEGRAM_ALLOWED_USER_IDS));
}
