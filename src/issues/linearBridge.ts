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

  const states = options?.states ?? ['Todo', 'In Progress', 'In Review', 'Backlog'];
  const limit = options?.limit ?? 50;

  const team = await linearClient.team(linearTeamId);
  const teamStates = await team.states();
  const stateNodes = teamStates.nodes.filter((s: any) =>
    states.includes(s.name),
  );

  let created = 0;
  let updated = 0;

  for (const state of stateNodes) {
    const issues = await state.issues({ first: limit });
    for (const linearIssue of issues.nodes) {
      const existing = findByLinearId(store, linearIssue.id);
      if (existing) {
        // 업데이트
        store.updateIssue(existing.id, {
          title: linearIssue.title,
          description: linearIssue.description,
          status: mapLinearStatusToLocal(linearIssue.state?.name ?? 'Todo'),
          priority: mapLinearPriorityToLocal(linearIssue.priority),
        });
        updated++;
      } else {
        // 새 이슈 생성
        const localIssue = mapLinearToLocal(linearIssue, projectId);
        store.createIssue(localIssue);
        created++;
      }
    }
  }

  return { created, updated };
}

/**
 * 로컬 → Linear: 로컬 이슈를 Linear에 생성
 *
 * Persists a durable "pending" event marker BEFORE the external Linear API
 * call. If the local mapping write (updateIssue + addEvent) fails after a
 * successful Linear creation, the pending marker survives and a subsequent
 * sync/reconcile can discover the orphaned Linear issue and complete the
 * mapping — preventing duplicate external issue creation.
 */
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

  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(issue.status));

    // Persist a durable "pending" marker BEFORE the external call so that a
    // failure after Linear creation but before the mapping write leaves a
    // recoverable record. A later sync/reconcile can look up the Linear issue
    // by this marker and complete the mapping instead of silently duplicating
    // the externally created issue.
    store.addEvent(issueId, 'linked', {
      content: 'Linear 생성 시작 (pending)',
      newValue: 'pending',
    });

    const created = await linearClient.createIssue({
      teamId: linearTeamId,
      title: issue.title,
      description: issue.description || undefined,
      priority: mapPriorityToLinear(issue.priority),
      stateId,
    });

    const linearIssue = await created.issue;
    if (!linearIssue) return null;

    // 로컬 이슈에 Linear ID 연결. If this write throws, the pending marker
    // above is still durable, so the external issue is not orphaned.
    store.updateIssue(issueId, {
      linearId: linearIssue.id,
      linearIdentifier: linearIssue.identifier,
      linearUrl: linearIssue.url,
    });

    store.addEvent(issueId, 'linked', {
      content: `Linear에 생성: ${linearIssue.identifier}`,
      newValue: linearIssue.identifier,
    });

    console.log(`[LinearBridge] 이슈 ${issueId} → Linear ${linearIssue.identifier}`);
    return linearIssue.id;
  } catch (err) {
    console.error('[LinearBridge] Linear 생성 실패:', err);
    return null;
  }
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

function mapLinearToLocal(linearIssue: any, projectId: string): any {
  return {
    projectId,
    title: linearIssue.title,
    description: linearIssue.description,
    status: mapLinearStatusToLocal(linearIssue.state?.name ?? 'Todo'),
    priority: mapLinearPriorityToLocal(linearIssue.priority),
    source: 'linear',
    linearId: linearIssue.id,
    linearIdentifier: linearIssue.identifier,
    linearUrl: linearIssue.url,
  };
}

export function mapLinearStatusToLocal(stateName: string): IssueStatus {
  const lower = stateName.toLowerCase();
  if (lower === 'todo') return 'todo';
  if (lower === 'in progress') return 'in_progress';
  if (lower === 'in review') return 'in_review';
  if (lower === 'done') return 'done';
  if (lower === 'canceled' || lower === 'cancelled') return 'cancelled';
  if (lower === 'backlog') return 'backlog';
  return 'backlog';
}

export function mapStatusToLinear(status: IssueStatus): string[] {
  const map: Record<IssueStatus, string[]> = {
    backlog: ['Backlog'],
    todo: ['Todo'],
    in_progress: ['In Progress'],
    in_review: ['In Review'],
    done: ['Done'],
    cancelled: ['Canceled', 'Cancelled'],
  };
  return map[status] ?? ['Backlog'];
}

export function mapLinearPriorityToLocal(priority: number): IssuePriority {
  if (priority <= 1) return 'urgent';
  if (priority === 2) return 'high';
  if (priority === 3) return 'medium';
  return 'low';
}

export function mapPriorityToLinear(priority: IssuePriority): number {
  const map: Record<IssuePriority, number> = {
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
  };
  return map[priority] ?? 3;
}

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