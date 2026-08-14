export type MemoryType =
  | "fact"
  | "preference"
  | "goal"
  | "project"
  | "concept"
  | "relationship"
  | "instruction"
  | "correction"
  | "observation";

export type MemoryStatus = "active" | "superseded" | "forgotten";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  supersededBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  usageCount: number;
  tags: string[];
}

export interface MemoryCreateInput {
  type: MemoryType;
  content: string;
  source?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  supersededBy?: string | null;
}

export interface MemoryQueryOptions {
  status?: MemoryStatus;
  type?: MemoryType;
  limit?: number;
  offset?: number;
}
