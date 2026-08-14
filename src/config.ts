import path from "node:path";

export interface BotConfig {
  dbPath: string;
  rulesPath: string;
  ollama: {
    host: string;
    model: string;
    enabled: boolean;
    timeoutMs: number;
    stream: boolean;
  };
  learning: {
    autoExtraction: boolean;
    autoEvaluation: boolean;
    autoCandidateRules: boolean;
    minConfidence: number;
    maxRetrievedMemories: number;
    maxRetrievedKnowledge: number;
    maxContextTurns: number;
  };
}

const defaultDataDir = path.resolve(import.meta.dir, "../data");

export const defaultConfig: BotConfig = {
  dbPath: process.env.BOT_DB_PATH || path.resolve(defaultDataDir, "bot.db"),
  rulesPath: process.env.BOT_RULES_PATH || path.resolve(defaultDataDir, "rules.json"),
  ollama: {
    host: process.env.OLLAMA_HOST || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "",
    enabled: process.env.OLLAMA_ENABLED !== "false",
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || "10000", 10),
    stream: process.env.OLLAMA_STREAM !== "false",
  },
  learning: {
    autoExtraction: process.env.BOT_AUTO_EXTRACTION !== "false",
    autoEvaluation: process.env.BOT_AUTO_EVALUATION !== "false",
    autoCandidateRules: process.env.BOT_AUTO_RULES !== "false",
    minConfidence: 0.6,
    maxRetrievedMemories: 5,
    maxRetrievedKnowledge: 4,
    maxContextTurns: 10,
  },
};
