import { describe, expect, test } from "bun:test";
import { BotDatabase } from "../src/db/database.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.ts";

describe("Knowledge Base Subsystem", () => {
  test("creates knowledge entries and maintains provenance", () => {
    const db = new BotDatabase(":memory:");
    const store = new KnowledgeStore(db);

    const kn = store.addKnowledge({
      title: "Bun Runtime",
      content: "Bun is an all-in-one JavaScript runtime & toolkit designed for speed.",
      category: "technology",
      sourceType: "user",
      confidence: 0.95,
      changeReason: "Initial entry",
    });

    expect(kn.id).toBeDefined();
    expect(kn.title).toBe("Bun Runtime");
    expect(kn.version).toBe(1);
    expect(kn.status).toBe("active");

    const fetched = store.getKnowledge(kn.id);
    expect(fetched?.content).toContain("all-in-one JavaScript runtime");

    db.close();
  });

  test("manages versioning and previous version links", () => {
    const db = new BotDatabase(":memory:");
    const store = new KnowledgeStore(db);

    const v1 = store.addKnowledge({
      title: "SQLite",
      content: "SQLite is a C-language library that implements a small, fast, self-contained SQL database engine.",
      category: "programming",
      sourceType: "user",
      changeReason: "Initial definition",
    });

    expect(v1.version).toBe(1);

    const v2 = store.updateKnowledge(v1.id, {
      content: "SQLite is an embedded relational database engine. Bun includes built-in bun:sqlite module.",
      changeReason: "Added details about Bun integration",
    });

    expect(v2.version).toBe(2);
    expect(v2.previousVersionId).toBe(v1.id);
    expect(v2.status).toBe("active");

    const oldV1 = store.getKnowledge(v1.id);
    expect(oldV1?.status).toBe("deprecated");

    const history = store.getVersionHistory(v2.id);
    expect(history.length).toBe(2);
    expect(history[0]?.id).toBe(v2.id);
    expect(history[1]?.id).toBe(v1.id);

    db.close();
  });

  test("retrieves knowledge with relevance ranking", () => {
    const db = new BotDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const retriever = new KnowledgeRetriever(store);

    store.addKnowledge({
      title: "Bun Runtime",
      content: "Bun is an all-in-one JavaScript runtime with native TypeScript support.",
      category: "technology",
    });

    store.addKnowledge({
      title: "PostgreSQL",
      content: "PostgreSQL is a powerful, open source object-relational database system.",
      category: "programming",
    });

    const searchResults = retriever.search("Tell me about Bun and TypeScript");
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0]?.knowledge.title).toBe("Bun Runtime");

    db.close();
  });
});
