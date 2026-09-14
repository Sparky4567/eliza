import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { BotDatabase } from "../db/database.ts";
import type { ElizaRuleRegistry } from "../eliza/patterns.ts";
import type { ElizaMatcher } from "../eliza/matcher.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { KnowledgeStore } from "../knowledge/store.ts";
import type { MemoryRetriever } from "../memory/retrieval.ts";
import type { KnowledgeRetriever } from "../knowledge/retrieval.ts";
import type { ResponseEngine, ResponseTrace } from "./response.ts";
import type { LearningPipeline } from "../knowledge/learning.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import type { BotConfig } from "../config.ts";
import { SmartWritingManager } from "../writing/smart-writing.ts";

export class ConversationBot {
  private db: BotDatabase;
  private ruleRegistry: ElizaRuleRegistry;
  private matcher: ElizaMatcher;
  private memoryStore: MemoryStore;
  private knowledgeStore: KnowledgeStore;
  private memoryRetriever: MemoryRetriever;
  private knowledgeRetriever: KnowledgeRetriever;
  private responseEngine: ResponseEngine;
  private learningPipeline: LearningPipeline;
  private writing: SmartWritingManager;
  private config: BotConfig;
  private sessionId: string;
  private isRunning: boolean = false;

  constructor(
    db: BotDatabase,
    ruleRegistry: ElizaRuleRegistry,
    matcher: ElizaMatcher,
    memoryStore: MemoryStore,
    knowledgeStore: KnowledgeStore,
    memoryRetriever: MemoryRetriever,
    knowledgeRetriever: KnowledgeRetriever,
    responseEngine: ResponseEngine,
    learningPipeline: LearningPipeline,
    config: BotConfig,
    writing: SmartWritingManager
  ) {
    this.db = db;
    this.ruleRegistry = ruleRegistry;
    this.matcher = matcher;
    this.memoryStore = memoryStore;
    this.knowledgeStore = knowledgeStore;
    this.memoryRetriever = memoryRetriever;
    this.knowledgeRetriever = knowledgeRetriever;
    this.responseEngine = responseEngine;
    this.learningPipeline = learningPipeline;
    this.writing = writing;
    this.config = config;
    this.sessionId = this.createSession();
  }

  /**
   * Initializes the bot, auto-detecting the first available model from Ollama if not explicitly provided.
   */
  public async init(): Promise<void> {
    const llm = this.responseEngine.getLLM();
    if (!this.config.ollama.model && llm.isEnabled()) {
      await llm.autoDetectDefaultModel();
    }
  }

  public getActiveModelName(): string {
    const llm = this.responseEngine.getLLM();
    const isLlmOnline = llm.isEnabled();
    const model = llm.getModel();
    if (!isLlmOnline || !model) {
      return "rules";
    }
    return model;
  }

  public getBotDisplayName(): string {
    return `(ELIZA:${this.getActiveModelName()})`;
  }

  /** Direct access to the underlying LLM client (used by the web server for health/model info). */
  public getLLM(): OllamaClient {
    return this.responseEngine.getLLM();
  }

  /** Database/learning statistics snapshot (used by CLI /stats and the web server). */
  public getStats(): ReturnType<BotDatabase["getStats"]> {
    return this.db.getStats();
  }

  /** Merged runtime config (used by channel bridges for tokens/ports). */
  public getConfig(): BotConfig {
    return this.config;
  }

  /** Full execution trace of the most recent turn (used by CLI /trace and the web server). */
  public getLastTrace(): ResponseTrace | null {
    return this.responseEngine.getLastTrace();
  }

  /** Smart-writing co-authoring manager (Ollama-gated). */
  public getWriting(): SmartWritingManager {
    return this.writing;
  }

