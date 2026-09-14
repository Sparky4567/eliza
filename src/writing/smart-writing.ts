import type { BotDatabase } from "../db/database.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { MemoryRetriever } from "../memory/retrieval.ts";
import type { KnowledgeStore } from "../knowledge/store.ts";
import type { KnowledgeRetriever } from "../knowledge/retrieval.ts";
import type { Memory } from "../memory/models.ts";
import type { KnowledgeEntry } from "../knowledge/models.ts";
import {
  SMART_WRITING_CONTINUE_PROMPT,
  SMART_WRITING_IMPROVE_PROMPT,
  SMART_WRITING_SUMMARY_PROMPT,
} from "../llm/prompts.ts";

export interface WritingLink {
  id: string;
  sourceId: string;
  sourceKind: string;
  targetId: string;
  targetKind: "memory" | "knowledge";
  relation: string;
  strength: number;
  createdAt: string;
  label?: string;
}

export interface SavedStory {
  memory: Memory;
  knowledge: KnowledgeEntry | null;
  links: WritingLink[];
  summary: string;
  keywords: string[];
}

const OFFLINE_MSG =
  "✍️ Smart writing requires an active Ollama model (LLM online). " +
  "Right now Ollama is disabled or unreachable, so /smart-writing is unavailable. " +
  "Start Ollama (e.g. `ollama serve` + `ollama pull gemma2`) or enable it via OLLAMA_ENABLED=true and try again.";

/**
 * SmartWritingManager — iterative co-writing machine / smart note-taking app.
 *
 * - Holds one active draft session in memory (per bot instance).
 * - `continueDraft` / `improveDraft` call Ollama (gated: must be enabled + reachable).
 * - `save` persists the story into long-term memory (type "story") + versioned
 *   knowledge (category "writing") and forms new associations via `memory_links`
 *   to related memories/knowledge (TF-IDF retrieval), like a smart notebook.
 */
export class SmartWritingManager {
  private db: BotDatabase;
  private llm: OllamaClient;
  private memoryStore: MemoryStore;
  private memoryRetriever: MemoryRetriever;
  private knowledgeStore: KnowledgeStore;
  private knowledgeRetriever: KnowledgeRetriever;

  private active = false;
  private title = "Untitled story";
  private draft = "";
  private revisions: Array<{ content: string; kind: "user" | "continue" | "improve"; at: string }> = [];

  constructor(
    db: BotDatabase,
    llm: OllamaClient,
    memoryStore: MemoryStore,
    memoryRetriever: MemoryRetriever,
    knowledgeStore: KnowledgeStore,
    knowledgeRetriever: KnowledgeRetriever
  ) {
    this.db = db;
    this.llm = llm;
    this.memoryStore = memoryStore;
    this.memoryRetriever = memoryRetriever;
    this.knowledgeStore = knowledgeStore;
    this.knowledgeRetriever = knowledgeRetriever;
  }

  // ---- session state ----

  public isActive(): boolean {
    return this.active;
  }

  public getTitle(): string {
    return this.title;
  }

  public getDraft(): string {
    return this.draft;
  }

