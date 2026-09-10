import type { ElizaMatcher } from "../eliza/matcher.ts";
import type { PatternMatchResult } from "../eliza/patterns.ts";
import type { ContextBuilder, BuiltContext } from "./context.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import type { ResponseEvaluator, EvaluationResult } from "./evaluator.ts";
import type { RetrievedMemory } from "../memory/retrieval.ts";
import type { RetrievedKnowledge } from "../knowledge/retrieval.ts";
import type { BotDatabase } from "../db/database.ts";

export type ResponseStrategyType = "eliza_rule" | "llm_contextual" | "eliza_fallback" | "generic_fallback";

export interface ResponseTrace {
  input: string;
  matchedRule: PatternMatchResult | null;
  retrievedMemories: RetrievedMemory[];
  retrievedKnowledge: RetrievedKnowledge[];
  responseStrategy: ResponseStrategyType;
  model: string;
  response: string;
  evaluation: EvaluationResult | null;
  timestamp: string;
}

export class ResponseEngine {
  private matcher: ElizaMatcher;
  private contextBuilder: ContextBuilder;
  private llm: OllamaClient;
  private evaluator: ResponseEvaluator;
  private db: BotDatabase;
  private lastTrace: ResponseTrace | null = null;

  constructor(
    matcher: ElizaMatcher,
    contextBuilder: ContextBuilder,
    llm: OllamaClient,
    evaluator: ResponseEvaluator,
    db: BotDatabase
  ) {
    this.matcher = matcher;
    this.contextBuilder = contextBuilder;
    this.llm = llm;
    this.evaluator = evaluator;
    this.db = db;
  }

  public getLLM(): OllamaClient {
    return this.llm;
  }

  public getLastTrace(): ResponseTrace | null {
    return this.lastTrace;
  }

  /**
   * Generates a response given the user input and session history.
   * Can stream LLM output tokens via onToken callback.
   */
  public async generateResponse(
    userMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    options: {
      onToken?: (token: string) => void;
      forceEliza?: boolean;
      stream?: boolean;
    } = {}
  ): Promise<{ response: string; strategy: ResponseStrategyType; trace: ResponseTrace }> {
    const isLlmUp = !options.forceEliza && (await this.llm.isAvailable());

    // 1. ELIZA pattern matching check
    const elizaMatch = this.matcher.match(userMessage);

    // 2. Build context
    const context = this.contextBuilder.build(userMessage, history);

    // Touch retrieved memories
    for (const rm of context.retrievedMemories) {
      this.touchMemory(rm.memory.id);
    }

    let responseText = "";
    let strategy: ResponseStrategyType = "eliza_rule";
    let modelName = "eliza-deterministic";

    // Decision logic:
    // If LLM is available AND (no high priority ELIZA match, OR user asks about facts/memories/projects/knowledge), use LLM!
    const isQuestionOrComplex =
      userMessage.includes("?") ||
      userMessage.toLowerCase().startsWith("what") ||
      userMessage.toLowerCase().startsWith("how") ||
      userMessage.toLowerCase().startsWith("why") ||
      context.retrievedMemories.length > 0 ||
      context.retrievedKnowledge.length > 0 ||
      !elizaMatch ||
      elizaMatch.priority < 12;

    if (isLlmUp && isQuestionOrComplex) {
      strategy = "llm_contextual";
      try {
        const genRes = await this.llm.chat({
          messages: context.chatMessages,
          stream: options.stream ?? true,
          onToken: options.onToken,
        });
        responseText = genRes.content.trim();
        modelName = genRes.model;
      } catch (err: any) {
        console.warn(`[llm] Generation failed, falling back to ELIZA: ${err?.message || err}`);
        strategy = "eliza_fallback";
      }
    }

    // Fallback to ELIZA rule or generic fallback if no LLM response produced
    if (!responseText) {
      if (elizaMatch) {
        responseText = elizaMatch.response;
        strategy = strategy === "eliza_fallback" ? "eliza_fallback" : "eliza_rule";
      } else {
        responseText = "Please go on. Tell me more about what you are thinking.";
        strategy = "generic_fallback";
      }

      // If streaming was expected, output full text via onToken
      if (options.onToken) {
        options.onToken(responseText);
      }
    }

    // 3. Response Evaluation
    const evaluation = await this.evaluator.evaluate(userMessage, responseText, context, strategy);

    const trace: ResponseTrace = {
      input: userMessage,
      matchedRule: elizaMatch,
      retrievedMemories: context.retrievedMemories,
      retrievedKnowledge: context.retrievedKnowledge,
      responseStrategy: strategy,
      model: modelName,
      response: responseText,
      evaluation,
      timestamp: new Date().toISOString(),
    };

    this.lastTrace = trace;

    return {
      response: responseText,
      strategy,
      trace,
    };
  }

  private touchMemory(id: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET usage_count = usage_count + 1, last_used_at = $now WHERE id = $id`,
      { $now: now, $id: id }
    );
  }
}
