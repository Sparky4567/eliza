// Telegram channel adapter for ELIZA-AI.
// Ported from llama's src/telegram.js: Bot API long-polling with zero extra
// dependencies (global fetch only). Text-only — ELIZA has no STT/TTS pipeline
// (voice attachments get a polite notice, like the web server).
// All prompt handling reuses ConversationBot.handleChannelInput(), so Telegram
// chats get isolated per-chat sessions plus the same memory/knowledge/learning
// stack as the CLI.
import type { ConversationBot } from "../bot/conversation.ts";

export function splitTelegramMessage(text: string, maxLength = 4000): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLength) {
      if (current) parts.push(current);
      current = line;
      // Single gigantic line: hard-split it.
      while (current.length > maxLength) {
        parts.push(current.slice(0, maxLength));
        current = current.slice(maxLength);
      }
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
    caption?: string;
    voice?: { file_id: string };
    audio?: { file_id: string };
    document?: { mime_type?: string; file_id?: string };
  };
}

export class TelegramBotRunner {
  private token: string;
  private bot: ConversationBot;
  private baseUrl: string;
  private running = false;
  private lastUpdateId = 0;
  /** Bot @username as reported by getMe() after a successful start(). */
  public botUsername: string | null = null;

  constructor(opts: { token: string; bot: ConversationBot }) {
    this.token = opts.token;
    this.bot = opts.bot;
    this.baseUrl = `https://api.telegram.org/bot${opts.token}`;
  }

  private async apiCall(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const url = `${this.baseUrl}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000),
      });
      return await res.json();
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) {
      await this.apiCall("sendMessage", { chat_id: chatId, text: chunk });
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) return;
    const chatId = update.message.chat.id;
    const msgText = (update.message.text || update.message.caption || "").trim();

    const voiceObj =
      update.message.voice || update.message.audio || update.message.document?.mime_type?.startsWith("audio")
        ? update.message.document
        : null;
    if (voiceObj && !msgText) {
      await this.sendMessage(chatId, "🎙 Voice messages aren't supported in ELIZA text mode — please send text.");
      return;
    }
    if (!msgText) return;

    try {
      const { response } = await this.bot.handleChannelInput("telegram", String(chatId), msgText);
      await this.sendMessage(chatId, response);
    } catch (err: any) {
      await this.sendMessage(chatId, `⚠️ Error: ${err?.message || err}`);
    }
  }

  async start(): Promise<boolean> {
    if (!this.token) return false;
    const me = await this.apiCall("getMe");
    if (!me.ok) {
      console.log(`⚠️ Telegram connection failed: ${me.description || me.error || "unknown error"}`);
      return false;
    }
    console.log(`✈️ Telegram Bot active (@${me.result.username}) — polling for updates…`);
    this.botUsername = me.result.username ?? null;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const res = await this.apiCall("getUpdates", {
            offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
            timeout: 20,
          });
          if (res.ok && Array.isArray(res.result)) {
            for (const update of res.result as TelegramUpdate[]) {
              this.lastUpdateId = update.update_id;
              await this.handleUpdate(update);
            }
          }
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/** Resolve the bot token from explicit arg → config → env (llama-compatible). */
export function resolveTelegramToken(explicit = "", configToken = ""): string {
  return (
    (explicit || "").trim() ||
    (configToken || "").trim() ||
    (process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim()
  );
}

/**
 * Start the Telegram bridge if a token is available (or --telegram was passed).
 * Mirrors llama's startAllTelegramBots() but ELIZA is single-persona, so one runner.
 */
export async function startTelegramBridge(opts: {
  bot: ConversationBot;
  token?: string;
  configToken?: string;
  force?: boolean;
}): Promise<TelegramBotRunner | null> {
  const token = resolveTelegramToken(opts.token, opts.configToken);
  if (!token) {
    if (opts.force) {
      console.log("✈️ Telegram Bridge: --telegram passed but no token found. Set TELEGRAM_TOKEN env var.");
    } else {
      console.log("✈️ Telegram Bridge: Disabled (no token — set TELEGRAM_TOKEN or use --telegram-token <token>).");
    }
    return null;
  }
  const runner = new TelegramBotRunner({ token, bot: opts.bot });
  const ok = await runner.start();
  return ok ? runner : null;
}
