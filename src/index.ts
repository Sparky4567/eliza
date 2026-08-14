import { defaultConfig, type BotConfig } from "./config.ts";
import { BotDatabase } from "./db/database.ts";
import { ElizaRuleRegistry } from "./eliza/patterns.ts";
import { ElizaMatcher } from "./eliza/matcher.ts";
import { MemoryStore } from "./memory/store.ts";
import { MemoryRetriever } from "./memory/retrieval.ts";
import { KnowledgeStore } from "./knowledge/store.ts";
import { KnowledgeRetriever } from "./knowledge/retrieval.ts";
import { OllamaClient } from "./llm/ollama.ts";
import { ContextBuilder } from "./bot/context.ts";
import { ResponseEvaluator } from "./bot/evaluator.ts";
import { ResponseEngine } from "./bot/response.ts";
import { LearningPipeline } from "./knowledge/learning.ts";
import { ConversationBot } from "./bot/conversation.ts";

export function createBot(customConfig: Partial<BotConfig> = {}): ConversationBot {
  const config: BotConfig = {
    ...defaultConfig,
    ...customConfig,
    ollama: { ...defaultConfig.ollama, ...(customConfig.ollama || {}) },
    learning: { ...defaultConfig.learning, ...(customConfig.learning || {}) },
  };

  const db = new BotDatabase(config.dbPath);
  const ruleRegistry = new ElizaRuleRegistry(config.rulesPath, db);
  const matcher = new ElizaMatcher(ruleRegistry.getRules());
  const memoryStore = new MemoryStore(db);
  const memoryRetriever = new MemoryRetriever(memoryStore);
  const knowledgeStore = new KnowledgeStore(db);
  const knowledgeRetriever = new KnowledgeRetriever(knowledgeStore);
  const ollama = new OllamaClient(
    config.ollama.host,
    config.ollama.model,
    config.ollama.timeoutMs,
    config.ollama.enabled
  );
  const contextBuilder = new ContextBuilder(memoryRetriever, knowledgeRetriever);
  const evaluator = new ResponseEvaluator(db, ollama);
  const responseEngine = new ResponseEngine(matcher, contextBuilder, ollama, evaluator, db);
  const learningPipeline = new LearningPipeline(db, memoryStore, knowledgeStore, ruleRegistry, ollama);

  return new ConversationBot(
    db,
    ruleRegistry,
    matcher,
    memoryStore,
    knowledgeStore,
    memoryRetriever,
    knowledgeRetriever,
    responseEngine,
    learningPipeline,
    config
  );
}

// Entrypoint
if (import.meta.main) {
  const bot = createBot();
  await bot.startCLI();
}
