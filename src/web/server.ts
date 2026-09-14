// Web server for ELIZA-AI: Bun.serve + WebSocket turn loop + REST API.
// Mirrors zap's src/server.ts patterns (routes + /ws duplex), wired to
// ConversationBot. Text-only: eliza has no STT/TTS pipeline.
// WS protocol (JSON):
//   C→S: {type:'text',text} {type:'stop'}
//   S→C: ready | llm-token | llm-done | turn-end | interrupted | error
import index from "../../public/index.html";
import { defaultConfig } from "../config.ts";
import type { ConversationBot } from "../bot/conversation.ts";
import type { ChannelHandles } from "../index.ts";

export interface WebServerOptions {
  port?: number;
  /** Live Telegram/WhatsApp bridges (from startChannels). Same reference is
   *  mutated by POST /api/channels/telegram/start, so the UI can connect a
   *  bot token at runtime without restarting the server. */
  channels?: ChannelHandles;
}

type TurnToken = {
  cancelled: boolean;
};

type ConnState = {
  current: TurnToken | null;
};

function send(ws: any, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* closed */
  }
}

async function health(bot: ConversationBot): Promise<Record<string, unknown>> {
  const llm = bot.getLLM();
  const [isUp, available] = await Promise.all([
    llm.isAvailable().catch(() => false),
    llm.listModels().catch(() => [] as string[]),
  ]);
  return {
    ok: true,
    ollama: isUp,
    enabled: llm.isEnabled(),
    model: bot.getActiveModelName(),
    displayName: bot.getBotDisplayName(),
    availableModels: available,
  };
}

function cancelTurn(state: ConnState): void {
  if (state.current) {
    state.current.cancelled = true;
    state.current = null;
  }
}

