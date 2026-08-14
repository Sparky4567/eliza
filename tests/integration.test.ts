import { describe, expect, test } from "bun:test";
import { createBot } from "../src/index.ts";
import { BotDatabase } from "../src/db/database.ts";
import { ElizaRuleRegistry } from "../src/eliza/patterns.ts";
import { ElizaMatcher } from "../src/eliza/matcher.ts";
import { defaultConfig } from "../src/config.ts";

describe("Extended Integration and Edge Cases", () => {
  test("handles empty and whitespace-only inputs", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false },
    });

    const res1 = await bot.handleInput("");
    expect(res1.response).toContain("Please say something");

    const res2 = await bot.handleInput("   \n\t  ");
    expect(res2.response).toContain("Please say something");
  });

  test("handles long complex inputs without throwing", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false },
    });

    const longText = "I am feeling " + "very ".repeat(100) + "exhausted from debugging large distributed software systems.";
    const res = await bot.handleInput(longText);
    expect(res.response).toBeDefined();
    expect(res.response.length).toBeGreaterThan(0);
  });

  test("candidate rules life-cycle: propose -> list -> approve -> activate", async () => {
    const db = new BotDatabase(":memory:");
    const registry = new ElizaRuleRegistry(defaultConfig.rulesPath, db);
    const matcher = new ElizaMatcher(registry.getRules());

    // Initially no match for custom keyword 'compiler'
    const beforeMatch = matcher.match("I love writing a custom compiler");
    expect(beforeMatch?.ruleId).not.toBe("learned_compiler_rule");

    // Propose candidate rule
    const ruleId = registry.addCandidateRule({
      keywords: ["compiler"],
      patterns: ["* compiler *", "* compiler"],
      responses: ["Compilers transform code into lower-level representations. Tell me more about your compiler."],
      priority: 16,
    });

    // Check candidate is registered
    const allRules = registry.getAllRulesIncludingCandidates();
    const foundCandidate = allRules.find((r) => r.id === ruleId);
    expect(foundCandidate?.status).toBe("candidate");

    // Approve candidate rule
    const approved = registry.setRuleStatus(ruleId, "approved");
    expect(approved).toBe(true);

    matcher.updateRules(registry.getRules());

    // Verify active matching
    const afterMatch = matcher.match("I love writing a custom compiler");
    expect(afterMatch?.ruleId).toBe(ruleId);
    expect(afterMatch?.response).toContain("Compilers transform code");

    db.close();
  });

  test("knowledge base deep version history chain", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false },
    });

    // 1. Initial teach
    await bot.handleInput("/teach TypeScript: A superset of JavaScript with static typing.");
    const kn1 = await bot.handleInput("/knowledge TypeScript");
    expect(kn1.response).toContain("v1");

    // 2. Update knowledge
    await bot.handleInput("/teach TypeScript: TypeScript adds optional static types, interfaces, and generics to JavaScript.");
    const kn2 = await bot.handleInput("/knowledge TypeScript");
    expect(kn2.response).toContain("v2");
    expect(kn2.response).toContain("generics");
  });

  test("strategy statistics tracking across turns", async () => {
    const bot = createBot({
      dbPath: ":memory:",
      ollama: { enabled: false },
    });

    await bot.handleInput("Hello there");
    await bot.handleInput("I feel sad today");
    await bot.handleInput("Tell me more about my mother");

    const stats = await bot.handleInput("/stats");
    expect(stats.response).toContain("Strategy Performance");
    expect(stats.response).toContain("eliza_rule");
  });
});