  private createSession(): string {
    const id = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, created_at, updated_at, title) VALUES ($id, $created_at, $updated_at, $title)`,
      {
        $id: id,
        $created_at: now,
        $updated_at: now,
        $title: "Interactive CLI Session",
      }
    );
    return id;
  }

  public getSessionHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    const rows = this.db.query<{ role: "user" | "assistant"; content: string }>(
      "SELECT role, content FROM messages WHERE session_id = $sessionId ORDER BY created_at ASC",
      { $sessionId: this.sessionId }
    );
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Remote channels (Telegram / WhatsApp): per-chat isolated sessions.
  // Each (channel, chatId) pair gets its own row in `sessions` so CLI history
  // stays separate from remote contacts, mirroring llama's remoteSession().
  // ---------------------------------------------------------------------------

  /** Deterministic session id for a remote contact, e.g. `telegram_12345`. */
  public static channelSessionId(channel: string, chatId: string): string {
    const safeChat = String(chatId).replace(/[^A-Za-z0-9_@.\-]/g, "_").slice(0, 128) || "unknown";
    return `${channel}_${safeChat}`;
  }

  private getOrCreateChannelSession(channel: string, chatId: string): string {
    const id = ConversationBot.channelSessionId(channel, chatId);
    const existing = this.db.get<{ id: string }>("SELECT id FROM sessions WHERE id = $id", { $id: id });
    if (!existing) {
      const now = new Date().toISOString();
      this.db.run(
        `INSERT INTO sessions (id, created_at, updated_at, title) VALUES ($id, $created_at, $updated_at, $title)`,
        { $id: id, $created_at: now, $updated_at: now, $title: `${channel} chat ${chatId}` }
      );
    } else {
      this.db.run(`UPDATE sessions SET updated_at = $now WHERE id = $id`, {
        $now: new Date().toISOString(),
        $id: id,
      });
    }
    return id;
  }

  public getChannelHistory(channel: string, chatId: string): Array<{ role: "user" | "assistant"; content: string }> {
    const sessionId = this.getOrCreateChannelSession(channel, chatId);
    return this.db.query<{ role: "user" | "assistant"; content: string }>(
      "SELECT role, content FROM messages WHERE session_id = $sessionId ORDER BY created_at ASC",
      { $sessionId: sessionId }
    );
  }

  private recordChannelMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    strategy?: string
  ): void {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, strategy, created_at, metadata)
       VALUES ($id, $session_id, $role, $content, $strategy, $created_at, NULL)`,
      { $id: id, $session_id: sessionId, $role: role, $content: content, $strategy: strategy || null, $created_at: now }
    );
    this.db.run(`UPDATE sessions SET updated_at = $now WHERE id = $id`, { $now: now, $id: sessionId });
  }

  /**
   * Process one remote turn (Telegram/WhatsApp). Uses an isolated per-chat
   * session, normalizes the llama-style "@cmd" prefix to "/cmd", and reuses
   * the same ResponseEngine + learning pipeline as the CLI.
   */
  public async handleChannelInput(
    channel: "telegram" | "whatsapp" | string,
    chatId: string,
    text: string,
    options: { onToken?: (token: string) => void; stream?: boolean } = {}
  ): Promise<{ response: string; isCommand: boolean; trace?: any }> {
    const trimmed = text.trim();
    const sessionId = this.getOrCreateChannelSession(channel, chatId);
    if (!trimmed) {
      return { response: "Please say something.", isCommand: false };
    }

    // llama compat: "@help" == "/help" (same length, same slice offsets downstream)
    const normalized = trimmed.startsWith("@") ? "/" + trimmed.slice(1) : trimmed;

    if (normalized.startsWith("/")) {
      const cmd = normalized.split(" ")[0]!.toLowerCase();
      if (cmd === "/clear") {
        this.db.run("DELETE FROM messages WHERE session_id = $sessionId", { $sessionId: sessionId });
        return { response: "Conversation context cleared. Started fresh session.", isCommand: true };
      }
      if (cmd === "/quit" || cmd === "/exit") {
        return { response: "Goodbye. (Remote sessions stay saved — send /clear to start fresh.)", isCommand: true };
      }
      const output = await this.handleCommand(normalized, options);
      return { response: output, isCommand: true };
    }

    if (this.writing.isActive()) {
      this.recordChannelMessage(sessionId, "user", trimmed);
      const appendNote = this.writing.addText(trimmed);
      const continuation = await this.writing.continueDraft({ onToken: options.onToken, stream: options.stream });
      if (continuation.startsWith("✍️ Smart writing requires") || continuation.startsWith("⚠️")) {
        const offlineReply = `${appendNote}\n\n${continuation}`;
        this.recordChannelMessage(sessionId, "assistant", offlineReply, "smart_writing_append_offline");
        return { response: offlineReply, isCommand: false };
      }
      this.recordChannelMessage(sessionId, "assistant", continuation, "smart_writing_continue");
      return { response: continuation, isCommand: false };
    }

    this.recordChannelMessage(sessionId, "user", trimmed);
    const history = this.db.query<{ role: "user" | "assistant"; content: string }>(
      "SELECT role, content FROM messages WHERE session_id = $sessionId ORDER BY created_at ASC",
      { $sessionId: sessionId }
    );
    const result = await this.responseEngine.generateResponse(trimmed, history, {
      onToken: options.onToken,
      stream: options.stream,
    });
    this.recordChannelMessage(sessionId, "assistant", result.response, result.strategy);

    try {
      if (this.config.learning.autoExtraction) {
        const historyStr = history.slice(-4).map((h) => `${h.role}: ${h.content}`).join("\n");
        await this.learningPipeline.extractWithLLM(trimmed, result.response, historyStr);
      }
    } catch (err: any) {
      console.warn(`[learning] Post-turn extraction failed (reply unaffected): ${err?.message || err}`);
    }
    try {
      if (this.config.learning.autoCandidateRules) {
        const historyStr = history.slice(-4).map((h) => `${h.role}: ${h.content}`).join("\n");
        await this.learningPipeline.proposeCandidateRule(trimmed, historyStr);
      }
    } catch (err: any) {
      console.warn(`[learning] Candidate-rule proposal failed (reply unaffected): ${err?.message || err}`);
    }

    return { response: result.response, isCommand: false, trace: result.trace };
  }

  private recordMessage(role: "user" | "assistant", content: string, strategy?: string): void {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, strategy, created_at, metadata)
       VALUES ($id, $session_id, $role, $content, $strategy, $created_at, NULL)`,
      {
        $id: id,
        $session_id: this.sessionId,
        $role: role,
        $content: content,
        $strategy: strategy || null,
        $created_at: now,
      }
    );
  }

  /**
   * Process a single turn of conversation (useful for CLI and unit tests).
   */
  public async handleInput(
    text: string,
    options: { onToken?: (token: string) => void; stream?: boolean } = {}
  ): Promise<{ response: string; isCommand: boolean; trace?: any }> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { response: "Please say something.", isCommand: false };
    }

    // 1. Slash commands (streaming-aware for smart-writing generations)
    if (trimmed.startsWith("/")) {
      const commandResult = await this.handleCommand(trimmed, options);
      return { response: commandResult, isCommand: true };
    }

    // 1b. Smart-writing session hijack: while ACTIVE, plain chat text is
    // story input — append it and auto-continue via Ollama (streams).
    // If the LLM is unreachable, the text is still kept in the draft.
    if (this.writing.isActive()) {
      this.recordMessage("user", trimmed);
      const appendNote = this.writing.addText(trimmed);
      const continuation = await this.writing.continueDraft({
        onToken: options.onToken,
        stream: options.stream,
      });
      if (continuation.startsWith("✍️ Smart writing requires") || continuation.startsWith("⚠️")) {
        const offlineReply = `${appendNote}\n\n${continuation}\n(Your lines are saved in the draft — /smart-writing show to view, /smart-writing save to persist.)`;
        this.recordMessage("assistant", offlineReply, "smart_writing_append_offline");
        return { response: offlineReply, isCommand: false };
      }
      this.recordMessage("assistant", continuation, "smart_writing_continue");
      return { response: continuation, isCommand: false };
    }

    // 2. Record user message
    this.recordMessage("user", trimmed);

    // 3. Generate response
    const history = this.getSessionHistory();
    const result = await this.responseEngine.generateResponse(trimmed, history, {
      onToken: options.onToken,
      stream: options.stream,
    });

    // 4. Record assistant message
    this.recordMessage("assistant", result.response, result.strategy);

    // 5. Incremental Learning (Post-turn, best-effort — must never break the reply)
    try {
      if (this.config.learning.autoExtraction) {
        const historyStr = history.slice(-4).map((h) => `${h.role}: ${h.content}`).join("\n");
        await this.learningPipeline.extractWithLLM(trimmed, result.response, historyStr);
      }
    } catch (err: any) {
      console.warn(`[learning] Post-turn extraction failed (reply unaffected): ${err?.message || err}`);
    }

    try {
      if (this.config.learning.autoCandidateRules) {
        const historyStr = history.slice(-4).map((h) => `${h.role}: ${h.content}`).join("\n");
        await this.learningPipeline.proposeCandidateRule(trimmed, historyStr);
      }
    } catch (err: any) {
      console.warn(`[learning] Candidate-rule proposal failed (reply unaffected): ${err?.message || err}`);
    }

    return { response: result.response, isCommand: false, trace: result.trace };
  }

  /**
   * Dispatches CLI slash commands.
   */
  public async handleCommand(
    cmdText: string,
    options: { onToken?: (token: string) => void; stream?: boolean } = {}
  ): Promise<string> {
    const parts = cmdText.split(" ");
    const cmd = parts[0]!.toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    switch (cmd) {
      case "/help":
        return `
