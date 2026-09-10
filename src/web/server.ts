// Web server for ELIZA-AI: Bun.serve + WebSocket turn loop + REST API.
// Mirrors zap's src/server.ts patterns (routes + /ws duplex), wired to
// ConversationBot. Text-only: eliza has no STT/TTS pipeline.
// WS protocol (JSON):
//   C→S: {type:'text',text} {type:'stop'}
//   S→C: ready | llm-token | llm-done | turn-end | interrupted | error
import index from "../../public/index.html";
import { defaultConfig } from "../config.ts";
import type { ConversationBot } from "../bot/conversation.ts";

export interface WebServerOptions {
  port?: number;
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

/**
 * Starts the web UI + API server for an existing bot instance.
 * Calls bot.init() (model auto-detection) before listening.
 */
export async function startWebServer(bot: ConversationBot, opts: WebServerOptions = {}) {
  await bot.init();
  const port = opts.port ?? defaultConfig.web.port;

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
