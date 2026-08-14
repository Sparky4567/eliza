import fs from "node:fs";
import path from "node:path";
import type { BotDatabase } from "../db/database.ts";

export interface ElizaRule {
  id: string;
  keywords: string[];
  patterns: string[];
  responses: string[];
  priority: number;
  status?: "candidate" | "approved" | "rejected" | "deprecated";
  sourceReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PatternMatchResult {
  ruleId: string;
  pattern: string;
  matchedKeywords: string[];
  captures: string[];
  reflectedCaptures: string[];
  response: string;
  priority: number;
}

export class ElizaRuleRegistry {
  private rules: ElizaRule[] = [];
  private rulesFilePath: string;
  private db?: BotDatabase;

  constructor(rulesFilePath: string, db?: BotDatabase) {
    this.rulesFilePath = rulesFilePath;
    this.db = db;
    this.loadRules();
  }

  public loadRules(): void {
    const loadedRules: ElizaRule[] = [];

    // 1. Load from file
    if (fs.existsSync(this.rulesFilePath)) {
      try {
        const content = fs.readFileSync(this.rulesFilePath, "utf-8");
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.rules)) {
          for (const r of parsed.rules) {
            loadedRules.push({
              id: r.id || `rule_${Math.random().toString(36).substring(2, 8)}`,
              keywords: Array.isArray(r.keywords) ? r.keywords : [],
              patterns: Array.isArray(r.patterns) ? r.patterns : ["*"],
              responses: Array.isArray(r.responses) ? r.responses : ["Tell me more."],
              priority: typeof r.priority === "number" ? r.priority : 5,
              status: "approved",
            });
          }
        }
      } catch (err) {
        console.error(`Warning: Failed to load rules file ${this.rulesFilePath}:`, err);
      }
    }

    // 2. Load approved learned rules from database
    if (this.db) {
      try {
        const rows = this.db.query<{
          id: string;
          keywords: string;
          patterns: string;
          responses: string;
          priority: number;
          status: "candidate" | "approved" | "rejected" | "deprecated";
          source_reason: string;
          created_at: string;
          updated_at: string;
        }>("SELECT * FROM learned_rules WHERE status = 'approved'");

        for (const row of rows) {
          loadedRules.push({
            id: row.id,
            keywords: JSON.parse(row.keywords || "[]"),
            patterns: JSON.parse(row.patterns || "[]"),
            responses: JSON.parse(row.responses || "[]"),
            priority: row.priority,
            status: row.status,
            sourceReason: row.source_reason,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }
      } catch (err) {
        console.error("Warning: Failed to load learned rules from DB:", err);
      }
    }

    // Sort descending by priority
    this.rules = loadedRules.sort((a, b) => b.priority - a.priority);
  }

  public getRules(): ElizaRule[] {
    return this.rules;
  }

  public getAllRulesIncludingCandidates(): ElizaRule[] {
    if (!this.db) return this.rules;

    const rows = this.db.query<{
      id: string;
      keywords: string;
      patterns: string;
      responses: string;
      priority: number;
      status: "candidate" | "approved" | "rejected" | "deprecated";
      source_reason: string;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM learned_rules");

    const learned = rows.map((row) => ({
      id: row.id,
      keywords: JSON.parse(row.keywords || "[]"),
      patterns: JSON.parse(row.patterns || "[]"),
      responses: JSON.parse(row.responses || "[]"),
      priority: row.priority,
      status: row.status,
      sourceReason: row.source_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return [...this.rules, ...learned];
  }

  public addCandidateRule(candidate: {
    keywords: string[];
    patterns: string[];
    responses: string[];
    priority?: number;
    sourceReason?: string;
  }): string {
    const id = `learned_rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const priority = candidate.priority ?? 8;
    const now = new Date().toISOString();

    if (this.db) {
      this.db.run(
        `INSERT INTO learned_rules (id, keywords, patterns, responses, priority, status, source_reason, created_at, updated_at)
         VALUES ($id, $keywords, $patterns, $responses, $priority, 'candidate', $source_reason, $created_at, $updated_at)`,
        {
          $id: id,
          $keywords: JSON.stringify(candidate.keywords),
          $patterns: JSON.stringify(candidate.patterns),
          $responses: JSON.stringify(candidate.responses),
          $priority: priority,
          $source_reason: candidate.sourceReason || "Discovered from conversation pattern",
          $created_at: now,
          $updated_at: now,
        }
      );

      this.db.logLearningEvent("candidate_rule_proposed", {
        id,
        keywords: candidate.keywords,
        priority,
      });
    }

    return id;
  }

  public setRuleStatus(id: string, status: "approved" | "rejected" | "deprecated"): boolean {
    if (!this.db) return false;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE learned_rules SET status = $status, updated_at = $updated_at WHERE id = $id`,
      {
        $status: status,
        $updated_at: now,
        $id: id,
      }
    );
    this.db.logLearningEvent("rule_status_changed", { id, status });
    this.loadRules();
    return true;
  }
}
