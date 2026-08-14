import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.ts";

export class BotDatabase {
  private db: Database;
  public readonly filePath: string;

  constructor(filePath: string = "data/bot.db") {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      const dir = path.dirname(path.resolve(filePath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  public get raw(): Database {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public query<T = unknown>(sql: string, params: Record<string, unknown> | (string | number | boolean | null)[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(params as never) as T[];
  }

  public get<T = unknown>(sql: string, params: Record<string, unknown> | (string | number | boolean | null)[] = []): T | null {
    const stmt = this.db.prepare(sql);
    const result = stmt.get(params as never) as T | undefined;
    return result ?? null;
  }

  public run(sql: string, params: Record<string, unknown> | (string | number | boolean | null)[] = []): void {
    const stmt = this.db.prepare(sql);
    stmt.run(params as never);
  }

  public logLearningEvent(eventType: string, details: Record<string, unknown>): void {
    const id = `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.run(
      `INSERT INTO learning_logs (id, event_type, details, timestamp) VALUES ($id, $event_type, $details, $timestamp)`,
      {
        $id: id,
        $event_type: eventType,
        $details: JSON.stringify(details),
        $timestamp: new Date().toISOString(),
      }
    );
  }

  public getStats(): {
    sessions: number;
    messages: number;
    activeMemories: number;
    supersededMemories: number;
    activeKnowledge: number;
    corrections: number;
    activeRules: number;
    candidateRules: number;
    strategies: Array<{ strategy: string; attempts: number; successes: number; avgScore: number }>;
  } {
    const sessionCount = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM sessions")?.count ?? 0);
    const messageCount = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM messages")?.count ?? 0);
    const activeMem = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM memories WHERE status = 'active'")?.count ?? 0);
    const superMem = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM memories WHERE status = 'superseded'")?.count ?? 0);
    const activeKnow = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM knowledge WHERE status = 'active'")?.count ?? 0);
    const correctionsCount = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM memories WHERE type = 'correction'")?.count ?? 0);
    const approvedRules = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM learned_rules WHERE status = 'approved'")?.count ?? 0);
    const candidateRules = (this.get<{ count: number }>("SELECT COUNT(*) as count FROM learned_rules WHERE status = 'candidate'")?.count ?? 0);

    const stratRows = this.query<{ strategy: string; attempts: number; successes: number; total_score: number }>(
      "SELECT strategy, attempts, successes, total_score FROM strategy_stats ORDER BY attempts DESC"
    );
    const strategies = stratRows.map((s) => ({
      strategy: s.strategy,
      attempts: s.attempts,
      successes: s.successes,
      avgScore: s.attempts > 0 ? Number((s.total_score / s.attempts).toFixed(2)) : 0,
    }));

    return {
      sessions: sessionCount,
      messages: messageCount,
      activeMemories: activeMem,
      supersededMemories: superMem,
      activeKnowledge: activeKnow,
      corrections: correctionsCount,
      activeRules: approvedRules,
      candidateRules,
      strategies,
    };
  }
}
