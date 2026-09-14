import { describe, expect, test } from "bun:test";
import { createBot, parseCliArgs, type ChannelHandles } from "../src/index.ts";
import { splitTelegramMessage, resolveTelegramToken, TelegramBotRunner } from "../src/channels/telegram.ts";
import { WhatsAppBridgeServer } from "../src/channels/whatsapp.ts";
import { startWebServer } from "../src/web/server.ts";

function offlineBot() {
  return createBot({
    dbPath: ":memory:",
    ollama: { enabled: false, host: "http://localhost:11434", model: "", timeoutMs: 1000, stream: false },
  });
}

describe("Telegram + WhatsApp channel support (llama port)", () => {
  test("CLI flags parse telegram/whatsapp options", () => {
    const opts = parseCliArgs(["--web", "--port", "3001", "--telegram", "--whatsapp", "--whatsapp-phone", "12345"]);
    expect(opts.web).toBe(true);
    expect(opts.port).toBe(3001);
    expect(opts.telegram).toBe(true);
    expect(opts.whatsapp).toBe(true);
    expect(opts.whatsappPhone).toBe("12345");

    const opts2 = parseCliArgs(["--telegram-token=ABC", "--no-telegram"]);
    expect(opts2.telegramToken).toBe("ABC");
    expect(opts2.noTelegram).toBe(true);
  });

  test("telegram token resolution prefers explicit > config > env", () => {
    expect(resolveTelegramToken("AAA", "BBB")).toBe("AAA");
    expect(resolveTelegramToken("", "BBB")).toBe("BBB");
    process.env.TELEGRAM_TOKEN = "ENVTOK";
    expect(resolveTelegramToken("", "")).toBe("ENVTOK");
    delete process.env.TELEGRAM_TOKEN;
  });

  test("telegram messages split at 4000 chars", () => {
    expect(splitTelegramMessage("hi")).toEqual(["hi"]);
    const long = "a".repeat(9000);
    const parts = splitTelegramMessage(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
  });

  test("channel inputs get isolated per-chat sessions + @ prefix compat", async () => {
    const bot = offlineBot();

    const r1 = await bot.handleChannelInput("telegram", "111", "Hello there");
    expect(r1.isCommand).toBe(false);
    expect(r1.response.length).toBeGreaterThan(0);

    // @help behaves like /help (llama compat)
    const help = await bot.handleChannelInput("telegram", "111", "@help");
    expect(help.isCommand).toBe(true);
    expect(help.response).toContain("ELIZA Bot Commands");

    // /remember via channel stores memory, visible to CLI search
    const rem = await bot.handleChannelInput("whatsapp", "999@s.whatsapp.net", "/remember Channel memory marker xyz123");
    expect(rem.response).toContain("Remembered");

    // Sessions isolated: telegram chat 111 vs 222
    await bot.handleChannelInput("telegram", "222", "Something completely different");
    const h111 = bot.getChannelHistory("telegram", "111");
    const h222 = bot.getChannelHistory("telegram", "222");
    expect(h111.length).toBeGreaterThan(0);
    expect(h222.length).toBeGreaterThan(0);
    expect(JSON.stringify(h111)).not.toBe(JSON.stringify(h222));

    // /clear only clears that channel session
    const before = bot.getChannelHistory("telegram", "111").length;
    expect(before).toBeGreaterThan(0);
    await bot.handleChannelInput("telegram", "111", "/clear");
    expect(bot.getChannelHistory("telegram", "111").length).toBe(0);
    expect(bot.getChannelHistory("telegram", "222").length).toBeGreaterThan(0);
  });

  test("telegram runner handles an update via stubbed API", async () => {
    const bot = offlineBot();
    const runner = new TelegramBotRunner({ token: "DUMMY", bot });
    const sent: Array<{ chat: unknown; text: string }> = [];
    (runner as any).apiCall = async (method: string, params: any) => {
      if (method === "sendMessage") {
        sent.push({ chat: params.chat_id, text: params.text });
        return { ok: true };
      }
      return { ok: true };
    };
    await runner.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: "Hello there" } });
    expect(sent.length).toBe(1);
    expect(String(sent[0]!.text).length).toBeGreaterThan(0);
  });

  test("whatsapp bridge /chat endpoint answers via bot", async () => {
    const bot = offlineBot();
    const server = new WhatsAppBridgeServer({ bot, port: 18765, withoutNodeProcess: true });
    server.start();
    try {
      const res = await fetch("http://127.0.0.1:18765/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello there", chat_id: "test@s.whatsapp.net" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; reply: string };
      expect(data.ok).toBe(true);
      expect(data.reply.length).toBeGreaterThan(0);

      const direct = await server.processPrompt("Hello there", "other@s.whatsapp.net");
      expect(direct.length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });
});

