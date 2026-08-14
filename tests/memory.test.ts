import { describe, expect, test } from "bun:test";
import { BotDatabase } from "../src/db/database.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MemoryRetriever } from "../src/memory/retrieval.ts";

describe("Memory Subsystem", () => {
  test("creates and retrieves memories", () => {
    const db = new BotDatabase(":memory:");
    const store = new MemoryStore(db);

    const mem = store.addMemory({
      type: "project",
      content: "User is building a Bun CLI chatbot inspired by ELIZA.",
      confidence: 0.95,
      importance: 0.9,
      tags: ["bun", "chatbot", "eliza"],
    });

    expect(mem.id).toBeDefined();
    expect(mem.type).toBe("project");
    expect(mem.status).toBe("active");

    const fetched = store.getMemory(mem.id);
    expect(fetched?.content).toBe("User is building a Bun CLI chatbot inspired by ELIZA.");
    expect(fetched?.tags).toContain("bun");

    db.close();
  });

  test("handles deduplication gracefully", () => {
    const db = new BotDatabase(":memory:");
    const store = new MemoryStore(db);

    const mem1 = store.addMemory({
      type: "preference",
      content: "User prefers dark mode.",
      confidence: 0.9,
    });

    const mem2 = store.addMemory({
      type: "preference",
      content: "User prefers dark mode.",
      confidence: 0.9,
    });

    expect(mem1.id).toBe(mem2.id);
    expect(store.getActiveMemories().length).toBe(1);

    db.close();
  });

  test("handles contradictions and superseding links", () => {
    const db = new BotDatabase(":memory:");
    const store = new MemoryStore(db);

    const oldMem = store.addMemory({
      type: "project",
      content: "User project uses SQLite for storage.",
      confidence: 0.9,
    });

    expect(oldMem.status).toBe("active");

    const newMem = store.addMemory({
      type: "project",
      content: "User project uses PostgreSQL for storage.",
      confidence: 0.95,
    });

    const updatedOld = store.getMemory(oldMem.id);
    expect(updatedOld?.status).toBe("superseded");
    expect(updatedOld?.supersededBy).toBe(newMem.id);

    const activeList = store.getActiveMemories();
    expect(activeList.length).toBe(1);
    expect(activeList[0]?.content).toBe("User project uses PostgreSQL for storage.");

    db.close();
  });

  test("retrieves memories with relevance and TF-IDF scoring", () => {
    const db = new BotDatabase(":memory:");
    const store = new MemoryStore(db);
    const retriever = new MemoryRetriever(store);

    store.addMemory({
      type: "project",
      content: "Building an ELIZA chatbot in Bun using TypeScript.",
      confidence: 0.9,
      importance: 0.8,
    });

    store.addMemory({
      type: "fact",
      content: "User lives in San Francisco and enjoys hiking.",
      confidence: 0.8,
      importance: 0.5,
    });

    store.addMemory({
      type: "preference",
      content: "User loves TypeScript over plain JavaScript.",
      confidence: 0.95,
      importance: 0.7,
    });

    const results = retriever.search("What language am I using for my chatbot?", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.memory.content).toContain("chatbot");

    db.close();
  });

  test("allows deactivating memories via forget", () => {
    const db = new BotDatabase(":memory:");
    const store = new MemoryStore(db);

    const mem = store.addMemory({
      type: "fact",
      content: "Temporary fact",
    });

    expect(store.getActiveMemories().length).toBe(1);
    store.forgetMemory(mem.id);
    expect(store.getActiveMemories().length).toBe(0);

    const check = store.getMemory(mem.id);
    expect(check?.status).toBe("forgotten");

    db.close();
  });
});
