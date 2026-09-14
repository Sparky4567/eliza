import { describe, expect, test } from "bun:test";
import { createBot } from "../src/index.ts";

function offlineBot() {
  return createBot({
    dbPath: ":memory:",
    ollama: { enabled: false, host: "http://localhost:11434", model: "", timeoutMs: 1000, stream: false },
  });
}

function enabledButUnreachableBot() {
  // Ollama "in use" by config (enabled + model selected) but no server running.
  // Use an unroutable port so isAvailable() is always false.
  return createBot({
    dbPath: ":memory:",
    ollama: { enabled: true, host: "http://127.0.0.1:1", model: "test-model", timeoutMs: 800, stream: false },
  });
}

describe("Smart writing (Ollama-gated co-authoring)", () => {
  test("help is advertised and available offline", async () => {
    const bot = offlineBot();
    const res = await bot.handleInput("/smart-writing help");
    expect(res.isCommand).toBe(true);
    expect(res.response).toContain("Smart Writing");
    expect(res.response).toContain("/smart-writing save");
  });

  test("aliases route to the same handler", async () => {
    const bot = offlineBot();
    for (const cmd of ["/smart-write help", "/write help", "/story help"]) {
      const res = await bot.handleInput(cmd);
      expect(res.isCommand).toBe(true);
      expect(res.response).toContain("Smart Writing");
    }
  });

  test("start/continue/improve are gated when Ollama is disabled", async () => {
    const bot = offlineBot();
    const start = await bot.handleInput("/smart-writing start Once upon a time...");
    expect(start.response).toMatch(/Ollama/i);

    const cont = await bot.handleInput("/smart-writing continue");
    expect(cont.response).toMatch(/Ollama/i);

    const imp = await bot.handleInput("/smart-writing improve make it darker");
    expect(imp.response).toMatch(/Ollama/i);

    expect(bot.getWriting().isActive()).toBe(false);
  });

  test("full draft → save → list → links flow with memory linking (no LLM server needed)", async () => {
    const bot = enabledButUnreachableBot();

    const start = await bot.handleInput("/smart-writing start The Lighthouse: Mara kept the light burning through the storm.");
    expect(start.response).toContain("Smart-writing session started");
    expect(bot.getWriting().isActive()).toBe(true);

    const add = await bot.handleInput("/smart-writing add She heard a knock at the iron door. The sea was angry and black.");
    expect(add.response).toContain("Added");

    // Seed a related memory so the save forms at least one association.
    await bot.handleInput("/remember Mara is the lighthouse keeper in my story.");

    const save = await bot.handleInput("/smart-writing save The Lighthouse");
    expect(save.response).toContain("Saved story");
    expect(save.response).toContain("Knowledge:");
    expect(save.response).toMatch(/association/i);

    const list = await bot.handleInput("/smart-writing list");
    expect(list.response).toContain("Lighthouse");

    // Extract the saved story id and inspect its link graph.
    const idMatch = list.response.match(/\[(mem_[^\]]+)\]/);
    expect(idMatch).not.toBeNull();
    const storyId0: string = idMatch![1] as string;
    const links = await bot.handleInput(`/smart-writing links ${storyId0}`);
    expect(links.response).toMatch(/Associations|No associations/);

    // memory_links table really has rows for this story.
    const storyId: string = idMatch![1] as string;
    const stored = bot.getWriting().getLinks(storyId);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored[0]?.sourceId).toBe(storyId);
  });

  test("continue reports offline clearly when Ollama unreachable (never hangs)", async () => {
    const bot = enabledButUnreachableBot();
    await bot.handleInput("/smart-writing start A quiet village woke under snow.");
    const cont = await bot.handleInput("/smart-writing continue");
    expect(cont.response).toMatch(/Ollama|failed|unreachable|timed out/i);
  });

  test("session show/status/done lifecycle works offline-safe", async () => {
    const bot = enabledButUnreachableBot();
    await bot.handleInput("/smart-writing start Chapter One: the road was long.");
    const show = await bot.handleInput("/smart-writing show");
    expect(show.response).toContain("road was long");
    const status = await bot.handleInput("/smart-writing status");
    expect(status.response).toContain("ACTIVE");
    const done = await bot.handleInput("/smart-writing done");
    expect(done.response).toMatch(/closed/i);
    expect(bot.getWriting().isActive()).toBe(false);
  });

  test("plain story text while active is kept even when Ollama is unreachable (web/CLI parity)", async () => {
    const bot = enabledButUnreachableBot();
    await bot.handleInput("/smart-writing start Mara kept the light burning.");
    // Same path the web UI takes for non-command input (REST /api/chat and WS).
    const turn = await bot.handleInput("She heard a knock.\nThe sea was angry and black.");
    expect(turn.isCommand).toBe(false);
    expect(turn.response).toContain("Added");
    expect(turn.response).toMatch(/saved in the draft/i);
    expect(bot.getWriting().getDraft()).toContain("angry and black");
  });

  test("/help advertises smart-writing", async () => {
    const bot = offlineBot();
    const help = await bot.handleInput("/help");
    expect(help.response).toContain("/smart-writing");
  });
});
