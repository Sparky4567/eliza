import type { BotDatabase } from "../db/database.ts";
import type { Memory, MemoryCreateInput, MemoryQueryOptions, MemoryStatus, MemoryType } from "./models.ts";

export class MemoryStore {
  private db: BotDatabase;

  constructor(db: BotDatabase) {
    this.db = db;
  }

  public addMemory(input: MemoryCreateInput): Memory {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const confidence = input.confidence ?? 1.0;
    const importance = input.importance ?? 0.5;
    const source = input.source ?? "user_conversation";
    const tags = input.tags ?? [];

    // Check for exact/near duplicate active memories
    const existing = this.findSimilarActive(input.content, input.type);
    if (existing.exactMatch) {
      // Update existing memory importance/usage rather than creating duplicate
      this.touchMemory(existing.exactMatch.id);
      return existing.exactMatch;
    }

    // Check for contradictions to supersede if input is a correction or conflicting update
    if (input.type === "correction" || existing.conflicts.length > 0) {
      for (const oldMem of existing.conflicts) {
        this.supersedeMemory(oldMem.id, id, "Updated by new statement or correction");
      }
    }

    this.db.run(
      `INSERT INTO memories (
        id, type, content, source, confidence, importance, status, superseded_by,
        created_at, updated_at, last_used_at, usage_count, tags
      ) VALUES ($id, $type, $content, $source, $confidence, $importance, 'active', $superseded_by, $created_at, $updated_at, NULL, 0, $tags)`,
      {
        $id: id,
        $type: input.type,
        $content: input.content.trim(),
        $source: source,
        $confidence: confidence,
        $importance: importance,
        $superseded_by: input.supersededBy || null,
        $created_at: now,
        $updated_at: now,
        $tags: JSON.stringify(tags),
      }
    );

    this.db.logLearningEvent("memory_created", {
      id,
      type: input.type,
      content: input.content,
      confidence,
      source,
    });

    return this.getMemory(id)!;
  }

  public getMemory(id: string): Memory | null {
    const row = this.db.get<{
      id: string;
      type: MemoryType;
      content: string;
      source: string;
      confidence: number;
      importance: number;
      status: MemoryStatus;
      superseded_by: string | null;
      created_at: string;
      updated_at: string;
      last_used_at: string | null;
      usage_count: number;
      tags: string;
    }>("SELECT * FROM memories WHERE id = $id", { $id: id });

    if (!row) return null;
    return this.mapRowToMemory(row);
  }

  public listMemories(options: MemoryQueryOptions = {}): Memory[] {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params: Record<string, unknown> = {};

    if (options.status) {
      sql += " AND status = $status";
      params.$status = options.status;
    }
    if (options.type) {
      sql += " AND type = $type";
      params.$type = options.type;
    }

    sql += " ORDER BY created_at DESC";

    if (options.limit) {
      sql += ` LIMIT ${Math.floor(options.limit)}`;
    }
    if (options.offset) {
      sql += ` OFFSET ${Math.floor(options.offset)}`;
    }

    const rows = this.db.query<any>(sql, params);
    return rows.map((r) => this.mapRowToMemory(r));
  }

  public getActiveMemories(): Memory[] {
    return this.listMemories({ status: "active" });
  }

  public supersedeMemory(oldId: string, newId: string, reason?: string): boolean {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET status = 'superseded', superseded_by = $newId, updated_at = $now WHERE id = $oldId`,
      {
        $newId: newId,
        $now: now,
        $oldId: oldId,
      }
    );

    this.db.logLearningEvent("memory_superseded", {
      oldId,
      supersededBy: newId,
      reason: reason || "superseded",
    });

    return true;
  }

  public forgetMemory(id: string): boolean {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET status = 'forgotten', updated_at = $now WHERE id = $id`,
      {
        $now: now,
        $id: id,
      }
    );

    this.db.logLearningEvent("memory_forgotten", { id });
    return true;
  }

  public touchMemory(id: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET usage_count = usage_count + 1, last_used_at = $now WHERE id = $id`,
      {
        $now: now,
        $id: id,
      }
    );
  }

  /**
   * Identifies exact matches or topic conflicts among active memories.
   */
  public findSimilarActive(content: string, type: MemoryType): {
    exactMatch: Memory | null;
    conflicts: Memory[];
  } {
    const activeMemories = this.getActiveMemories();
    const cleanContent = content.toLowerCase().trim();
    const tokens = cleanContent.split(/\W+/).filter((w) => w.length > 2);

    let exactMatch: Memory | null = null;
    const conflicts: Memory[] = [];

    for (const mem of activeMemories) {
      const memClean = mem.content.toLowerCase().trim();
      if (memClean === cleanContent) {
        exactMatch = mem;
        break;
      }

      // Check if memory has same type and high token overlap suggesting a replacement or conflict
      if (mem.type === type && (type === "project" || type === "preference" || type === "fact" || type === "correction")) {
        const memTokens = memClean.split(/\W+/).filter((w) => w.length > 2);
        const overlap = tokens.filter((t) => memTokens.includes(t));
        const overlapRatio = overlap.length / Math.max(tokens.length, memTokens.length, 1);

        // If high topic overlap with conflicting verbs/nouns (e.g. database change or tool change)
        if (overlapRatio > 0.45 && mem.content !== content) {
          conflicts.push(mem);
        }
      }
    }

    return { exactMatch, conflicts };
  }

  private mapRowToMemory(row: any): Memory {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      confidence: row.confidence,
      importance: row.importance,
      status: row.status,
      supersededBy: row.superseded_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      usageCount: row.usage_count,
      tags: typeof row.tags === "string" ? JSON.parse(row.tags || "[]") : [],
    };
  }
}
