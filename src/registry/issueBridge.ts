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

/** Bounded entity aggregation for one issue. */
export interface EntitiesForIssueResult {
  entities: CodeEntity[];
  /**
   * True when a cap stopped the walk with input left over: more explicit links
   * than fit (or the store-side ISSUE_ENTITIES_DEFAULT_LIMIT clamp was hit),
   * relevant files past `maxFiles`, or files/entities left unread once
   * `maxEntities` was reached. Conservative: may be true when the remaining
   * input would only have produced duplicates.
   */
  truncated: boolean;
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
 * without bound. `truncated` reports when a cap cut the result short.
 */
export function getEntitiesForIssueBounded(
  issueId: string,
  relevantFiles?: string[],
  projectId?: string,
  options: EntitiesForIssueOptions = {},
): EntitiesForIssueResult {
  const maxEntities = bound(options.maxEntities, ISSUE_ENTITIES_DEFAULT_LIMIT);
  const maxFiles = bound(options.maxFiles, ISSUE_RELEVANT_FILES_LIMIT);
  const files = relevantFiles ?? [];
  if (maxEntities === 0) {
    const anyInput = files.length > 0 || getRegistryStore().getEntitiesByIssueId(issueId, projectId, 1).length > 0;
    return { entities: [], truncated: anyInput };
  }

  const store = getRegistryStore();
  const entityMap = new Map<string, CodeEntity>();
  let truncated = files.length > maxFiles;

  // 1. 명시적 연결된 엔티티 (정식 store 메서드 사용, SQL LIMIT). One extra row
  // reveals overflow; the store clamps at ISSUE_ENTITIES_DEFAULT_LIMIT, so a
  // result that hits that clamp may also hide more links.
  const explicit = store.getEntitiesByIssueId(issueId, projectId, maxEntities + 1);
  if (explicit.length > maxEntities || explicit.length >= ISSUE_ENTITIES_DEFAULT_LIMIT) truncated = true;
  for (const entity of explicit.slice(0, maxEntities)) {
    entityMap.set(entity.id, entity);
  }

  // 2. relevantFiles 경로로 암시적 연결
  const consulted = files.slice(0, maxFiles);
  fileLoop: for (let i = 0; i < consulted.length; i++) {
    if (entityMap.size >= maxEntities) {
      truncated = true; // files left unread at the cap
      break;
    }
    for (const entity of store.fileBrief(consulted[i], projectId).entities) {
      if (entityMap.has(entity.id)) continue;
      if (entityMap.size >= maxEntities) {
        truncated = true;
        break fileLoop;
      }
      entityMap.set(entity.id, entity);
    }
  }

  return { entities: Array.from(entityMap.values()), truncated };
}

/** Entities-only form of {@link getEntitiesForIssueBounded}. */
export function getEntitiesForIssue(
  issueId: string,
  relevantFiles?: string[],
  projectId?: string,
  options: EntitiesForIssueOptions = {},
): CodeEntity[] {
  return getEntitiesForIssueBounded(issueId, relevantFiles, projectId, options).entities;
}