=== ELIZA Bot Commands ===
  /help               Show this help guide
  /model [name]       Show or switch the active local LLM model
  /quit, /exit        Exit the conversation loop
  /clear              Clear current session and reset context
  /stats              Display database, learning, and strategy stats
  /memory [query]     List or search active persistent memories
  /knowledge [query]  List or search knowledge base entries
  /remember <text>    Explicitly teach the bot a personal memory/fact
  /forget <id>        Deactivate/forget a specific memory by ID
  /teach <text>       Explicitly add a general concept to knowledge base
  /correct <text>     Submit an explicit correction or update
  /rules [status]     Inspect rules (approved | candidate | all)
  /approve <id>       Approve a candidate rule to activate it
  /trace              Inspect full execution trace of the last turn
  /reload             Reload rules from JSON file and database
  /smart-writing ...  Co-write stories with Ollama (Ollama-only, see /smart-writing help)
`.trim();

      case "/model": {
        const llm = this.responseEngine.getLLM();
        if (arg) {
          llm.setModel(arg);
          return `Active Ollama model switched to (ELIZA:${arg}).`;
        }
        const current = llm.getModel();
        const isUp = await llm.isAvailable();
        const available = await llm.listModels();
        let out = `=== LLM Configuration ===\nActive Model: (ELIZA:${current || "rules"})\nStatus:       ${isUp ? "Online" : "Offline / Unreachable"}\n`;
        if (available.length > 0) {
          out += `Available Local Models:\n` + available.map((m) => `  - (ELIZA:${m})${m === current ? " [ACTIVE]" : ""}`).join("\n");
        } else {
          out += `(Use '/model <name>' to switch, e.g. /model llama3.2)`;
        }
        return out.trim();
      }

      case "/quit":
      case "/exit":
        this.isRunning = false;
        return "Goodbye.";

      case "/clear":
        this.sessionId = this.createSession();
        return "Conversation context cleared. Started fresh session.";

      case "/stats": {
        const stats = this.db.getStats();
        let out = `