describe("Channels in the web UI (/api/channels)", () => {
  async function startWebWithChannels(channels?: ChannelHandles) {
    const bot = offlineBot();
    const server = await startWebServer(bot, { port: 0, channels });
    return { server, base: `http://localhost:${server.port}` };
  }

  test("GET /api/channels reports bridge summary without leaking tokens", async () => {
    const { server, base } = await startWebWithChannels();
    try {
      const res = await fetch(`${base}/api/channels`);
      expect(res.ok).toBe(true);
      const j = (await res.json()) as any;
      expect(j.telegram.running).toBe(false);
      expect(j.whatsapp.running).toBe(false);
      expect(JSON.stringify(j)).not.toContain("TEST-TOKEN");
    } finally {
      server.stop(true);
    }
  });

  test("send endpoints validate input and report stopped bridges", async () => {
    const { server, base } = await startWebWithChannels();
    try {
      const badTg = await fetch(`${base}/api/channels/telegram/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(badTg.status).toBe(400);

      const offTg = await fetch(`${base}/api/channels/telegram/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "1", text: "hi" }),
      });
      expect(offTg.status).toBe(503);

      const offWa = await fetch(`${base}/api/channels/whatsapp/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "1@s.whatsapp.net", text: "hi" }),
      });
      expect(offWa.status).toBe(503);

      const waStatus = await fetch(`${base}/api/channels/whatsapp/status`);
      expect(waStatus.status).toBe(503);
    } finally {
      server.stop(true);
    }
  });

  test("telegram/start rejects a missing token without network", async () => {
    const { server, base } = await startWebWithChannels({ telegram: null, whatsapp: null });
    try {
      const res = await fetch(`${base}/api/channels/telegram/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("telegram/send forwards through an attached running runner", async () => {
    const sent: Array<{ chat: unknown; text: string }> = [];
    const fakeRunner = {
      isRunning: true,
      botUsername: "testbot",
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chat: chatId, text });
      },
      stop: () => {},
    };
    const channels = { telegram: fakeRunner, whatsapp: null } as unknown as ChannelHandles;
    const { server, base } = await startWebWithChannels(channels);
    try {
      const summary = (await (await fetch(`${base}/api/channels`)).json()) as any;
      expect(summary.telegram.running).toBe(true);
      expect(summary.telegram.username).toBe("testbot");

      const res = await fetch(`${base}/api/channels/telegram/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "42", text: "hello from web" }),
      });
      expect(res.ok).toBe(true);
      expect(sent).toEqual([{ chat: "42", text: "hello from web" }]);
    } finally {
      server.stop(true);
    }
  });

  test("whatsapp/status proxies a 502 when the bridge node process is down", async () => {
    const fakeBridge = { isRunning: true, stop: () => {} };
    const channels = { telegram: null, whatsapp: fakeBridge } as unknown as ChannelHandles;
    const { server, base } = await startWebWithChannels(channels);
    try {
      // Nothing listens on the bridge status port in tests → proxy must fail cleanly.
      const res = await fetch(`${base}/api/channels/whatsapp/status`);
      expect(res.status).toBe(502);
      const j = (await res.json()) as any;
      expect(j.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
