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
    telegram: { ...defaultConfig.telegram, ...(customConfig.telegram || {}) },
    whatsapp: { ...defaultConfig.whatsapp, ...(customConfig.whatsapp || {}) },
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
  telegram: boolean;
  noTelegram: boolean;
  telegramToken?: string;
  whatsapp: boolean;
  whatsappPhone?: string;
  whatsappPort?: number;
}

/**
 * Parses CLI flags. Supports:
 *   bun run src/index.ts [--web] [--port 3000 | --port=3000]
 *     [--telegram] [--no-telegram] [--telegram-token <token> | --telegram-token=<token>]
 *     [--whatsapp] [--whatsapp-phone <phone>] [--whatsapp-port <port>]
 * Env fallback for the port: ELIZA_WEB_PORT / WEB_PORT / PORT (see config.ts).
 * Telegram token fallback: TELEGRAM_TOKEN / TELEGRAM_BOT_TOKEN (see config.ts).
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  let web = false;
  let port: number | undefined;
  let telegram = false;
  let noTelegram = false;
  let telegramToken: string | undefined;
  let whatsapp = false;
  let whatsappPhone: string | undefined;
  let whatsappPort: number | undefined;

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
    } else if (arg === "--telegram") {
      telegram = true;
    } else if (arg === "--no-telegram") {
      noTelegram = true;
    } else if (arg === "--telegram-token" && argv[i + 1]) {
      telegramToken = argv[++i];
    } else if (arg.startsWith("--telegram-token=")) {
      telegramToken = arg.slice("--telegram-token=".length);
    } else if (arg === "--whatsapp") {
      whatsapp = true;
    } else if (arg === "--whatsapp-phone" && argv[i + 1]) {
      whatsappPhone = argv[++i];
    } else if (arg.startsWith("--whatsapp-phone=")) {
      whatsappPhone = arg.slice("--whatsapp-phone=".length);
    } else if (arg === "--whatsapp-port" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) whatsappPort = n;
    } else if (arg.startsWith("--whatsapp-port=")) {
      const n = Number(arg.slice("--whatsapp-port=".length));
      if (Number.isFinite(n) && n > 0) whatsappPort = n;
    }
  }

  return { web, port, telegram, noTelegram, telegramToken, whatsapp, whatsappPhone, whatsappPort };
}

export interface ChannelHandles {
  telegram: import("./channels/telegram.ts").TelegramBotRunner | null;
  whatsapp: import("./channels/whatsapp.ts").WhatsAppBridgeServer | null;
}

/** Start Telegram/WhatsApp bridges (llama-style) for an existing bot instance. */
export async function startChannels(bot: ConversationBot, opts: CliOptions): Promise<ChannelHandles> {
  const { startTelegramBridge } = await import("./channels/telegram.ts");
  const { WhatsAppBridgeServer } = await import("./channels/whatsapp.ts");
  const cfg = bot.getConfig();

  // Telegram: start when a token exists (flag/config/env) unless --no-telegram.
  // --telegram forces the attempt so a missing token prints a hint.
  let telegram: ChannelHandles["telegram"] = null;
  if (!opts.noTelegram) {
    const token = (opts.telegramToken || "").trim() || cfg.telegram.token;
    if (token || opts.telegram) {
      telegram = await startTelegramBridge({
        bot,
        token: opts.telegramToken,
        configToken: cfg.telegram.token,
        force: opts.telegram,
      });
    } else {
      console.log("✈️ Telegram Bridge: Disabled (no token — set TELEGRAM_TOKEN or use --telegram-token <token>).");
    }
  } else {
    console.log("✈️ Telegram Bridge: Disabled via --no-telegram.");
  }

  // WhatsApp: start on --whatsapp flag or WHATSAPP_ENABLED=true (llama parity).
  let whatsapp: ChannelHandles["whatsapp"] = null;
  if (opts.whatsapp || cfg.whatsapp.enabled) {
    const phone = (opts.whatsappPhone || "").trim() || cfg.whatsapp.phone;
    const port = opts.whatsappPort ?? cfg.whatsapp.port;
    whatsapp = new WhatsAppBridgeServer({ bot, port, statusPort: cfg.whatsapp.statusPort, phone });
    whatsapp.start();
  } else {
    console.log("📱 WhatsApp Bridge: Disabled (launch with --whatsapp or WHATSAPP_ENABLED=true).");
  }

  const stop = () => {
    try {
      telegram?.stop();
    } catch {
      /* noop */
    }
    try {
      whatsapp?.stop();
    } catch {
      /* noop */
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return { telegram, whatsapp };
}

/** Entrypoint: CLI REPL by default, web UI + API with --web (like zap's server mode). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseCliArgs(argv);
  if (opts.web) {
    const port = opts.port ?? defaultConfig.web.port;
    const bot = createBot({ web: { port } });
    await bot.init();
    const channels = await startChannels(bot, opts);
    const { startWebServer } = await import("./web/server.ts");
    await startWebServer(bot, { port, channels });
    return;
  }
  const bot = createBot();
  await bot.init();
  await startChannels(bot, opts);
  await bot.startCLI();
}

// Entrypoint
if (import.meta.main) {
  await main();
}
