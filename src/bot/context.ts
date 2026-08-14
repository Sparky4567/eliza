import type { MemoryRetriever, RetrievedMemory } from "../memory/retrieval.ts";
import type { KnowledgeRetriever, RetrievedKnowledge } from "../knowledge/retrieval.ts";
import type { ChatMessage } from "../llm/ollama.ts";
import { SYSTEM_PROMPT } from "../llm/prompts.ts";

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

  constructor(memoryRetriever: MemoryRetriever, knowledgeRetriever: KnowledgeRetriever) {
    this.memoryRetriever = memoryRetriever;
    this.knowledgeRetriever = knowledgeRetriever;
  }

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
    let systemContext = SYSTEM_PROMPT;

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
