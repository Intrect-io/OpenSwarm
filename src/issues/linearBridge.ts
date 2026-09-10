// ============================================
// OpenSwarm - Linear ↔ Local Issue Bridge
// Created: 2026-04-03
// Purpose: Linear 이슈를 로컬 DB와 양방향 동기화 (optional)
// Dependencies: @linear/sdk, sqliteStore
// ============================================

import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue, IssueStatus, IssuePriority } from './schema.js';

// Linear SDK는 동적 import (Linear 미사용 시 로드 안 함)
let linearClient: any = null;
let linearTeamId: string = '';
let linearInitPromise: Promise<void> | null = null;

/**
 * Linear 브릿지 초기화
 * config.yaml에서 linear.enabled: true 일 때만 호출
 */
export function initLinearBridge(apiKey: string, teamId: string): Promise<void> {
  // 기존 linear.ts의 클라이언트를 재사용하기 위해 동적 import
  linearTeamId = teamId;
  linearClient = null;
  linearInitPromise = import('@linear/sdk').then(({ LinearClient }) => {
    linearClient = new LinearClient({ apiKey });
    console.log('[LinearBridge] 초기화 완료 — team:', teamId);
  }).catch((err) => {
    linearClient = null;
    console.warn('[LinearBridge] Linear SDK 로드 실패:', err);
  });
  return linearInitPromise;
}

/**
 * Linear → 로컬: Linear 이슈를 로컬 DB에 동기화
 */
export async function syncFromLinear(
  store: SqliteIssueStore,
  projectId: string,
  options?: { states?: string[]; limit?: number },
): Promise<{ created: number; updated: number }> {
  await waitForLinearBridgeInit();
  if (!linearClient) {
    console.warn('[LinearBridge] 클라이언트 미초기화');
    return { created: 0, updated: 0 };
  }

  const states = options?.states ?? ['In Progress', 'Todo', 'Backlog', 'In Review', 'Done', 'Canceled', 'Cancelled'];
  const limit = options?.limit ?? 50;

  let created = 0;
  let updated = 0;

  try {
    const issues = await linearClient.issues({
      filter: {
        team: { id: { eq: linearTeamId } },
        state: { name: { in: states } },
      },
      first: limit,
      orderBy: 'updatedAt',
    });

    for (const issue of issues.nodes) {
      const existing = findByLinearId(store, issue.id);
      const linearData = await mapLinearToLocal(issue, projectId);

      if (existing) {
        // 이미 존재 → 업데이트
        store.updateIssue(existing.id, linearData);
        updated++;
      } else {
        // 새 이슈 → 생성
        store.createIssue({
          ...linearData,
          source: 'linear',
          linearId: issue.id,
          linearIdentifier: issue.identifier,
          linearUrl: issue.url,
        });
        created++;
      }
    }

    console.log(`[LinearBridge] 동기화 완료 — created: ${created}, updated: ${updated}`);
  } catch (err) {
    console.error('[LinearBridge] 동기화 실패:', err);
  }

  return { created, updated };
}

/**
 * 로컬 → Linear: 로컬 이슈를 Linear에 생성.
 * Linear create와 로컬 mapping persist를 분리해, mapping 실패 시 linearId로
 * 재연결/재시도하고 동일 프로세스 재호출에서 중복 create를 막는다.
 */
const pendingLinearMappings = new Map<string, {
  linearId: string;
  linearIdentifier: string;
  linearUrl: string;
}>();

const MAPPING_PERSIST_ATTEMPTS = 3;

/** @internal Test-only: install a fake client without loading the SDK. */
export function __setLinearBridgeClientForTests(client: unknown, teamId = 'team-test'): void {
  linearClient = client;
  linearTeamId = teamId;
  linearInitPromise = Promise.resolve();
}

/** @internal Test-only: drop in-process pending mapping recovery state. */
export function __clearPendingLinearMappingsForTests(): void {
  pendingLinearMappings.clear();
}