=== Bot Statistics ===
Sessions:           ${stats.sessions}
Messages:           ${stats.messages}
Active Memories:    ${stats.activeMemories}
Superseded Memories:${stats.supersededMemories}
Active Knowledge:   ${stats.activeKnowledge}
Corrections:        ${stats.corrections}
Active ELIZA Rules: ${stats.activeRules}
Candidate Rules:    ${stats.candidateRules}

=== Strategy Performance ===`;
        if (stats.strategies.length === 0) {
          out += "\n(No strategies recorded yet)";
        } else {
          for (const s of stats.strategies) {
            out += `\n- ${s.strategy.padEnd(20)}: ${s.attempts} attempts | ${s.successes} successes | avg score: ${s.avgScore}`;
          }
        }
        return out.trim();
      }

      case "/memory": {
        if (arg) {
          const results = this.memoryRetriever.search(arg, 10);
          if (results.length === 0) return `No memories found matching "${arg}".`;
          let out = `=== Search Results for "${arg}" ===\n`;
          for (const r of results) {
            out += `[${r.memory.id}] (${r.memory.type}) Score: ${r.score.toFixed(2)}\n  ${r.memory.content}\n`;
          }
          return out.trim();
        }

        const all = this.memoryStore.listMemories({ limit: 15 });
        if (all.length === 0) return "No memories stored yet.";
        let out = `=== Recent Memories ===\n`;
        for (const m of all) {
          const statusTag = m.status === "superseded" ? ` [SUPERSEDED by ${m.supersededBy}]` : m.status === "forgotten" ? " [FORGOTTEN]" : "";
          out += `[${m.id}] (${m.type})${statusTag} (Conf: ${m.confidence.toFixed(2)})\n  ${m.content}\n`;
        }
        return out.trim();
      }

      case "/knowledge": {
        if (arg) {
          const results = this.knowledgeRetriever.search(arg, 8);
          if (results.length === 0) return `No knowledge found matching "${arg}".`;
          let out = `=== Knowledge Matches for "${arg}" ===\n`;
          for (const r of results) {
            out += `[${r.knowledge.id}] ${r.knowledge.title} (v${r.knowledge.version}, ${r.knowledge.category})\n  ${r.knowledge.content}\n`;
          }
          return out.trim();
        }

        const all = this.knowledgeStore.listKnowledge({ limit: 10 });
        if (all.length === 0) return "No knowledge entries found.";
        let out = `=== Knowledge Base ===\n`;
        for (const k of all) {
          out += `[${k.id}] ${k.title} (v${k.version}, ${k.category})\n  ${k.content}\n`;
        }
        return out.trim();
      }

      case "/remember": {
        if (!arg) return "Usage: /remember <fact or preference to remember>";
        const mem = this.memoryStore.addMemory({
          type: "fact",
          content: arg,
          source: "user_explicit_command",
          confidence: 1.0,
          importance: 0.9,
          tags: ["user_remember"],
        });
        return `Remembered: [${mem.id}] ${mem.content}`;
      }

      case "/forget": {
        if (!arg) return "Usage: /forget <memory_id>";
        const ok = this.memoryStore.forgetMemory(arg);
        return ok ? `Deactivated memory ${arg}.` : `Could not forget memory ${arg}.`;
      }

      case "/teach": {
        if (!arg) return "Usage: /teach <Title>: <Content> or /teach <Concept description>";
        let title = "Concept";
        let content = arg;
        if (arg.includes(":")) {
          const split = arg.split(":");
          title = split[0]!.trim();
          content = split.slice(1).join(":").trim();
        } else if (arg.length > 25) {
          title = arg.substring(0, 25).trim() + "...";
        }
        const kn = this.knowledgeStore.addKnowledge({
          title,
          content,
          category: "concept",
          sourceType: "user",
          confidence: 1.0,
          changeReason: "User explicit /teach command",
        });
        return `Learned knowledge entry: [${kn.id}] "${kn.title}" (v${kn.version})`;
      }

      case "/correct": {
        if (!arg) return "Usage: /correct <corrected statement>";
        const mem = this.memoryStore.addMemory({
          type: "correction",
          content: `User correction: ${arg}`,
          source: "user_explicit_correction",
          confidence: 0.99,
          importance: 0.95,
          tags: ["correction"],
        });
        return `Correction recorded: [${mem.id}] ${mem.content}`;
      }

      case "/rules": {
        const rules = this.ruleRegistry.getAllRulesIncludingCandidates();
        let out = `=== ELIZA Rules ===\n`;
        for (const r of rules) {
          const status = r.status || "approved";
          if (arg && arg !== "all" && status !== arg) continue;
          out += `[${r.id}] [${status.toUpperCase()}] (Priority ${r.priority}) Keywords: [${r.keywords.join(", ")}]\n`;
        }
        return out.trim();
      }

      case "/approve": {
        if (!arg) return "Usage: /approve <rule_id>";
        const ok = this.ruleRegistry.setRuleStatus(arg, "approved");
        this.matcher.updateRules(this.ruleRegistry.getRules());
        return ok ? `Rule ${arg} approved and activated!` : `Could not approve rule ${arg}.`;
      }

      case "/trace": {
        const trace = this.responseEngine.getLastTrace();
        if (!trace) return "No recent response trace available.";
        let out = `=== Response Trace ===\n`;
        out += `Input:             ${trace.input}\n`;
        out += `Strategy:          ${trace.responseStrategy}\n`;
        out += `Model:             ${trace.model}\n`;
        out += `Matched Rule:      ${trace.matchedRule ? `${trace.matchedRule.ruleId} (Priority ${trace.matchedRule.priority})` : "None"}\n`;

        out += `\nRetrieved Memories (${trace.retrievedMemories.length}):\n`;
        if (trace.retrievedMemories.length === 0) {
          out += `  (none)\n`;
        } else {
          for (const rm of trace.retrievedMemories) {
            out += `  - [${rm.memory.type}] ${rm.memory.content} (Score: ${rm.score.toFixed(2)}, Conf: ${rm.memory.confidence})\n`;
          }
        }

        out += `\nRetrieved Knowledge (${trace.retrievedKnowledge.length}):\n`;
        if (trace.retrievedKnowledge.length === 0) {
          out += `  (none)\n`;
        } else {
          for (const rk of trace.retrievedKnowledge) {
            out += `  - [${rk.knowledge.title}] (v${rk.knowledge.version}) Score: ${rk.score.toFixed(2)}\n`;
          }
        }

        if (trace.evaluation) {
          out += `\nEvaluation:\n`;
          out += `  Score:           ${trace.evaluation.score.toFixed(2)}\n`;
          out += `  Used Memory:     ${trace.evaluation.usedMemory}\n`;
          out += `  Hallucination:   ${trace.evaluation.potentialHallucination}\n`;
          out += `  Notes:           ${trace.evaluation.notes}\n`;
        }

        return out.trim();
      }

      case "/reload": {
        this.ruleRegistry.loadRules();
        this.matcher.updateRules(this.ruleRegistry.getRules());
        return "Rules reloaded successfully.";
      }

      case "/smart-writing":
      case "/smart-write":
      case "/write":
      case "/story": {
        return await this.handleSmartWriting(arg, options);
      }

      default:
        return `Unknown command "${cmd}". Type /help for available commands.`;
    }
  }

  /**
   * Dispatches /smart-writing subcommands (Ollama-gated co-writing).
   * Plain-text story typing while a session is ACTIVE is handled in handleInput().
   */
  private async handleSmartWriting(
    arg: string,
    options: { onToken?: (token: string) => void; stream?: boolean } = {}
  ): Promise<string> {
    const parts = arg.trim().split(/\s+/);
    const sub = (parts[0] || "help").toLowerCase();
    const rest = parts.slice(1).join(" ").trim();

    switch (sub) {
      case "help":
      case "":
      case "--help":
      case "-h":
        return SmartWritingManager.helpText();

      case "start":
      case "begin":
      case "new": {
        // /smart-writing start [Title: ] seed...  — optional "Title: seed" form
        let title: string | undefined;
        let seed = rest;
        const m = rest.match(/^(.{1,80}?):\s+(.+)$/);
        if (m && m[1] && m[2] && m[1].length < 60) {
          title = m[1].trim();
          seed = m[2].trim();
        }
        return await this.writing.start(seed, title);
      }

      case "add":
      case "append":
      case "note": {
        if (!rest) return "Usage: /smart-writing add <sentences or paragraphs to append>";
        return this.writing.addText(rest);
      }

      case "continue":
      case "go":
      case "next": {
        return await this.writing.continueDraft({ onToken: options.onToken, stream: options.stream ?? true });
      }

      case "improve":
      case "polish":
      case "rewrite":
      case "edit":
      case "expand":
      case "shorten": {
        const instruction = sub === "improve" || sub === "polish" ? rest : `${sub} ${rest}`.trim();
        return await this.writing.improveDraft(instruction, {
          onToken: options.onToken,
          stream: options.stream ?? true,
        });
      }

      case "show":
      case "draft":
      case "view":
        return this.writing.show();

      case "status":
        return this.writing.status();

      case "save":
      case "persist":
      case "remember": {
        return await this.writing.save(rest || undefined);
      }

      case "list":
      case "stories":
      case "library": {
        const n = parseInt(rest, 10);
        return this.writing.listStories(Number.isFinite(n) ? n : 10);
      }

      case "links":
      case "graph":
      case "associations": {
        if (!rest) return "Usage: /smart-writing links <story_memory_id> (see /smart-writing list)";
        return this.writing.showLinks(rest.split(/\s+/)[0]!);
      }

      case "done":
      case "finish":
      case "end":
      case "stop":
      case "close":
        return this.writing.done();

      case "cancel":
      case "discard":
      case "reset":
        return this.writing.cancel();

      default: {
        // Bare text after /smart-writing (e.g. "/smart-writing Once upon...")
        // is treated as: start if idle, else append.
        if (!this.writing.isActive()) {
          return await this.writing.start(arg, undefined);
        }
        return this.writing.addText(arg);
      }
    }
  }

  /**
   * Starts the interactive REPL CLI loop.
   */
  public async startCLI(): Promise<void> {
    await this.init();
    this.isRunning = true;
    const rl = readline.createInterface({ input, output });

    console.log("\n=======================================================");
    console.log("       ELIZA-AI: Incrementally Learning CLI Bot        ");
    console.log(`       Active Model: ${this.getBotDisplayName()}`);
    console.log("=======================================================");
    console.log("Type your message or /help for commands, /quit to exit.\n");

    const isAbortError = (err: any) =>
      err?.code === "ABORT_ERR" || err?.name === "AbortError" || /aborted with ctrl\+c|aborted/i.test(err?.message || "");

    try {
      while (this.isRunning) {
        let userText: string;
        try {
          userText = await rl.question("\x1b[36mYou:\x1b[0m ");
        } catch (err: any) {
          // Ctrl+C in Bun's readline rejects with ABORT_ERR — exit gracefully, don't crash.
          if (isAbortError(err)) {
            console.log("\nGoodbye.");
            this.isRunning = false;
            break;
          }
          throw err;
        }
        if (!this.isRunning) break;

        const trimmed = userText.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("/")) {
          const isWritingGen =
            /^\/smart-writing\s+(continue|improve|polish|rewrite|edit|expand|shorten)\b/i.test(trimmed) ||
            /^\/(smart-write|write|story)\s+(continue|improve|polish|rewrite|edit|expand|shorten)\b/i.test(trimmed);
          if (isWritingGen) {
            process.stdout.write(`\x1b[32m${this.getBotDisplayName()}:\x1b[0m `);
            let streamed = false;
            const resp = await this.handleCommand(trimmed, {
              stream: true,
              onToken: (token) => {
                streamed = true;
                process.stdout.write(token);
              },
            });
            if (!streamed) process.stdout.write(resp);
            console.log("\n");
          } else {
            const resp = await this.handleCommand(trimmed);
            console.log(`\x1b[33m${resp}\x1b[0m\n`);
          }
          if (!this.isRunning) break;
          continue;
        }

        process.stdout.write(`\x1b[32m${this.getBotDisplayName()}:\x1b[0m `);
        let streamed = false;

        try {
          const { response } = await this.handleInput(trimmed, {
            stream: true,
            onToken: (token) => {
              streamed = true;
              process.stdout.write(token);
            },
          });

          if (!streamed) {
            process.stdout.write(response);
          }
          console.log("\n");
        } catch (err: any) {
          // A failed/slow LLM call (e.g. timeout abort) must not kill the REPL.
          // The response engine already falls back to ELIZA; this is a last-resort guard.
          if (isAbortError(err)) {
            console.log(`\n[warn] Request aborted/timed out — reply skipped, continuing. (${err.message})`);
            continue;
          }
          console.log(`\n[warn] Turn failed but session continues: ${err?.message || err}`);
        }
      }
    } finally {
      rl.close();
      this.db.close();
    }
  }
}
