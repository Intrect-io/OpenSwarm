// ============================================
// OpenSwarm - Registry ↔ Issue Bridge
// Created: 2026-04-10
// Purpose: 코드 엔티티와 이슈 간 연결 헬퍼
// ============================================

import { getRegistryStore, ISSUE_ENTITIES_DEFAULT_LIMIT } from './sqliteStore.js';
import type { CodeEntity } from './schema.js';

/** Most relevant files consulted for implicit links in one call. */
export const ISSUE_RELEVANT_FILES_LIMIT = 100;

export interface EntitiesForIssueOptions {
  /** Cap on entities returned (explicit links first, then relevant files). */
  maxEntities?: number;
  /** Cap on relevantFiles entries consulted. */
  maxFiles?: number;
}

function bound(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/**
 * 이슈에 연결된 코드 엔티티 조회
 * - 명시적으로 linkEntityToIssue된 엔티티
 * - issue의 relevantFiles 경로로 해당 파일의 엔티티를 자동 검색
 *
 * Aggregation is bounded: at most `maxEntities` entities are returned (explicit
 * links are fetched with that limit in SQL and take precedence), and at most
 * `maxFiles` relevant files are consulted. The walk stops as soon as the cap is
 * reached, so a heavily linked issue or a long file list cannot grow the result
 * without bound.
 */
export function getEntitiesForIssue(
  issueId: string,
  relevantFiles?: string[],
  projectId?: string,
  options: EntitiesForIssueOptions = {},
): CodeEntity[] {
  const maxEntities = bound(options.maxEntities, ISSUE_ENTITIES_DEFAULT_LIMIT);
  const maxFiles = bound(options.maxFiles, ISSUE_RELEVANT_FILES_LIMIT);
  if (maxEntities === 0) return [];

  const store = getRegistryStore();
  const entityMap = new Map<string, CodeEntity>();

  // 1. 명시적 연결된 엔티티 (정식 store 메서드 사용, SQL LIMIT)
  for (const entity of store.getEntitiesByIssueId(issueId, projectId, maxEntities)) {
    entityMap.set(entity.id, entity);
  }

  // 2. relevantFiles 경로로 암시적 연결
  if (relevantFiles) {
    for (const filePath of relevantFiles.slice(0, maxFiles)) {
      if (entityMap.size >= maxEntities) break;
      const brief = store.fileBrief(filePath, projectId);
      for (const entity of brief.entities) {
        if (entityMap.size >= maxEntities) break;
        entityMap.set(entity.id, entity);
      }
    }
  }

  return Array.from(entityMap.values());
}