async function runTurn(ws: any, bot: ConversationBot, state: ConnState, text: string): Promise<void> {
  // Barge-in semantics (like zap): a new turn cancels the previous one.
  // Note: OllamaClient has no AbortSignal, so cancellation is best-effort —
  // the stale turn's tokens are dropped and its result discarded.
  cancelTurn(state);
  const token: TurnToken = { cancelled: false };
  state.current = token;

  try {
    const { response, isCommand, trace } = await bot.handleInput(text, {
      stream: true,
      onToken: (t) => {
        if (!token.cancelled) {
          send(ws, { type: "llm-token", token: t });
        }
      },
    });
    if (token.cancelled || state.current !== token) {
      send(ws, { type: "interrupted" });
      return;
    }
    send(ws, { type: "llm-done", text: response, isCommand, trace });
    send(ws, { type: "turn-end", userText: text, isCommand });
  } catch (e: any) {
    if (token.cancelled) {
      send(ws, { type: "interrupted" });
    } else {
      console.error("[web turn]", e?.message ?? e);
      send(ws, { type: "error", message: String(e?.message ?? e) });
    }
  } finally {
    if (state.current === token) {
      state.current = null;
    }
  }
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Channels (Telegram / WhatsApp): status snapshot + bridge proxies so the
// browser UI can monitor pairing, show the WhatsApp QR, and send messages.
// ---------------------------------------------------------------------------

function channelSummary(bot: ConversationBot, channels?: ChannelHandles): Record<string, unknown> {
  const cfg = bot.getConfig();
  return {
    telegram: {
      configured: Boolean(cfg.telegram.token),
      running: Boolean(channels?.telegram?.isRunning),
      username: channels?.telegram?.botUsername ?? null,
    },
    whatsapp: {
      enabled: Boolean(channels?.whatsapp?.isRunning),
      running: Boolean(channels?.whatsapp?.isRunning),
      phone: cfg.whatsapp.phone || null,
      port: cfg.whatsapp.port,
      statusPort: cfg.whatsapp.statusPort,
    },
  };
}

/** Fetch the Baileys bridge status object (connection, QR image, …). */
async function fetchBridgeStatus(bot: ConversationBot): Promise<{ ok: boolean; status?: number; body: any }> {
  const statusPort = bot.getConfig().whatsapp.statusPort;
  try {
    const res = await fetch(`http://127.0.0.1:${statusPort}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    return { ok: false, body: { ok: false, error: `WhatsApp bridge unreachable on 127.0.0.1:${statusPort} (${e?.message ?? e})` } };
  }
}

/**
 * Starts the web UI + API server for an existing bot instance.
 * Calls bot.init() (model auto-detection) before listening.
 */
export async function startWebServer(bot: ConversationBot, opts: WebServerOptions = {}) {
  await bot.init();
  const port = opts.port ?? defaultConfig.web.port;
  const channels = opts.channels;

  const server = Bun.serve<ConnState>({
    port,
    routes: {
      "/": index,
      "/api/health": {
        GET: async () => Response.json(await health(bot)),
      },
      "/api/chat": {
        POST: async (req: Request) => {
          const body = await readJson(req);
          const message = String(body.message ?? "").trim().slice(0, 4000);
          if (!message) {
            return Response.json({ error: "empty message" }, { status: 400 });
          }
          try {
            const { response, isCommand, trace } = await bot.handleInput(message);
            return Response.json({ reply: response, isCommand, trace });
          } catch (e: any) {
            return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
          }
        },
      },
      "/api/command": {
        POST: async (req: Request) => {
          const body = await readJson(req);
          const command = String(body.command ?? "").trim().slice(0, 4000);
          if (!command.startsWith("/")) {
            return Response.json({ error: "command must start with '/'" }, { status: 400 });
          }
          try {
            const output = await bot.handleCommand(command);
            return Response.json({ output });
          } catch (e: any) {
            return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
          }
        },
      },
      "/api/stats": {
        GET: async () => Response.json(bot.getStats()),
      },
      "/api/trace": {
        GET: async () => {
          const trace = bot.getLastTrace();
          if (!trace) {
            return Response.json({ error: "no recent response trace available" }, { status: 404 });
          }
          return Response.json(trace);
        },
      },
      "/api/model": {
        GET: async () => Response.json(await health(bot)),
        POST: async (req: Request) => {
          const body = await readJson(req);
          const name = String(body.name ?? body.model ?? "").trim();
          if (!name) {
            return Response.json({ error: "missing model name (POST {\"name\": \"<model>\"})" }, { status: 400 });
          }
          bot.getLLM().setModel(name);
          return Response.json(await health(bot));
        },
      },
      "/api/memory": {
        GET: async (req: Request) => {
          const q = new URL(req.url).searchParams.get("q") ?? "";
          const output = await bot.handleCommand(q ? `/memory ${q}` : "/memory");
          return Response.json({ output });
        },
      },
      "/api/knowledge": {
        GET: async (req: Request) => {
          const q = new URL(req.url).searchParams.get("q") ?? "";
          const output = await bot.handleCommand(q ? `/knowledge ${q}` : "/knowledge");
          return Response.json({ output });
        },
      },
      "/api/writing": {
        GET: async (req: Request) => {
          const url = new URL(req.url);
          const action = url.searchParams.get("action") ?? "status";
          const arg = url.searchParams.get("q") ?? url.searchParams.get("arg") ?? "";
          const cmd =
            action === "list" ? `/smart-writing list ${arg}`.trim()
            : action === "show" ? `/smart-writing show`
            : action === "status" ? `/smart-writing status`
            : action === "links" ? `/smart-writing links ${arg}`.trim()
            : `/smart-writing status`;
          const output = await bot.handleCommand(cmd);
          const w = bot.getWriting();
          return Response.json({
            output,
            active: w.isActive(),
            title: w.getTitle(),
            draft: w.getDraft(),
          });
        },
        POST: async (req: Request) => {
          const body = await readJson(req);
          const action = String(body.action ?? "continue");
          const text = String(body.text ?? body.arg ?? "").slice(0, 8000);
          const allowed = new Set(["start", "add", "continue", "improve", "show", "status", "save", "list", "links", "done", "cancel"]);
          if (!allowed.has(action)) {
            return Response.json({ error: `unknown writing action '${action}'` }, { status: 400 });
          }
          try {
            const output = await bot.handleCommand(`/smart-writing ${action} ${text}`.trim());
            const w = bot.getWriting();
            return Response.json({ output, active: w.isActive(), title: w.getTitle(), draft: w.getDraft() });
          } catch (e: any) {
            return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
          }
        },
      },
      "/api/channels": {
        GET: async () => Response.json(channelSummary(bot, channels)),
      },
      "/api/channels/whatsapp/status": {
        GET: async () => {
          if (!channels?.whatsapp?.isRunning) {
            return Response.json(
              { ok: false, error: "WhatsApp bridge is not running (launch with --whatsapp or WHATSAPP_ENABLED=true)." },
              { status: 503 }
            );
          }
          const r = await fetchBridgeStatus(bot);
          if (!r.ok) return Response.json(r.body, { status: 502 });
          return Response.json({ ok: true, bridge: r.body });
        },
      },
      "/api/channels/whatsapp/send": {
        POST: async (req: Request) => {
          const body = await readJson(req);
          const to = String(body.to ?? body.jid ?? body.chat_id ?? "").trim();
          const text = String(body.text ?? "").trim().slice(0, 4000);
          if (!to || !text) {
            return Response.json({ error: "POST {\"to\": \"<jid>\", \"text\": \"<message>\"} required" }, { status: 400 });
          }
          if (!channels?.whatsapp?.isRunning) {
            return Response.json({ error: "WhatsApp bridge is not running." }, { status: 503 });
          }
          const statusPort = bot.getConfig().whatsapp.statusPort;
          try {
            const res = await fetch(`http://127.0.0.1:${statusPort}/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jid: to, text }),
              signal: AbortSignal.timeout(10000),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || (data as any).ok === false) {
              return Response.json({ error: String((data as any).error ?? `bridge HTTP ${res.status}`) }, { status: 502 });
            }
            return Response.json({ ok: true });
          } catch (e: any) {
            return Response.json({ error: `bridge send failed: ${e?.message ?? e}` }, { status: 502 });
          }
        },
      },
      "/api/channels/whatsapp/reset": {
        POST: async () => {
          const { resetWhatsAppAuth } = await import("../channels/whatsapp.ts");
          const r = resetWhatsAppAuth();
          if (!r.success) return Response.json({ error: r.message }, { status: 404 });
          return Response.json({ ok: true, message: r.message });
        },
      },
      "/api/channels/telegram/send": {
        POST: async (req: Request) => {
          const body = await readJson(req);
          const chatId = body.chat_id ?? body.chatId ?? body.to;
          const text = String(body.text ?? "").trim().slice(0, 4000);
          if ((chatId === undefined || chatId === "") || !text) {
            return Response.json({ error: "POST {\"chat_id\": \"<id>\", \"text\": \"<message>\"} required" }, { status: 400 });
          }
          if (!channels?.telegram?.isRunning) {
            return Response.json({ error: "Telegram bridge is not running (set TELEGRAM_TOKEN and restart, or POST a token to /api/channels/telegram/start)." }, { status: 503 });
          }
          try {
            await channels.telegram.sendMessage(chatId as number | string, text);
            return Response.json({ ok: true });
          } catch (e: any) {
            return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
          }
        },
      },
      "/api/channels/telegram/start": {
        POST: async (req: Request) => {
          if (!channels) {
            return Response.json({ error: "Channel registry not attached to this server." }, { status: 500 });
          }
          const body = await readJson(req);
          const token = String(body.token ?? "").trim() || bot.getConfig().telegram.token;
          if (!token) {
            return Response.json({ error: "No token: POST {\"token\": \"<bot-token>\"} or set TELEGRAM_TOKEN." }, { status: 400 });
          }
          const { TelegramBotRunner } = await import("../channels/telegram.ts");
          try {
            channels.telegram?.stop();
          } catch {
            /* noop */
          }
          const runner = new TelegramBotRunner({ token, bot });
          const ok = await runner.start();
          if (!ok) {
            return Response.json({ error: "Telegram rejected the token (getMe failed) — check the token and try again." }, { status: 502 });
          }
          channels.telegram = runner;
          return Response.json({ ok: true, running: true, username: runner.botUsername });
        },
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const state: ConnState = { current: null };
        if (server.upgrade(req, { data: state })) return;
        return new Response("websocket upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: any) {
        health(bot)
          .then((h) => send(ws, { type: "ready", ...h }))
          .catch(() => send(ws, { type: "ready", ok: false }));
      },
      message(ws: any, raw: string | Buffer) {
        const state = ws.data as ConnState;
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        switch (msg.type) {
          case "text": {
            const text = String(msg.text ?? msg.message ?? "").trim().slice(0, 4000);
            if (!text) break;
            void runTurn(ws, bot, state, text);
            break;
          }
          case "stop":
            cancelTurn(state);
            send(ws, { type: "interrupted" });
            break;
          default:
            break;
        }
      },
      close(ws: any) {
        try {
          cancelTurn(ws.data as ConnState);
        } catch {
          /* noop */
        }
      },
    },
  });

  console.log(`ELIZA-AI web UI listening on http://localhost:${server.port}`);
  console.log(`Model=${bot.getBotDisplayName()}`);
  return server;
}