function persistLinearMapping(
  store: SqliteIssueStore,
  issueId: string,
  mapping: { linearId: string; linearIdentifier: string; linearUrl: string },
): void {
  store.updateIssue(issueId, {
    linearId: mapping.linearId,
    linearIdentifier: mapping.linearIdentifier,
    linearUrl: mapping.linearUrl,
  });
  store.addEvent(issueId, 'linked', {
    content: `Linear에 생성: ${mapping.linearIdentifier}`,
    newValue: mapping.linearIdentifier,
    idempotencyKey: `linear-linked:${mapping.linearId}`,
  });
}

function persistLinearMappingWithRetry(
  store: SqliteIssueStore,
  issueId: string,
  mapping: { linearId: string; linearIdentifier: string; linearUrl: string },
): boolean {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAPPING_PERSIST_ATTEMPTS; attempt++) {
    try {
      persistLinearMapping(store, issueId, mapping);
      pendingLinearMappings.delete(issueId);
      return true;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[LinearBridge] 로컬 mapping persist 실패 (${attempt}/${MAPPING_PERSIST_ATTEMPTS}):`,
        err,
      );
    }
  }
  // Best-effort reconnect: updateIssue alone may succeed even if addEvent failed.
  try {
    store.updateIssue(issueId, {
      linearId: mapping.linearId,
      linearIdentifier: mapping.linearIdentifier,
      linearUrl: mapping.linearUrl,
    });
    pendingLinearMappings.delete(issueId);
    console.warn('[LinearBridge] mapping recovered via updateIssue-only path');
    return true;
  } catch (err) {
    lastErr = err;
  }
  console.error('[LinearBridge] 로컬 mapping persist 복구 실패:', lastErr);
  return false;
}

export async function pushToLinear(
  store: SqliteIssueStore,
  issueId: string,
): Promise<string | null> {
  await waitForLinearBridgeInit();
  if (!linearClient) {
    console.warn('[LinearBridge] 클라이언트 미초기화');
    return null;
  }

  const issue = store.getIssue(issueId);
  if (!issue) return null;
  if (issue.linearId) return issue.linearId; // 이미 연결됨

  // In-process recovery: a prior create succeeded but local mapping failed.
  const pending = pendingLinearMappings.get(issueId);
  if (pending) {
    if (persistLinearMappingWithRetry(store, issueId, pending)) {
      console.log(`[LinearBridge] 이슈 ${issueId} → Linear ${pending.linearIdentifier} (recovered)`);
      return pending.linearId;
    }
    // Still unrecovered — return known linearId to avoid a duplicate create.
    return pending.linearId;
  }

  let mapping: { linearId: string; linearIdentifier: string; linearUrl: string };
  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(issue.status));

    const created = await linearClient.createIssue({
      teamId: linearTeamId,
      title: issue.title,
      description: issue.description || undefined,
      priority: mapPriorityToLinear(issue.priority),
      stateId,
    });

    const linearIssue = await created.issue;
    if (!linearIssue) return null;

    mapping = {
      linearId: linearIssue.id,
      linearIdentifier: linearIssue.identifier,
      linearUrl: linearIssue.url,
    };
  } catch (err) {
    console.error('[LinearBridge] Linear 생성 실패:', err);
    return null;
  }

  // Remember the external id before local persist so retries cannot orphan-recreate.
  pendingLinearMappings.set(issueId, mapping);

  if (!persistLinearMappingWithRetry(store, issueId, mapping)) {
    // External issue exists; return its id so callers do not treat this as "not created".
    console.error(
      `[LinearBridge] Linear ${mapping.linearIdentifier} 생성됨 but local mapping incomplete for ${issueId}`,
    );
    return mapping.linearId;
  }

  console.log(`[LinearBridge] 이슈 ${issueId} → Linear ${mapping.linearIdentifier}`);
  return mapping.linearId;
}

/**
 * 상태 동기화: 로컬 상태 변경 → Linear 반영
 */
export async function syncStatusToLinear(
  store: SqliteIssueStore,
  issueId: string,
  newStatus: IssueStatus,
): Promise<boolean> {
  await waitForLinearBridgeInit();
  if (!linearClient) return false;

  const issue = store.getIssue(issueId);
  if (!issue?.linearId) return false;

  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(newStatus));
    await linearClient.updateIssue(issue.linearId, { stateId });
    console.log(`[LinearBridge] Linear 상태 업데이트: ${issue.linearIdentifier} → ${newStatus}`);
    return true;
  } catch (err) {
    console.error('[LinearBridge] 상태 동기화 실패:', err);
    return false;
  }
}

// ============ 매핑 유틸 ============

async function waitForLinearBridgeInit(): Promise<void> {
  if (linearInitPromise) {
    await linearInitPromise;
  }
}

function findByLinearId(store: SqliteIssueStore, linearId: string): Issue | null {
  return store.getIssueByLinearId(linearId);
}

async function mapLinearToLocal(
  linearIssue: any,
  projectId: string,
): Promise<{
  projectId: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
}> {
  const state = await linearIssue.state;
  const stateName = state?.name ?? 'Backlog';

  return {
    projectId,
    title: linearIssue.title,
    description: linearIssue.description ?? '',
    status: mapLinearStatusToLocal(stateName),
    priority: mapLinearPriorityToLocal(linearIssue.priority),
  };
}

function mapLinearStatusToLocal(stateName: string): IssueStatus {
  const map: Record<string, IssueStatus> = {
    'Backlog': 'backlog',
    'Todo': 'todo',
    'In Progress': 'in_progress',
    'In Review': 'in_review',
    'Done': 'done',
    'Cancelled': 'cancelled',
    'Canceled': 'cancelled',
  };
  return map[stateName] ?? 'backlog';
}

/**
 * Acceptable Linear workflow-state names for a local status, best first.
 *
 * A list rather than a single name because the state name is configured per
 * workspace, not fixed by the API. Linear's own default is the US spelling
 * "Canceled", so emitting only "Cancelled" made resolveLinearStateId throw for
 * every team on the default — that status never synced outward for them.
 */
export function mapStatusToLinear(status: IssueStatus): string[] {
  const map: Record<IssueStatus, string[]> = {
    backlog: ['Backlog'],
    todo: ['Todo', 'To Do'],
    in_progress: ['In Progress'],
    in_review: ['In Review'],
    done: ['Done', 'Completed'],
    cancelled: ['Cancelled', 'Canceled'],
  };
  return map[status];
}

function mapLinearPriorityToLocal(priority: number): IssuePriority {
  // Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
  const map: Record<number, IssuePriority> = {
    0: 'none',
    1: 'urgent',
    2: 'high',
    3: 'medium',
    4: 'low',
  };
  return map[priority] ?? 'medium';
}

function mapPriorityToLinear(priority: IssuePriority): number {
  const map: Record<IssuePriority, number> = {
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
    none: 0,
  };
  return map[priority];
}

/**
 * Resolve the first candidate state name that this team actually defines.
 *
 * Matching is case-insensitive and tries each candidate in order, so a
 * workspace that spells a state differently still syncs instead of failing.
 */
async function resolveLinearStateId(candidates: string[]): Promise<string> {
  if (!linearClient) throw new Error('Linear 클라이언트 미초기화');

  const team = await linearClient.team(linearTeamId);
  const states = await team.states();

  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase();
    const state = states.nodes.find((s: any) => String(s.name).toLowerCase() === wanted);
    if (state) return state.id;
  }

  const available = states.nodes.map((s: any) => s.name).join(', ');
  throw new Error(
    `Linear 상태 "${candidates.join('" / "')}" 없음 (팀에 정의된 상태: ${available})`,
  );
}

export function isLinearBridgeReady(): boolean {
  return linearClient !== null;
}
