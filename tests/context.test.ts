import { describe, expect, test } from "bun:test";
import { BotDatabase } from "../src/db/database.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MemoryRetriever } from "../src/memory/retrieval.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.ts";
import { ContextBuilder } from "../src/bot/context.ts";

describe("Context Builder", () => {
  test("constructs rich context including memories, knowledge, and history", () => {
    const db = new BotDatabase(":memory:");
    const memoryStore = new MemoryStore(db);
    const knowledgeStore = new KnowledgeStore(db);
    const memoryRetriever = new MemoryRetriever(memoryStore);
    const knowledgeRetriever = new KnowledgeRetriever(knowledgeStore);
    const builder = new ContextBuilder(memoryRetriever, knowledgeRetriever);

    memoryStore.addMemory({
      type: "project",
      content: "User is building an ELIZA chatbot.",
      confidence: 0.95,
      importance: 0.9,
    });

    knowledgeStore.addKnowledge({
      title: "ELIZA",
      content: "ELIZA is an early natural language processing computer program created from 1964 to 1966 at MIT by Joseph Weizenbaum.",
      category: "history",
    });

    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hello! How can I help you today?" },
    ];

    const context = builder.build("Tell me about ELIZA and my chatbot project", history);

    expect(context.systemPrompt).toContain("RELEVANT PERSISTENT MEMORIES");
    expect(context.systemPrompt).toContain("User is building an ELIZA chatbot.");
    expect(context.systemPrompt).toContain("RELEVANT KNOWLEDGE BASE");
    expect(context.systemPrompt).toContain("Joseph Weizenbaum");
    expect(context.chatMessages.length).toBe(4); // system, 2 history, 1 user

    db.close();
  });
});
