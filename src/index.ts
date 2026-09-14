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
import { SmartWritingManager } from "./writing/smart-writing.ts";

export function createBot(customConfig: Partial<BotConfig> = {}): ConversationBot {
  const config: BotConfig = {
    ...defaultConfig,
    ...customConfig,
    ollama: { ...defaultConfig.ollama, ...(customConfig.ollama || {}) },
    learning: { ...defaultConfig.learning, ...(customConfig.learning || {}) },
    web: { ...defaultConfig.web, ...(customConfig.web || {}) },
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
  const writing = new SmartWritingManager(db, ollama, memoryStore, memoryRetriever, knowledgeStore, knowledgeRetriever);

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
    config,
    writing
  );
}

export interface CliOptions {
  web: boolean;
  port?: number;
}

/**
 * Parses CLI flags. Supports:
 *   bun run src/index.ts [--web] [--port 3000 | --port=3000]
 * Env fallback for the port: ELIZA_WEB_PORT / WEB_PORT / PORT (see config.ts).
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  let web = false;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--web") {
      web = true;
    } else if (arg === "--port" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) port = n;
    } else if (arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (Number.isFinite(n) && n > 0) port = n;
    }
  }

  return { web, port };
}

/** Entrypoint: CLI REPL by default, web UI + API with --web (like zap's server mode). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseCliArgs(argv);
  if (opts.web) {
    const port = opts.port ?? defaultConfig.web.port;
    const bot = createBot({ web: { port } });
    const { startWebServer } = await import("./web/server.ts");
    await startWebServer(bot, { port });
    return;
  }
  const bot = createBot();
  await bot.startCLI();
}

// Entrypoint
if (import.meta.main) {
  await main();
}
