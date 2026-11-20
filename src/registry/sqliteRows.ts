// ============================================
// OpenSwarm - Registry SQLite row shapes
// Purpose: better-sqlite3 row types for the registry store, and the light
//          projection scanner reconciliation reads (AGT-3470).
// ============================================

import type { EntityStatus, RiskLevel } from './schema.js';

// ============ DB Row 타입 (better-sqlite3 반환값) ============

export interface EntityRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  signature: string | null;
  status: string;
  deprecated_at: string | null;
  deprecated_reason: string | null;
  has_tests: number;
  test_file: string | null;
  author: string | null;
  maintainer: string | null;
  complexity_score: number | null;
  risk_level: string;
  description: string | null;
  notes: string | null;
  knowledge_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarningRow {
  id: string;
  entity_id: string;
  severity: string;
  category: string;
  message: string;
  resolved: number;
  resolved_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  entity_id: string;
  type: string;
  old_value: string | null;
  new_value: string | null;
  content: string | null;
  actor: string;
  created_at: string;
}

export interface TagRow {
  tag: string;
  value: string | null;
}

export interface RelationRow {
  target_id: string;
  target_name: string;
  relation_type: string;
}

export interface CountRow {
  cnt: number;
}

export interface IssueLinkRow {
  entity_id: string;
  issue_id: string;
}

export interface MemoryLinkRow {
  entity_id: string;
  memory_id: string;
}

// ============ Scanner sync projection ============

/**
 * The columns scanner reconciliation compares, and nothing else: no tags,
 * warnings, issue or memory links. Hydrating full CodeEntity objects for every
 * existing row cost four extra batch queries and their arrays per page.
 */
export interface EntitySyncRow {
  id: string;
  qualifiedName: string;
  filePath: string;
  status: EntityStatus;
  author?: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  hasTests: boolean;
  testFile?: string;
  complexityScore?: number;
  riskLevel: RiskLevel;
}

export type EntitySyncDbRow = Pick<EntityRow,
  'id' | 'qualified_name' | 'file_path' | 'status' | 'author' | 'line_start' | 'line_end'
  | 'signature' | 'has_tests' | 'test_file' | 'complexity_score' | 'risk_level'>;

export const ENTITY_SYNC_COLUMNS = `id, qualified_name, file_path, status, author, line_start, line_end,
  signature, has_tests, test_file, complexity_score, risk_level`;

/** Same null→undefined mapping as the store's full CodeEntity conversion. */
export function toEntitySyncRow(row: EntitySyncDbRow): EntitySyncRow {
  return {
    id: row.id,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    status: row.status as EntityStatus,
    author: row.author ?? undefined,
    lineStart: row.line_start ?? undefined,
    lineEnd: row.line_end ?? undefined,
    signature: row.signature ?? undefined,
    hasTests: row.has_tests === 1,
    testFile: row.test_file ?? undefined,
    complexityScore: row.complexity_score ?? undefined,
    riskLevel: row.risk_level as RiskLevel,
  };
}
