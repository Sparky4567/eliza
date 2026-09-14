export type KnowledgeCategory =
  | "programming"
  | "science"
  | "history"
  | "technology"
  | "projects"
  | "concept"
  | "procedure"
  | "definition"
  | "writing";

export type KnowledgeSourceType = "user" | "model" | "external" | "derived";

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  sourceType: KnowledgeSourceType;
  sourceRef?: string | null;
  confidence: number;
  version: number;
  previousVersionId?: string | null;
  changeReason?: string | null;
  status: "active" | "deprecated";
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCreateInput {
  title: string;
  content: string;
  category?: KnowledgeCategory;
  sourceType?: KnowledgeSourceType;
  sourceRef?: string;
  confidence?: number;
  changeReason?: string;
}

export interface KnowledgeUpdateInput {
  title?: string;
  content: string;
  category?: KnowledgeCategory;
  sourceType?: KnowledgeSourceType;
  sourceRef?: string;
  confidence?: number;
  changeReason: string;
}
