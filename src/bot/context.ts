import type { MemoryRetriever, RetrievedMemory } from "../memory/retrieval.ts";
import type { KnowledgeRetriever, RetrievedKnowledge } from "../knowledge/retrieval.ts";
import type { ChatMessage } from "../llm/ollama.ts";
import { SYSTEM_PROMPT, getPersonaPreset, listPersonaPresets } from "../llm/prompts.ts";

export interface ContextOptions {
  maxMemories?: number;
  maxKnowledge?: number;
  maxHistoryTurns?: number;
}

export interface BuiltContext {
  systemPrompt: string;
  retrievedMemories: RetrievedMemory[];
  retrievedKnowledge: RetrievedKnowledge[];
  historyMessages: ChatMessage[];
  chatMessages: ChatMessage[];
  fullPromptText: string;
}

export class ContextBuilder {
  private memoryRetriever: MemoryRetriever;
  private knowledgeRetriever: KnowledgeRetriever;
  private systemPromptTemplate: string;

  constructor(
    memoryRetriever: MemoryRetriever,
    knowledgeRetriever: KnowledgeRetriever,
    systemPromptTemplate?: string | {
      systemPrompt?: string;
      systemTemplate?: string;
      persona?: string;
      template?: string;
      prompt?: string;
    }
  ) {
    this.memoryRetriever = memoryRetriever;
    this.knowledgeRetriever = knowledgeRetriever;
    let resolved = SYSTEM_PROMPT;
    if (typeof systemPromptTemplate === "string") {
      resolved = systemPromptTemplate;
    } else if (systemPromptTemplate && typeof systemPromptTemplate === "object") {
      resolved =
        systemPromptTemplate.systemPrompt ||
        systemPromptTemplate.systemTemplate ||
        systemPromptTemplate.persona ||
        systemPromptTemplate.template ||
        systemPromptTemplate.prompt ||
        SYSTEM_PROMPT;
    }
    this.systemPromptTemplate = resolved && resolved.trim() ? resolved : SYSTEM_PROMPT;
  }

  public getSystemPrompt(): string {
    return this.systemPromptTemplate;
  }

  public getSystemTemplate(): string {
    return this.getSystemPrompt();
  }

  public getPersona(): string {
    return this.getSystemPrompt();
  }

  public setSystemPrompt(template: string): string {
    const clean = (template ?? "").trim();
    if (!clean) throw new Error("system prompt must not be empty");
    this.systemPromptTemplate = clean;
    return this.systemPromptTemplate;
  }

  public setSystemTemplate(template: string): string {
    return this.setSystemPrompt(template);
  }

  public setPersona(template: string): string {
    return this.setSystemPrompt(template);
  }

  public resetSystemPrompt(): string {
    this.systemPromptTemplate = SYSTEM_PROMPT;
    return this.systemPromptTemplate;
  }

  public resetSystemTemplate(): string {
    return this.resetSystemPrompt();
  }

  public resetPersona(): string {
    return this.resetSystemPrompt();
  }

  public getPersonaPreset(name: string): string | null {
    return getPersonaPreset(name);
  }

  public listPersonaPresets(): string[] {
    return listPersonaPresets();
  }

  public setPersonaPreset(name: string): string {
    const preset = getPersonaPreset(name);
    if (!preset) throw new Error(`Unknown persona preset: ${name}`);
    return this.setSystemPrompt(preset);
  }

  public getSystemPromptTemplate(): string { return this.getSystemPrompt(); }
  public setSystemPromptTemplate(template: string): string { return this.setSystemPrompt(template); }
  public resetSystemPromptTemplate(): string { return this.resetSystemPrompt(); }

  public getPrompt(): string { return this.getSystemPrompt(); }
  public setPrompt(template: string): string { return this.setSystemPrompt(template); }
  public resetPrompt(): string { return this.resetSystemPrompt(); }

  public getTemplate(): string { return this.getSystemPrompt(); }
  public setTemplate(template: string): string { return this.setSystemPrompt(template); }
  public resetTemplate(): string { return this.resetSystemPrompt(); }

  public build(
    userMessage: string,
    recentHistory: Array<{ role: "user" | "assistant"; content: string }>,
    options: ContextOptions = {}
  ): BuiltContext {
    const maxMemories = options.maxMemories ?? 5;
    const maxKnowledge = options.maxKnowledge ?? 4;
    const maxHistoryTurns = options.maxHistoryTurns ?? 8;

    // 1. Retrieve memories relevant to user message
    const retrievedMemories = this.memoryRetriever.search(userMessage, maxMemories);

    // 2. Retrieve knowledge relevant to user message
    const retrievedKnowledge = this.knowledgeRetriever.search(userMessage, maxKnowledge);

    // 3. Slice recent history
    const slicedHistory = recentHistory.slice(-maxHistoryTurns);

    // 4. Build System Context section
    let systemContext = this.systemPromptTemplate;

    if (retrievedMemories.length > 0) {
      systemContext += "\n\n=== RELEVANT PERSISTENT MEMORIES ===";
      for (const m of retrievedMemories) {
        systemContext += `\n- [${m.memory.type}] ${m.memory.content} (Confidence: ${m.memory.confidence})`;
      }
    }

    if (retrievedKnowledge.length > 0) {
      systemContext += "\n\n=== RELEVANT KNOWLEDGE BASE ===";
      for (const k of retrievedKnowledge) {
        systemContext += `\n- [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`;
      }
    }

    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemContext },
      ...slicedHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];

    const fullPromptText = chatMessages.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");

    return {
      systemPrompt: systemContext,
      retrievedMemories,
      retrievedKnowledge,
      historyMessages: slicedHistory.map((h) => ({ role: h.role, content: h.content })),
      chatMessages,
      fullPromptText,
    };
  }
}
