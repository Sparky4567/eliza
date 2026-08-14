import type { BotDatabase } from "../db/database.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import { EVALUATION_PROMPT } from "../llm/prompts.ts";
import type { BuiltContext } from "./context.ts";

export interface EvaluationResult {
  score: number;
  relevant: boolean;
  usedMemory: boolean;
  potentialHallucination: boolean;
  notes: string;
}

export class ResponseEvaluator {
  private db: BotDatabase;
  private llm: OllamaClient;

  constructor(db: BotDatabase, llm: OllamaClient) {
    this.db = db;
    this.llm = llm;
  }

  public async evaluate(
    userMessage: string,
    botResponse: string,
    context: BuiltContext,
    strategy: string
  ): Promise<EvaluationResult> {
    const isLlmUp = await this.llm.isAvailable();

    let evalResult: EvaluationResult;

    if (isLlmUp) {
      try {
        const prompt = `${EVALUATION_PROMPT}

Context:
${context.fullPromptText}

Bot Response:
${botResponse}`;

        const res = await this.llm.chat({
          messages: [{ role: "user", content: prompt }],
          format: "json",
          temperature: 0.1,
        });

        const parsed = JSON.parse(res.content);
        evalResult = {
          score: typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0.8,
          relevant: parsed.relevant !== false,
          usedMemory: Boolean(parsed.used_memory),
          potentialHallucination: Boolean(parsed.potential_hallucination),
          notes: parsed.notes || "Evaluated via LLM",
        };
      } catch (err) {
        evalResult = this.heuristicEvaluation(userMessage, botResponse, context);
      }
    } else {
      evalResult = this.heuristicEvaluation(userMessage, botResponse, context);
    }

    // Record strategy statistics
    this.recordStrategyStats(strategy, evalResult.score);

    return evalResult;
  }

  private heuristicEvaluation(
    userMessage: string,
    botResponse: string,
    context: BuiltContext
  ): EvaluationResult {
    let score = 0.75;
    const userWords = userMessage.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const respWords = botResponse.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

    // Check token overlap with user input
    const overlap = userWords.filter((w) => respWords.includes(w));
    if (overlap.length > 0) {
      score += 0.1;
    }

    // Check if memory was used
    let usedMemory = false;
    if (context.retrievedMemories.length > 0) {
      for (const m of context.retrievedMemories) {
        const memWords = m.memory.content.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const memOverlap = memWords.filter((w) => respWords.includes(w));
        if (memOverlap.length >= 2) {
          usedMemory = true;
          score += 0.1;
          break;
        }
      }
    }

    return {
      score: Math.min(1.0, score),
      relevant: true,
      usedMemory,
      potentialHallucination: false,
      notes: "Heuristic evaluation based on token overlap and response structure",
    };
  }

  private recordStrategyStats(strategy: string, score: number): void {
    const isSuccess = score >= 0.7 ? 1 : 0;
    const now = new Date().toISOString();

    const existing = this.db.get<{
      strategy: string;
      attempts: number;
      successes: number;
      total_score: number;
    }>("SELECT * FROM strategy_stats WHERE strategy = $strategy", { $strategy: strategy });

    if (existing) {
      this.db.run(
        `UPDATE strategy_stats SET
          attempts = attempts + 1,
          successes = successes + $succ,
          total_score = total_score + $score,
          updated_at = $now
         WHERE strategy = $strategy`,
        {
          $succ: isSuccess,
          $score: score,
          $now: now,
          $strategy: strategy,
        }
      );
    } else {
      this.db.run(
        `INSERT INTO strategy_stats (strategy, attempts, successes, total_score, updated_at)
         VALUES ($strategy, 1, $succ, $score, $now)`,
        {
          $strategy: strategy,
          $succ: isSuccess,
          $score: score,
          $now: now,
        }
      );
    }
  }
}
