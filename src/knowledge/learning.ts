import type { BotDatabase } from "../db/database.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { KnowledgeStore } from "./store.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import { MEMORY_EXTRACTION_PROMPT, CANDIDATE_RULE_PROMPT } from "../llm/prompts.ts";
import type { ElizaRuleRegistry } from "../eliza/patterns.ts";

export interface LearningResult {
  memoriesCreated: number;
  knowledgeCreated: number;
  correctionsHandled: number;
  rulesProposed: number;
  details: string[];
}

export class LearningPipeline {
  private db: BotDatabase;
  private memoryStore: MemoryStore;
  private knowledgeStore: KnowledgeStore;
  private ruleRegistry: ElizaRuleRegistry;
  private llm: OllamaClient;

  constructor(
    db: BotDatabase,
    memoryStore: MemoryStore,
    knowledgeStore: KnowledgeStore,
    ruleRegistry: ElizaRuleRegistry,
    llm: OllamaClient
  ) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.knowledgeStore = knowledgeStore;
    this.ruleRegistry = ruleRegistry;
    this.llm = llm;
  }

  /**
   * Fast deterministic heuristic extraction from user message.
   */
  public extractHeuristic(userMessage: string): LearningResult {
    const result: LearningResult = {
      memoriesCreated: 0,
      knowledgeCreated: 0,
      correctionsHandled: 0,
      rulesProposed: 0,
      details: [],
    };

    const text = userMessage.trim();
    const lower = text.toLowerCase();

    // 1. Detect explicit correction patterns:
    // "Actually, I changed it. I'm using X now" or "No, I meant X, not Y" or "I switched from X to Y"
    const correctionMatch =
      lower.match(/(?:actually|no)[,\s]+(?:i changed it|i switched|i meant)\.?\s*(.+)/i) ||
      lower.match(/i (?:am using|use|switched to) (.+) now/i);

    if (correctionMatch && correctionMatch[1]) {
      const correctionDetail = text;
      const mem = this.memoryStore.addMemory({
        type: "correction",
        content: `User updated: ${correctionDetail}`,
        source: "explicit_correction_heuristic",
        confidence: 0.98,
        importance: 0.9,
        tags: ["correction", "update"],
      });
      result.correctionsHandled++;
      result.memoriesCreated++;
      result.details.push(`Created correction memory: ${mem.content}`);
      return result;
    }

    // 2. Detect project pattern: "I'm building X" / "I am working on X"
    const projectMatch = text.match(/i(?:'m| am) (?:building|working on|developing|creating)\s+(.+)/i);
    if (projectMatch && projectMatch[1]) {
      const proj = projectMatch[1].replace(/[.?!]+$/, "").trim();
      if (proj.length > 3) {
        const mem = this.memoryStore.addMemory({
          type: "project",
          content: `User is building ${proj}.`,
          source: "heuristic_extraction",
          confidence: 0.9,
          importance: 0.8,
          tags: ["project", "work"],
        });
        result.memoriesCreated++;
        result.details.push(`Created project memory: ${mem.content}`);
      }
    }

    // 3. Detect preference pattern: "I prefer X" / "I like to use X"
    const prefMatch = text.match(/i (?:prefer|love using|like to use|prefer to use)\s+(.+)/i);
    if (prefMatch && prefMatch[1]) {
      const pref = prefMatch[1].replace(/[.?!]+$/, "").trim();
      if (pref.length > 2) {
        const mem = this.memoryStore.addMemory({
          type: "preference",
          content: `User prefers ${pref}.`,
          source: "heuristic_extraction",
          confidence: 0.85,
          importance: 0.7,
          tags: ["preference"],
        });
        result.memoriesCreated++;
        result.details.push(`Created preference memory: ${mem.content}`);
      }
    }

    return result;
  }

  /**
   * Run LLM-powered extraction on conversation turn.
   */
  public async extractWithLLM(
    userMessage: string,
    assistantResponse: string,
    historyContext: string = ""
  ): Promise<LearningResult> {
    const result: LearningResult = {
      memoriesCreated: 0,
      knowledgeCreated: 0,
      correctionsHandled: 0,
      rulesProposed: 0,
      details: [],
    };

    // First run heuristic pass
    const heuristicRes = this.extractHeuristic(userMessage);
    result.memoriesCreated += heuristicRes.memoriesCreated;
    result.knowledgeCreated += heuristicRes.knowledgeCreated;
    result.correctionsHandled += heuristicRes.correctionsHandled;
    result.details.push(...heuristicRes.details);

    // If LLM is available, perform deep extraction
    const isLlmUp = await this.llm.isAvailable();
    if (!isLlmUp) {
      return result;
    }

    let rawContent: string;
    try {
      const prompt = `${MEMORY_EXTRACTION_PROMPT}

Recent Context:
${historyContext}

User Message:
${userMessage}

Assistant Response:
${assistantResponse}`;

      const response = await this.llm.chat({
        messages: [{ role: "user", content: prompt }],
        format: "json",
        temperature: 0.1,
      });
      rawContent = response.content;
    } catch (err: any) {
      // Background learning must never crash or spam a stack trace.
      // Timeouts/aborts are expected with slow local models — heuristics above already ran.
      if (/timed out|abort/i.test(err?.message || "")) {
        console.warn(`[learning] Skipping LLM extraction (${err.message.split(".")[0]}). Heuristic result kept.`);
      } else {
        console.warn(`[learning] LLM extraction skipped: ${err?.message || err}`);
      }
      return result;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent!);
    } catch {
      // Malformed JSON from model — ignore, heuristics already applied.
      return result;
    }

    try {
      // Process memories
      if (Array.isArray(parsed.memories)) {
        for (const item of parsed.memories) {
          if (item && typeof item.content === "string" && item.content.length > 5) {
            const conf = typeof item.confidence === "number" ? item.confidence : 0.8;
            if (conf >= 0.6) {
              const mem = this.memoryStore.addMemory({
                type: item.type || "fact",
                content: item.content.trim(),
                source: "llm_extraction",
                confidence: conf,
                importance: typeof item.importance === "number" ? item.importance : 0.6,
                tags: Array.isArray(item.tags) ? item.tags : [],
              });
              result.memoriesCreated++;
              result.details.push(`LLM memory extracted: [${mem.type}] ${mem.content}`);
            }
          }
        }
      }

      // Process knowledge items
      if (Array.isArray(parsed.knowledge)) {
        for (const item of parsed.knowledge) {
          if (item && typeof item.title === "string" && typeof item.content === "string") {
            const conf = typeof item.confidence === "number" ? item.confidence : 0.8;
            if (conf >= 0.65) {
              const kn = this.knowledgeStore.addKnowledge({
                title: item.title.trim(),
                content: item.content.trim(),
                category: item.category || "concept",
                sourceType: "user",
                confidence: conf,
                changeReason: "Extracted from conversation",
              });
              result.knowledgeCreated++;
              result.details.push(`Knowledge added: ${kn.title}`);
            }
          }
        }
      }

      // Process explicit corrections
      if (Array.isArray(parsed.corrections) && parsed.corrections.length > 0) {
        for (const corr of parsed.corrections) {
          if (corr.target && corr.newValue) {
            const mem = this.memoryStore.addMemory({
              type: "correction",
              content: `Correction: ${corr.target} replaced by ${corr.newValue}.`,
              source: "llm_correction_extraction",
              confidence: 0.95,
              importance: 0.9,
              tags: ["correction", corr.target],
            });
            result.correctionsHandled++;
            result.memoriesCreated++;
            result.details.push(`Correction saved: ${mem.content}`);
          }
        }
      }
    } catch (err: any) {
      // Storage failures etc. — never crash the chat loop.
      console.warn(`[learning] Failed to store extraction: ${err?.message || err}`);
    }

    return result;
  }

  /**
   * Optionally checks if a candidate ELIZA pattern rule should be proposed.
   */
  public async proposeCandidateRule(userMessage: string, historyContext: string): Promise<string | null> {
    const isLlmUp = await this.llm.isAvailable();
    if (!isLlmUp) return null;

    try {
      const prompt = `${CANDIDATE_RULE_PROMPT}

History:
${historyContext}

Latest User Input:
${userMessage}`;

      const res = await this.llm.chat({
        messages: [{ role: "user", content: prompt }],
        format: "json",
        temperature: 0.2,
      });

      const parsed = JSON.parse(res.content);
      if (Array.isArray(parsed.proposals) && parsed.proposals.length > 0) {
        const p = parsed.proposals[0];
        if (p && Array.isArray(p.keywords) && Array.isArray(p.responses) && p.keywords.length > 0) {
          const ruleId = this.ruleRegistry.addCandidateRule({
            keywords: p.keywords,
            patterns: Array.isArray(p.patterns) && p.patterns.length > 0 ? p.patterns : [`* ${p.keywords[0]} *`],
            responses: p.responses,
            priority: typeof p.priority === "number" ? p.priority : 7,
            sourceReason: p.reason || "Discovered by candidate rule proposal model",
          });
          return ruleId;
        }
      }
    } catch {
      // Ignore candidate rule proposal failures
    }
    return null;
  }
}
