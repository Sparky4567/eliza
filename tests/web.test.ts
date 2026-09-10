import { describe, expect, test } from "bun:test";
import { createBot } from "../src/index.ts";
import { parseCliArgs } from "../src/index.ts";
import { startWebServer } from "../src/web/server.ts";

async function startTestServer() {
  const bot = createBot({
    dbPath: ":memory:",
    ollama: { enabled: false, host: "http://localhost:11434", model: "", timeoutMs: 1000, stream: false },
  });
  const server = await startWebServer(bot, { port: 0 });
  const base = `http://localhost:${server.port}`;
  return { server, base };
}

describe("Web server (--web, zap-style)", () => {
  test("parses --web and --port flags", () => {
    expect(parseCliArgs([])).toEqual({ web: false, port: undefined });
    expect(parseCliArgs(["--web"])).toEqual({ web: true, port: undefined });
    expect(parseCliArgs(["--web", "--port", "4000"])).toEqual({ web: true, port: 4000 });
    expect(parseCliArgs(["--web", "--port=4001"])).toEqual({ web: true, port: 4001 });
  });

  test("GET /api/health reports offline rules mode", async () => {
    const { server, base } = await startTestServer();
    try {
      const res = await fetch(`${base}/api/health`);
      expect(res.ok).toBe(true);
      const j = (await res.json()) as any;
      expect(j.ok).toBe(true);
      expect(j.ollama).toBe(false);
      expect(j.model).toBe("rules");
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/chat answers and routes slash commands", async () => {
    const { server, base } = await startTestServer();
    try {
      const chat = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello there" }),
      });
      expect(chat.ok).toBe(true);
      const chatJson = (await chat.json()) as any;
      expect(chatJson.isCommand).toBe(false);
      expect(chatJson.reply).toMatch(/Hello|Hi|Greetings/i);
      expect(chatJson.trace).toBeDefined();

      const cmd = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/help" }),
      });
      const cmdJson = (await cmd.json()) as any;
      expect(cmdJson.isCommand).toBe(true);
      expect(cmdJson.reply).toContain("ELIZA Bot Commands");

      const bad = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("GET /api/stats and POST /api/command expose CLI parity", async () => {
    const { server, base } = await startTestServer();
    try {
      const stats = await fetch(`${base}/api/stats`);
      expect(stats.ok).toBe(true);
      const statsJson = (await stats.json()) as any;
      expect(statsJson.sessions).toBeGreaterThanOrEqual(1);

      const cmd = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/stats" }),
      });
      const cmdJson = (await cmd.json()) as any;
      expect(cmdJson.output).toContain("Bot Statistics");

      const badCmd = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "not-a-command" }),
      });
      expect(badCmd.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("WebSocket streams tokens and ends the turn", async () => {
    const { server, base } = await startTestServer();
    try {
      const wsUrl = base.replace("http", "ws") + "/ws";
      const ws = new WebSocket(wsUrl);

      const events: any[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = (e) => reject(e);
      });
      // Wait for ready
      const ready = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ready timeout")), 5000);
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data));
          if (m.type === "ready") {
            clearTimeout(timer);
            resolve(m);
          }
        };
      });
      expect(ready.ok).toBe(true);

      const done = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("turn timeout")), 10000);
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data));
          events.push(m);
          if (m.type === "turn-end" || m.type === "error") {
            clearTimeout(timer);
            resolve(m);
          }
        };
      });
      ws.send(JSON.stringify({ type: "text", text: "Hello there" }));
      const end = await done;
      expect(end.type).toBe("turn-end");
      const tokens = events.filter((e) => e.type === "llm-token");
      expect(tokens.length).toBeGreaterThan(0);
      const llmDone = events.find((e) => e.type === "llm-done");
      expect(llmDone.text).toMatch(/Hello|Hi|Greetings/i);
      ws.close();
    } finally {
      server.stop(true);
    }
  });
});
