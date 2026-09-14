// WhatsApp channel adapter for ELIZA-AI.
// Ported from llama's src/whatsapp.js:
//   - WhatsAppBridgeServer: localhost HTTP server (Bun.serve) exposing
//     GET /health and POST /chat for the Baileys Node bridge.
//   - WhatsAppNodeBridgeProcess: spawns whatsapp_bridge/index.js (Baileys
//     socket, QR login) as a child process.
// Text-only — ELIZA has no STT/TTS, so audio_file payloads get a polite note
// instead of transcription. All turns reuse bot.handleChannelInput() with
// isolated per-contact sessions.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ConversationBot } from "../bot/conversation.ts";

export const DEFAULT_WHATSAPP_PORT = 8765;
export const DEFAULT_WHATSAPP_STATUS_PORT = 8766;

export function whatsappAuthDir(): string {
  return path.join(process.cwd(), "whatsapp_bridge", "auth");
}

export function resetWhatsAppAuth(): { success: boolean; message: string } {
  const authDir = whatsappAuthDir();
  if (fs.existsSync(authDir)) {
    for (const file of fs.readdirSync(authDir)) {
      try {
        fs.unlinkSync(path.join(authDir, file));
      } catch {
        /* noop */
      }
    }
    return { success: true, message: "Cleared stale WhatsApp auth keys. Re-scan QR code to reconnect." };
  }
  return { success: false, message: "whatsapp_bridge/auth directory not found." };
}

export async function requestWhatsAppPairing(
  phone: string,
  statusPort = DEFAULT_WHATSAPP_STATUS_PORT
): Promise<{ success: boolean; pairingCode?: string; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${statusPort}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = (await res.json()) as { ok?: boolean; pairingCode?: string; error?: string };
    if (data.ok && data.pairingCode) return { success: true, pairingCode: data.pairingCode };
    return { success: false, error: data.error || "Failed to request pairing code" };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export class WhatsAppNodeBridgeProcess {
  private proc: ChildProcess | null = null;
  constructor(private phone = "") {}

  start(): void {
    if (this.proc) return;
    const bridgeDir = path.join(process.cwd(), "whatsapp_bridge");
    const entrypoint = path.join(bridgeDir, "index.js");
    if (!fs.existsSync(entrypoint)) {
      console.error("⚠️ whatsapp_bridge/index.js missing — run `bun run whatsapp:install` first.");
      return;
    }
    const chatPort = Number(process.env.WHATSAPP_PORT ?? DEFAULT_WHATSAPP_PORT);
    try {
      this.proc = spawn("node", [entrypoint], {
        cwd: bridgeDir,
        env: {
          ...process.env,
          ELIZA_CHAT_URL: `http://127.0.0.1:${chatPort}/chat`,
          JARVIS_CHAT_URL: `http://127.0.0.1:${chatPort}/chat`,
          WHATSAPP_STATUS_PORT: String(process.env.WHATSAPP_STATUS_PORT ?? DEFAULT_WHATSAPP_STATUS_PORT),
          WHATSAPP_PHONE: this.phone,
        },
        stdio: "inherit",
      });
      console.log("📱 WhatsApp Baileys bridge process started.");
      console.log("=========================================================================");
      console.log(`📱 QR / Pairing view: http://127.0.0.1:${process.env.WHATSAPP_STATUS_PORT ?? DEFAULT_WHATSAPP_STATUS_PORT}/qr`);
      console.log("=========================================================================");
      this.proc.on("error", (err) => console.error("📱 WhatsApp bridge process error:", err.message));
      this.proc.on("exit", (code) => {
        this.proc = null;
        if (code !== 0 && code !== null) console.log(`📱 WhatsApp bridge exited with code ${code}.`);
      });
    } catch (err: any) {
      console.error("📱 Failed to launch WhatsApp bridge:", err?.message || err);
    }
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* noop */
      }
      this.proc = null;
      console.log("📱 WhatsApp bridge process stopped.");
    }
  }
}

export interface WhatsAppBridgeOptions {
  bot: ConversationBot;
  port?: number;
  statusPort?: number;
  phone?: string;
  /** Skip spawning the Baileys node process (tests / externally managed). */
  withoutNodeProcess?: boolean;
}

export class WhatsAppBridgeServer {
  private bot: ConversationBot;
  private port: number;
  private phone: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nodeProcess: WhatsAppNodeBridgeProcess | null;

  constructor(opts: WhatsAppBridgeOptions) {
    this.bot = opts.bot;
    this.port = opts.port ?? DEFAULT_WHATSAPP_PORT;
    this.phone = opts.phone ?? "";
    this.nodeProcess = opts.withoutNodeProcess ? null : new WhatsAppNodeBridgeProcess(this.phone);
  }

  async processPrompt(promptText: string, chatId: string): Promise<string> {
    const text = (promptText || "").trim();
    if (!text) return "No input provided.";
    try {
      const { response } = await this.bot.handleChannelInput("whatsapp", String(chatId || "unknown"), text);
      return response;
    } catch (err: any) {
      return `⚠️ Error: ${err?.message || err}`;
    }
  }

  start(): void {
    if (this.server) return;
    const bot = this.bot;
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true, status: "running" });
        }
        if (req.method === "POST" && url.pathname === "/chat") {
          let payload: { text?: string; chat_id?: string; audio_file?: string } = {};
          try {
            payload = (await req.json()) as typeof payload;
          } catch {
            return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
          }
          let text = String(payload.text || "").trim();
          const chatId = String(payload.chat_id || "unknown");
          if (payload.audio_file && !text) {
            text = "[Voice/audio message received but voice transcription is not enabled in ELIZA text mode]";
          }
          if (!text) {
            return Response.json({ ok: false, error: "text is required" }, { status: 400 });
          }
          try {
            const reply = await self.processPrompt(text, chatId);
            return Response.json({ ok: true, reply, transcribed_text: text, is_voice_input: false });
          } catch (err: any) {
            return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
          }
        }
        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      },
    });
    console.log(`📱 WhatsApp HTTP Bridge listening on http://127.0.0.1:${this.port}/chat`);
    void bot;
    this.nodeProcess?.start();
  }

  stop(): void {
    this.nodeProcess?.stop();
    if (this.server) {
      this.server.stop();
      this.server = null;
      console.log("📱 WhatsApp HTTP Bridge stopped.");
    }
  }

  get isRunning(): boolean {
    return this.server !== null;
  }
}
