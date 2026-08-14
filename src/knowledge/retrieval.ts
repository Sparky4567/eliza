import type { KnowledgeCategory, KnowledgeEntry } from "./models.ts";
import type { KnowledgeStore } from "./store.ts";

export interface RetrievedKnowledge {
  knowledge: KnowledgeEntry;
  score: number;
  matchedTokens: string[];
}

export class KnowledgeRetriever {
  private store: KnowledgeStore;

  constructor(store: KnowledgeStore) {
    this.store = store;
  }

  public search(query: string, limit: number = 4, category?: KnowledgeCategory): RetrievedKnowledge[] {
    const allKnowledge = this.store.listKnowledge({ status: "active", category });
    if (allKnowledge.length === 0 || !query || query.trim() === "") {
      return [];
    }

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const scoredList: RetrievedKnowledge[] = [];

    for (const item of allKnowledge) {
      const titleTokens = this.tokenize(item.title);
      const contentTokens = this.tokenize(item.content);
      const allTokens = [...titleTokens, ...contentTokens];

      let score = 0;
      const matchedTokens: string[] = [];

      for (const qToken of queryTokens) {
        // High boost for title match
        if (titleTokens.includes(qToken)) {
          score += 5;
          matchedTokens.push(qToken);
        } else if (contentTokens.includes(qToken)) {
          score += 1.5;
          matchedTokens.push(qToken);
        }
      }

      // Check for exact title match or substring
      if (item.title.toLowerCase().includes(query.toLowerCase().trim())) {
        score += 10;
      }

      if (score > 0) {
        // Boost by confidence
        score *= item.confidence;
        scoredList.push({
          knowledge: item,
          score,
          matchedTokens: Array.from(new Set(matchedTokens)),
        });
      }
    }

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
      "these", "those"
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));
  }
}
