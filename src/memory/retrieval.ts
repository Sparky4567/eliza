import type { Memory } from "./models.ts";
import type { MemoryStore } from "./store.ts";

export interface RetrievedMemory {
  memory: Memory;
  score: number;
  matchedTokens: string[];
}

export class MemoryRetriever {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Search active memories for relevance to the input text.
   */
  public search(query: string, limit: number = 5): RetrievedMemory[] {
    const activeMemories = this.store.getActiveMemories();
    if (activeMemories.length === 0 || !query || query.trim() === "") {
      return [];
    }

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    // Calculate document frequencies across all active memories
    const docFreq: Map<string, number> = new Map();
    const docTokensMap: Map<string, string[]> = new Map();

    for (const mem of activeMemories) {
      const docTokens = Array.from(new Set(this.tokenize(mem.content + " " + mem.tags.join(" "))));
      docTokensMap.set(mem.id, docTokens);
      for (const t of docTokens) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }

    const N = activeMemories.length;
    const scoredList: RetrievedMemory[] = [];

    for (const mem of activeMemories) {
      const docTokens = docTokensMap.get(mem.id) || [];
      let tfIdfScore = 0;
      const matchedTokens: string[] = [];

      for (const qToken of queryTokens) {
        if (docTokens.includes(qToken)) {
          matchedTokens.push(qToken);
          const df = docFreq.get(qToken) || 1;
          const idf = Math.log((N + 1) / df) + 1;
          tfIdfScore += idf;
        }
      }

      // If matched any token
      if (matchedTokens.length > 0) {
        // Boost by importance and confidence
        const importanceBoost = 1 + mem.importance * 0.5;
        const confidenceBoost = mem.confidence;
        // Boost for corrections and preferences
        const typeBoost = mem.type === "correction" ? 1.5 : mem.type === "project" ? 1.2 : 1.0;

        const finalScore = tfIdfScore * importanceBoost * confidenceBoost * typeBoost;

        scoredList.push({
          memory: mem,
          score: finalScore,
          matchedTokens,
        });
      }
    }

    // Sort descending by score
    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, limit);
  }

  public tokenize(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "by", "from", "up", "about", "into", "over", "after",
      "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
      "had", "do", "does", "did", "can", "could", "shall", "should", "will",
      "would", "it", "its", "what", "which", "who", "whom", "this", "that",
      "these", "those", "tell", "show", "me", "you", "i", "we", "they"
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));
  }
}
