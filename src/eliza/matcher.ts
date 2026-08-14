import type { ElizaRule, PatternMatchResult } from "./patterns.ts";
import { reflectPronouns } from "./reflection.ts";

export class ElizaMatcher {
  private rules: ElizaRule[];
  private responseIndexMap: Map<string, number> = new Map();

  constructor(rules: ElizaRule[]) {
    this.rules = rules;
  }

  public updateRules(rules: ElizaRule[]): void {
    this.rules = rules;
  }

  /**
   * Normalizes input text for pattern matching.
   */
  public normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s'*]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Converts a wildcard pattern like "i am *" or "* mother *" into a regular expression.
   */
  private patternToRegex(pattern: string): RegExp {
    const trimmed = pattern.trim().toLowerCase();
    if (trimmed === "*") {
      return /^(.*)$/i;
    }

    const escaped = trimmed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape regex special chars except *
      .replace(/\*/g, "(.*?)"); // Convert * into non-greedy or greedy capture group

    return new RegExp(`^${escaped}$`, "i");
  }

  /**
   * Finds the best matching ELIZA rule for the input text.
   */
  public match(text: string): PatternMatchResult | null {
    if (!text || text.trim() === "") {
      return null;
    }

    const normalized = this.normalize(text);
    const words = normalized.split(" ").filter(Boolean);

    let bestMatch: PatternMatchResult | null = null;
    let highestScore = -1;

    for (const rule of this.rules) {
      // 1. Keyword check
      let keywordScore = 0;
      const matchedKeywords: string[] = [];

      if (rule.keywords.length > 0) {
        for (const kw of rule.keywords) {
          const kwLower = kw.toLowerCase();
          // Check if keyword is present as full word or phrase
          if (normalized.includes(kwLower)) {
            matchedKeywords.push(kwLower);
            keywordScore += 10;
          }
        }

        // If rule has keywords but none matched, skip this rule
        if (matchedKeywords.length === 0) {
          continue;
        }
      }

      // 2. Pattern matching
      for (const pat of rule.patterns) {
        // Prepare normalized pattern for matching
        const patClean = pat.trim().toLowerCase();
        let regex: RegExp;

        if (patClean.startsWith("*") && patClean.endsWith("*") && patClean.length > 2) {
          // * keyword *
          const core = patClean.substring(1, patClean.length - 1).trim();
          regex = new RegExp(`(?:^|\\b)${core.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|$)`, "i");
        } else {
          regex = this.patternToRegex(patClean);
        }

        const match = normalized.match(regex);
        if (match) {
          const captures: string[] = [];
          if (match.length > 1) {
            for (let i = 1; i < match.length; i++) {
              const cap = (match[i] || "").trim();
              if (cap) captures.push(cap);
            }
          }

          // Total score combines rule priority, keyword matches, and specificity
          const patternScore = rule.priority * 10 + keywordScore + (patClean !== "*" ? 5 : 0);

          if (patternScore > highestScore) {
            highestScore = patternScore;

            // Reflect captured words
            const reflectedCaptures = captures.map((c) => reflectPronouns(c));

            // Select response cycling through available responses
            const responses = rule.responses.length > 0 ? rule.responses : ["Tell me more."];
            const currentIdx = this.responseIndexMap.get(rule.id) ?? 0;
            let responseTemplate = responses[currentIdx % responses.length]!;
            this.responseIndexMap.set(rule.id, currentIdx + 1);

            // Interpolate captures {0}, {1}, etc.
            let finalResponse = responseTemplate;
            for (let i = 0; i < reflectedCaptures.length; i++) {
              finalResponse = finalResponse.replaceAll(`{${i}}`, reflectedCaptures[i]!);
            }

            bestMatch = {
              ruleId: rule.id,
              pattern: pat,
              matchedKeywords,
              captures,
              reflectedCaptures,
              response: finalResponse,
              priority: rule.priority,
            };
          }
          break; // Matched a pattern in this rule, move to next rule
        }
      }
    }

    return bestMatch;
  }
}