  public wordCount(): number {
    const t = this.draft.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  // ---- Ollama gating ----

  /** True when an Ollama model is actually usable (enabled flag set). Cheap sync check. */
  public isOllamaEnabled(): boolean {
    return this.llm.isEnabled() && this.llm.getModel() !== "";
  }

  /** Full check (enabled + reachable). Used before any LLM generation. */
  public async requireOllama(): Promise<string | null> {
    if (!this.llm.isEnabled()) return OFFLINE_MSG;
    const up = await this.llm.isAvailable().catch(() => false);
    if (!up) return OFFLINE_MSG;
    if (!this.llm.getModel()) return OFFLINE_MSG;
    return null;
  }

  // ---- session ops (start/add need Ollama per spec: feature only with ollama model) ----

  public async start(seed = "", title?: string): Promise<string> {
    // Session creation only needs an Ollama *model selected* (feature is
    // Ollama-only by configuration). Reachability is enforced at generation
    // time (continue/improve), so users can draft offline and generate later.
    if (!this.llm.isEnabled() || !this.llm.getModel()) return OFFLINE_MSG;
    this.active = true;
    this.title = title?.trim() ? title.trim().slice(0, 120) : "Untitled story";
    this.draft = seed.trim();
    this.revisions = [];
    if (this.draft) {
      this.revisions.push({ content: this.draft, kind: "user", at: new Date().toISOString() });
    }
    const words = this.wordCount();
    return (
      `✍️ Smart-writing session started: "${this.title}" (Ollama model: ${this.llm.getModel()}).\n` +
      (this.draft
        ? `Draft so far (${words} words). I can /smart-writing continue or improve it.\n\n---\n${this.draft}`
        : `Your canvas is blank. Just type your story — multiple sentences or pasted paragraphs are fine — and I'll continue it with you.\n` +
          `Commands: /smart-writing continue · /smart-writing improve [instruction] · /smart-writing show · /smart-writing save [title] · /smart-writing done`)
    );
  }

  /** Append raw user text to the draft without calling the LLM. */
  public addText(text: string): string {
    if (!this.active) {
      return "No active smart-writing session. Start one with: /smart-writing start [first lines...]";
    }
    const clean = text.trim();
    if (!clean) return "Nothing to add — your text was empty.";
    this.draft = this.draft ? `${this.draft}\n\n${clean}` : clean;
    this.revisions.push({ content: clean, kind: "user", at: new Date().toISOString() });
    return `📝 Added ${clean.split(/\s+/).length} words. Draft is now ${this.wordCount()} words. Say /smart-writing continue to let me carry it on, or keep writing.`;
  }

  public show(): string {
    if (!this.active && !this.draft) return "No active smart-writing draft. Start one with /smart-writing start ...";
    return `✍️ "${this.title}" — ${this.wordCount()} words, ${this.revisions.length} revision(s):\n\n---\n${this.draft || "(empty draft)"}`;
  }

  public status(): string {
    if (!this.active) return "Smart-writing: idle (no active session). Use /smart-writing start to begin.";
    return (
      `✍️ Smart-writing: ACTIVE\nTitle: "${this.title}"\nWords: ${this.wordCount()}\nRevisions: ${this.revisions.length}\n` +
      `Model: ${this.llm.getModel() || "(none)"}\nUse /smart-writing show to view, /smart-writing save [title] to persist.`
    );
  }

  // ---- LLM generations (continue / improve) ----

  private buildMemoryContext(query: string, maxMem = 4, maxKnow = 3): string {
    let ctx = "";
    try {
      const mems = this.memoryRetriever.search(query.slice(0, 2000), maxMem);
      if (mems.length > 0) {
        ctx += "\n\nRelevant memories for consistency:\n";
        for (const m of mems) ctx += `- [${m.memory.type}] ${m.memory.content}\n`;
      }
    } catch {
      /* retrieval never breaks writing */
    }
    try {
      const kns = this.knowledgeRetriever.search(query.slice(0, 2000), maxKnow);
      if (kns.length > 0) {
        ctx += "\nRelevant knowledge:\n";
        for (const k of kns) ctx += `- [${k.knowledge.title}]: ${k.knowledge.content.slice(0, 300)}\n`;
      }
    } catch {
      /* noop */
    }
    return ctx;
  }

  public async continueDraft(
    options: { onToken?: (t: string) => void; stream?: boolean } = {}
  ): Promise<string> {
    const gate = await this.requireOllama();
    if (gate) return gate;
    if (!this.active) {
      return "No active smart-writing session. Start one with: /smart-writing start Once upon a time...";
    }
    if (!this.draft.trim()) {
      return "Your draft is empty — write a few sentences first, then I'll continue the story.";
    }
    const context = this.buildMemoryContext(this.draft);
    const prompt =
      `${SMART_WRITING_CONTINUE_PROMPT}\n${context}\n\n---\nCURRENT DRAFT (title: "${this.title}"):\n${this.draft}\n---\nWrite the continuation now:`;
    let continuation = "";
    try {
      const res = await this.llm.chat({
        messages: [{ role: "user", content: prompt }],
        stream: options.stream ?? false,
        onToken: options.onToken,
        temperature: 0.8,
      });
      continuation = res.content.trim();
    } catch (err: any) {
      return `⚠️ Continuation failed: ${err?.message || err}`;
    }
    if (!continuation) return "⚠️ The model returned an empty continuation. Try again.";
    this.draft = `${this.draft}\n\n${continuation}`;
    this.revisions.push({ content: continuation, kind: "continue", at: new Date().toISOString() });
    if (!options.onToken) {
      return `${continuation}\n\n— ✍️ (${this.wordCount()} words total. Keep writing, or /smart-writing improve · /smart-writing save · /smart-writing done)`;
    }
    // When streaming, tokens already went to the caller; return full text for recording.
    return continuation;
  }

  public async improveDraft(
    instruction = "",
    options: { onToken?: (t: string) => void; stream?: boolean } = {}
  ): Promise<string> {
    const gate = await this.requireOllama();
    if (gate) return gate;
    if (!this.active) {
      return "No active smart-writing session. Start one with: /smart-writing start ...";
    }
    if (!this.draft.trim()) return "Nothing to improve yet — your draft is empty.";
    const prompt =
      `${SMART_WRITING_IMPROVE_PROMPT}\n` +
      (instruction.trim() ? `Editing instruction: ${instruction.trim()}\n` : "") +
      `\n---\nDRAFT TO IMPROVE (title: "${this.title}"):\n${this.draft}\n---\nImproved version now:`;
    let improved = "";
    try {
      const res = await this.llm.chat({
        messages: [{ role: "user", content: prompt }],
        stream: options.stream ?? false,
        onToken: options.onToken,
        temperature: 0.5,
      });
      improved = res.content.trim();
    } catch (err: any) {
      return `⚠️ Improve failed: ${err?.message || err}`;
    }
    if (!improved) return "⚠️ The model returned an empty revision. Try again.";
    this.draft = improved;
    this.revisions.push({ content: improved, kind: "improve", at: new Date().toISOString() });
    if (!options.onToken) {
      return `${improved}\n\n— ✍️ Improved (${this.wordCount()} words. /smart-writing continue · /smart-writing save · /smart-writing done)`;
    }
    return improved;
  }

  // ---- persistence with memory linking ----

  private async summarize(title: string, text: string): Promise<{ summary: string; keywords: string[] }> {
    const fallbackSummary = text.length > 220 ? text.slice(0, 220).trim() + "…" : text;
    const fallbackKeywords = Array.from(
      new Set(text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 4))
    ).slice(0, 6);
    try {
      const up = await this.llm.isAvailable().catch(() => false);
      if (!up) return { summary: fallbackSummary, keywords: fallbackKeywords };
      const res = await this.llm.chat({
        messages: [{ role: "user", content: `${SMART_WRITING_SUMMARY_PROMPT}\n\nTitle: ${title}\n\n${text.slice(0, 4000)}` }],
        temperature: 0.2,
      });
      const raw = res.content;
      const sumMatch = raw.match(/Summary:\s*(.+)/i);
      const kwMatch = raw.match(/Keywords:\s*(.+)/i);
      return {
        summary: (sumMatch?.[1]?.trim() || fallbackSummary).slice(0, 500),
        keywords: kwMatch?.[1]
          ? kwMatch[1].split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 8)
          : fallbackKeywords,
      };
    } catch {
      return { summary: fallbackSummary, keywords: fallbackKeywords };
    }
  }

  public createLink(
    sourceId: string,
    targetId: string,
    targetKind: "memory" | "knowledge",
    relation: string,
    strength: number
  ): WritingLink {
    const id = `lnk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO memory_links (id, source_id, source_kind, target_id, target_kind, relation, strength, created_at)
       VALUES ($id, $source_id, 'memory', $target_id, $target_kind, $relation, $strength, $created_at)`,
      {
        $id: id,
        $source_id: sourceId,
        $target_id: targetId,
        $target_kind: targetKind,
        $relation: relation,
        $strength: Math.max(0, Math.min(1, strength)),
        $created_at: now,
      }
    );
    this.db.logLearningEvent("writing_link_created", { id, sourceId, targetId, targetKind, relation, strength });
    return { id, sourceId, sourceKind: "memory", targetId, targetKind, relation, strength, createdAt: now };
  }

  public getLinks(sourceId: string): WritingLink[] {
    const rows = this.db.query<any>(`SELECT * FROM memory_links WHERE source_id = $id ORDER BY strength DESC`, {
      $id: sourceId,
    });
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceKind: r.source_kind,
      targetId: r.target_id,
      targetKind: r.target_kind as "memory" | "knowledge",
      relation: r.relation,
      strength: r.strength,
      createdAt: r.created_at,
    }));
  }

  /** Persist the current draft as a story memory + writing knowledge + association links. */
  public async save(titleOverride?: string): Promise<string> {
    if (!this.draft.trim()) return "Nothing to save — your draft is empty.";
    const title = (titleOverride?.trim() || this.title || "Untitled story").slice(0, 120);
    this.title = title;
    const text = this.draft.trim();

    const { summary, keywords } = await this.summarize(title, text);
    const tags = ["smart-writing", "story", ...keywords.slice(0, 5)];

    // 1. Story memory (durable, searchable, linkable)
    const memory = this.memoryStore.addMemory({
      type: "story",
      content: `Story "${title}": ${summary}\n\n${text}`.slice(0, 8000),
      source: "smart_writing_save",
      confidence: 1.0,
      importance: 0.9,
      tags,
    });

    // 2. Versioned knowledge entry (smart-note side of the save)
    let knowledge: KnowledgeEntry | null = null;
    try {
      knowledge = this.knowledgeStore.addKnowledge({
        title: `Story: ${title}`,
        content: `${summary}\n\n${text}`.slice(0, 8000),
        category: "writing",
        sourceType: "user",
        sourceRef: memory.id,
        confidence: 1.0,
        changeReason: "Saved from smart-writing session",
      });
    } catch {
      knowledge = this.knowledgeStore.findByExactTitle(`Story: ${title}`);
    }

    // 3. Form new associations: link to related memories + knowledge via retrieval
    const links: WritingLink[] = [];
    const seen = new Set<string>();
    try {
      const relatedMems = this.memoryRetriever.search(`${title} ${summary} ${keywords.join(" ")}`, 5);
      for (const r of relatedMems) {
        if (r.memory.id === memory.id || seen.has(r.memory.id)) continue;
        seen.add(r.memory.id);
        links.push(
          this.createLink(memory.id, r.memory.id, "memory", "related", Math.min(0.95, 0.4 + r.score / 10))
        );
      }
    } catch {
      /* noop */
    }
    try {
      const relatedKnow = this.knowledgeRetriever.search(`${title} ${summary} ${keywords.join(" ")}`, 5);
      for (const r of relatedKnow) {
        if (knowledge && r.knowledge.id === knowledge.id) continue;
        if (seen.has(r.knowledge.id)) continue;
        seen.add(r.knowledge.id);
        links.push(
          this.createLink(memory.id, r.knowledge.id, "knowledge", "related", Math.min(0.95, 0.4 + r.score / 12))
        );
      }
    } catch {
      /* noop */
    }

    // Touch linked items so future retrieval prefers the association neighborhood.
    for (const l of links) {
      if (l.targetKind === "memory") {
        try {
          this.memoryStore.touchMemory(l.targetId);
        } catch {
          /* noop */
        }
      }
    }

    let out =
      `💾 Saved story "${title}" as [${memory.id}] (${this.wordCount()} words).\n` +
      `Knowledge: ${knowledge ? `[${knowledge.id}] "${knowledge.title}" (v${knowledge.version})` : "(skipped)"}\n` +
      `Summary: ${summary}\nKeywords: ${keywords.join(", ") || "—"}`;
    if (links.length > 0) {
      out += `\n\n🔗 Formed ${links.length} new association(s):`;
      for (const l of links.slice(0, 6)) {
        let label = l.targetId;
        if (l.targetKind === "memory") {
          const m = this.memoryStore.getMemory(l.targetId);
          if (m) label = `[${m.type}] ${m.content.slice(0, 90)}`;
        } else {
          const k = this.knowledgeStore.getKnowledge(l.targetId);
          if (k) label = `📚 ${k.title}`;
        }
        out += `\n  - (${l.relation}, ${(l.strength as number).toFixed(2)}) → [${l.targetKind}] ${label}`;
      }
    } else {
      out += `\n\n🔗 No prior memories matched — this story starts a new association cluster.`;
    }
    out += `\n\nSession still active — keep writing, or /smart-writing done to finish.`;
    return out;
  }

  public done(): string {
    if (!this.active) return "No active smart-writing session.";
    const words = this.wordCount();
    this.active = false;
    return `✍️ Smart-writing session closed ("${this.title}", ${words} words). Your draft is kept — /smart-writing show to view, /smart-writing save to persist, /smart-writing start to begin anew.`;
  }

  public cancel(): string {
    this.active = false;
    this.draft = "";
    this.revisions = [];
    return "✍️ Smart-writing session discarded. Start fresh with /smart-writing start ...";
  }

  // ---- library ----

  public listStories(limit = 10): string {
    const rows = this.db.query<any>(
      `SELECT * FROM memories WHERE type = 'story' AND status = 'active' ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`
    );
    if (rows.length === 0) return "📚 No saved stories yet. Write one with /smart-writing start ... then /smart-writing save.";
    let out = `📚 Saved stories (${rows.length}):\n`;
    for (const r of rows) {
      const firstLine = String(r.content).split("\n")[0]?.slice(0, 110);
      out += `[${r.id}] ${firstLine}\n`;
    }
    return out.trim();
  }

  public showLinks(storyId: string): string {
    const story = this.memoryStore.getMemory(storyId);
    if (!story) return `No story/memory found with id ${storyId}. Use /smart-writing list to browse.`;
    const links = this.getLinks(storyId);
    if (links.length === 0) return `No associations recorded for [${storyId}] yet.`;
    let out = `🔗 Associations for [${storyId}] (${links.length}):\n`;
    for (const l of links) {
      let label = l.targetId;
      if (l.targetKind === "memory") {
        const m = this.memoryStore.getMemory(l.targetId);
        if (m) label = `[${m.type}] ${m.content.slice(0, 100)}`;
      } else {
        const k = this.knowledgeStore.getKnowledge(l.targetId);
        if (k) label = `📚 "${k.title}" — ${k.content.slice(0, 100)}`;
      }
      out += `- (${l.relation}, ${Number(l.strength).toFixed(2)}) [${l.targetKind}:${l.targetId}] ${label}\n`;
    }
    return out.trim();
  }

  public static helpText(): string {
    return `
=== ✍️ Smart Writing (Ollama-only) ===
Co-write stories / long-form notes with the local LLM. Multi-sentence and
multi-line input is supported: while a session is ACTIVE, anything you type
(normal chat text) is appended to the draft and continued by the model.

  /smart-writing start [seed]   Begin a session (requires Ollama online).
                                e.g. /smart-writing start Once upon a time in Brno...
  /smart-writing add <text>     Append text to the draft without generating.
  /smart-writing continue       Let the model continue the story (streams).
  /smart-writing improve [how]  Rewrite/polish the draft (e.g. "make it darker").
  /smart-writing show           Display the current draft.
  /smart-writing status         Session state (title, words, revisions, model).
  /smart-writing save [title]   Persist to memory (type "story") + knowledge
                                (category "writing") and form 🔗 associations
                                to related memories/knowledge.
  /smart-writing list           Browse saved stories.
  /smart-writing links <id>     Show association graph for a saved story.
  /smart-writing done           Close the session (keeps draft).
  /smart-writing cancel         Discard draft + close session.
  /smart-writing help           Show this guide.

Aliases: /smart-write, /write, /story
Tip: while ACTIVE, just keep typing story lines — each message is added and
continued automatically. Use /smart-writing add for silent notes.
`.trim();
  }
}
