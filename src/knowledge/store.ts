import type { BotDatabase } from "../db/database.ts";
import type {
  KnowledgeCategory,
  KnowledgeCreateInput,
  KnowledgeEntry,
  KnowledgeSourceType,
  KnowledgeUpdateInput,
} from "./models.ts";

export class KnowledgeStore {
  private db: BotDatabase;

  constructor(db: BotDatabase) {
    this.db = db;
  }

  public addKnowledge(input: KnowledgeCreateInput): KnowledgeEntry {
    const id = `kn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const category: KnowledgeCategory = input.category ?? "concept";
    const sourceType: KnowledgeSourceType = input.sourceType ?? "user";
    const confidence = input.confidence ?? 1.0;

    // Check if an entry with exact title already exists
    const existing = this.findByExactTitle(input.title);
    if (existing) {
      // Update as a new version
      return this.updateKnowledge(existing.id, {
        content: input.content,
        category,
        sourceType,
        sourceRef: input.sourceRef,
        confidence,
        changeReason: input.changeReason || "Updated with new information",
      });
    }

    this.db.run(
      `INSERT INTO knowledge (
        id, title, content, category, source_type, source_ref, confidence,
        version, previous_version_id, change_reason, status, created_at, updated_at
      ) VALUES ($id, $title, $content, $category, $source_type, $source_ref, $confidence,
        1, NULL, $change_reason, 'active', $created_at, $updated_at)`,
      {
        $id: id,
        $title: input.title.trim(),
        $content: input.content.trim(),
        $category: category,
        $source_type: sourceType,
        $source_ref: input.sourceRef || null,
        $confidence: confidence,
        $change_reason: input.changeReason || "Initial creation",
        $created_at: now,
        $updated_at: now,
      }
    );

    this.db.logLearningEvent("knowledge_created", {
      id,
      title: input.title,
      category,
      sourceType,
    });

    return this.getKnowledge(id)!;
  }

  public updateKnowledge(currentId: string, input: KnowledgeUpdateInput): KnowledgeEntry {
    const current = this.getKnowledge(currentId);
    if (!current) {
      throw new Error(`Knowledge item ${currentId} not found`);
    }

    const newId = `kn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const title = input.title?.trim() || current.title;
    const category = input.category || current.category;
    const sourceType = input.sourceType || current.sourceType;
    const sourceRef = input.sourceRef !== undefined ? input.sourceRef : current.sourceRef;
    const confidence = input.confidence !== undefined ? input.confidence : current.confidence;

    // Deprecate previous version
    this.db.run(
      `UPDATE knowledge SET status = 'deprecated', updated_at = $now WHERE id = $currentId`,
      { $now: now, $currentId: currentId }
    );

    // Insert new version
    this.db.run(
      `INSERT INTO knowledge (
        id, title, content, category, source_type, source_ref, confidence,
        version, previous_version_id, change_reason, status, created_at, updated_at
      ) VALUES ($id, $title, $content, $category, $source_type, $source_ref, $confidence,
        $version, $previous_version_id, $change_reason, 'active', $created_at, $updated_at)`,
      {
        $id: newId,
        $title: title,
        $content: input.content.trim(),
        $category: category,
        $source_type: sourceType,
        $source_ref: sourceRef || null,
        $confidence: confidence,
        $version: newVersion,
        $previous_version_id: currentId,
        $change_reason: input.changeReason,
        $created_at: now,
        $updated_at: now,
      }
    );

    this.db.logLearningEvent("knowledge_version_updated", {
      previousId: currentId,
      newId,
      title,
      version: newVersion,
      reason: input.changeReason,
    });

    return this.getKnowledge(newId)!;
  }

  public getKnowledge(id: string): KnowledgeEntry | null {
    const row = this.db.get<any>("SELECT * FROM knowledge WHERE id = $id", { $id: id });
    if (!row) return null;
    return this.mapRowToKnowledge(row);
  }

  public findByExactTitle(title: string): KnowledgeEntry | null {
    const row = this.db.get<any>(
      "SELECT * FROM knowledge WHERE LOWER(title) = LOWER($title) AND status = 'active'",
      { $title: title.trim() }
    );
    if (!row) return null;
    return this.mapRowToKnowledge(row);
  }

  public listKnowledge(options: { status?: "active" | "deprecated"; category?: KnowledgeCategory; limit?: number } = {}): KnowledgeEntry[] {
    let sql = "SELECT * FROM knowledge WHERE 1=1";
    const params: Record<string, unknown> = {};

    if (options.status) {
      sql += " AND status = $status";
      params.$status = options.status;
    } else {
      sql += " AND status = 'active'";
    }

    if (options.category) {
      sql += " AND category = $category";
      params.$category = options.category;
    }

    sql += " ORDER BY updated_at DESC";

    if (options.limit) {
      sql += ` LIMIT ${Math.floor(options.limit)}`;
    }

    const rows = this.db.query<any>(sql, params);
    return rows.map((r) => this.mapRowToKnowledge(r));
  }

  public getVersionHistory(id: string): KnowledgeEntry[] {
    const history: KnowledgeEntry[] = [];
    let currentId: string | null = id;

    while (currentId) {
      const entry = this.getKnowledge(currentId);
      if (!entry) break;
      history.push(entry);
      currentId = entry.previousVersionId || null;
    }

    return history;
  }

  private mapRowToKnowledge(row: any): KnowledgeEntry {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      category: row.category,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      confidence: row.confidence,
      version: row.version,
      previousVersionId: row.previous_version_id,
      changeReason: row.change_reason,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
