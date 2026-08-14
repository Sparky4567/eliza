import { describe, expect, test } from "bun:test";
import { createBot } from "../src/index.ts";

describe("Conversation Bot Integration & Acceptance Scenarios", () => {
  test("handles interactive turns and slash commands", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false, host: "http://localhost:11434", model: "gemma2", timeoutMs: 1000, stream: false },
    });

    // 1. Slash command /help
    const helpRes = await bot.handleInput("/help");
    expect(helpRes.isCommand).toBe(true);
    expect(helpRes.response).toContain("ELIZA Bot Commands");

    // 2. Normal ELIZA conversation turn
    const turn1 = await bot.handleInput("Hello there");
    expect(turn1.isCommand).toBe(false);
    expect(turn1.response).toMatch(/Hello|Hi|Greetings/i);

    // 3. /remember command
    const rememberRes = await bot.handleInput("/remember User works on TypeScript CLI applications.");
    expect(rememberRes.isCommand).toBe(true);
    expect(rememberRes.response).toContain("Remembered:");

    // 4. /teach command
    const teachRes = await bot.handleInput("/teach TypeScript: A strongly typed programming language that builds on JavaScript.");
    expect(teachRes.isCommand).toBe(true);
    expect(teachRes.response).toContain("Learned knowledge entry:");

    // 5. /stats command
    const statsRes = await bot.handleInput("/stats");
    expect(statsRes.isCommand).toBe(true);
    expect(statsRes.response).toContain("Active Memories:");
    expect(statsRes.response).toContain("Active Knowledge:");

    // 6. /trace command
    const traceRes = await bot.handleInput("/trace");
    expect(traceRes.isCommand).toBe(true);
    expect(traceRes.response).toContain("Response Trace");

    // 7. /model command
    const modelRes = await bot.handleInput("/model llama3.2");
    expect(modelRes.isCommand).toBe(true);
    expect(modelRes.response).toContain("Active Ollama model switched to (ELIZA:llama3.2)");
  });

  test("implements Section 30 Acceptance Test (Persistent Learning & Correction Superseding)", async () => {
    // Stage 1: Bot remembers initial project setup
    const bot1 = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false, host: "http://localhost:11434", model: "gemma2", timeoutMs: 1000, stream: false },
    });

    // User introduces initial project setup
    await bot1.handleInput("I am building a Bun CLI chatbot.");
    await bot1.handleInput("/remember The project uses SQLite for storage.");

    const memoryCheck1 = await bot1.handleInput("/memory SQLite");
    expect(memoryCheck1.response).toContain("SQLite");

    // Stage 2: User provides explicit correction
    await bot1.handleInput("/correct Actually, I changed it. The project uses PostgreSQL for storage now.");

    // Stage 3: Check /trace and /memory to verify superseding link
    const traceOutput = await bot1.handleInput("/trace");
    expect(traceOutput.response).toContain("Response Trace");

    const memoryList = await bot1.handleInput("/memory");
    expect(memoryList.response).toContain("PostgreSQL");
  });

  test("represents model name as (ELIZA:model_name)", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: true, model: "mistral:latest" },
    });

    expect(bot.getBotDisplayName()).toBe("(ELIZA:mistral:latest)");
    expect(bot.getActiveModelName()).toBe("mistral:latest");
  });
});
