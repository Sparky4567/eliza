import { describe, expect, test } from "bun:test";
import { BotDatabase } from "../src/db/database.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { ElizaRuleRegistry } from "../src/eliza/patterns.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import { LearningPipeline } from "../src/knowledge/learning.ts";

import { defaultConfig } from "../src/config.ts";

describe("Incremental Learning Pipeline", () => {
  test("extracts projects and preferences via heuristics", () => {
    const db = new BotDatabase(":memory:");
    const memoryStore = new MemoryStore(db);
    const knowledgeStore = new KnowledgeStore(db);
    const ruleRegistry = new ElizaRuleRegistry(defaultConfig.rulesPath, db);
    const llm = new OllamaClient("http://localhost:11434");
    const pipeline = new LearningPipeline(db, memoryStore, knowledgeStore, ruleRegistry, llm);

    const res1 = pipeline.extractHeuristic("I am building a Bun CLI chatbot with ELIZA rules.");
    expect(res1.memoriesCreated).toBe(1);

    const activeMems = memoryStore.getActiveMemories();
    expect(activeMems.length).toBe(1);
    expect(activeMems[0]?.type).toBe("project");
    expect(activeMems[0]?.content).toContain("Bun CLI chatbot");

    const res2 = pipeline.extractHeuristic("I prefer TypeScript for typed applications.");
    expect(res2.memoriesCreated).toBe(1);

    const prefs = memoryStore.listMemories({ type: "preference" });
    expect(prefs.length).toBe(1);
    expect(prefs[0]?.content).toContain("TypeScript");

    db.close();
  });

  test("detects explicit corrections via heuristics and links contradictions", () => {
    const db = new BotDatabase(":memory:");
    const memoryStore = new MemoryStore(db);
    const knowledgeStore = new KnowledgeStore(db);
    const ruleRegistry = new ElizaRuleRegistry(defaultConfig.rulesPath, db);
    const llm = new OllamaClient("http://localhost:11434");
    const pipeline = new LearningPipeline(db, memoryStore, knowledgeStore, ruleRegistry, llm);

    // Initial fact
    const initialMem = memoryStore.addMemory({
      type: "project",
      content: "User project uses SQLite for storage.",
    });

    expect(initialMem.status).toBe("active");

    // Correction
    const res = pipeline.extractHeuristic("Actually, I changed it. I'm using PostgreSQL now.");
    expect(res.correctionsHandled).toBe(1);

    const corrections = memoryStore.listMemories({ type: "correction" });
    expect(corrections.length).toBe(1);
    expect(corrections[0]?.content).toContain("PostgreSQL");

    db.close();
  });
});
