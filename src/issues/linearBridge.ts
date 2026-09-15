// ============================================
// OpenSwarm - Linear ↔ Local Issue Bridge
// Created: 2026-04-03
// Purpose: Linear 이슈를 로컬 DB와 양방향 동기화 (optional)
// Dependencies: @linear/sdk, sqliteStore
// ============================================

import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue, IssueStatus, IssuePriority } from './schema.js';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  fsyncSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isProofCapableSpace,
  processAppearsAlive,
  processNamespaceId,
  sameProcessNamespace,
} from '../support/processLiveness.js';

// Linear SDK는 동적 import (Linear 미사용 시 로드 안 함)
let linearClient: any = null;
let linearTeamId: string = '';
let linearInitPromise: Promise<void> | null = null;

/** Per-local-issue in-process queue — serializes createOutboundIssue callers. */
const outboundQueues = new Map<string, Promise<unknown>>();

const OUTBOUND_CLAIM_DIR = join(homedir(), '.openswarm', 'linear-outbound-claims');
const CLAIM_STALE_MS = 600_000;

type OutboundClaim = { pid: number; token: string; ns?: string | null; issueId: string; createdAt: string };

function claimPathFor(issueId: string): string {
  // Sanitize to a single path segment.
  const safe = issueId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  return join(OUTBOUND_CLAIM_DIR, `${safe}.claim`);
}

function readClaim(path: string): OutboundClaim | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<OutboundClaim>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.token !== 'string') return null;
    return {
      pid: value.pid!,
      token: value.token,
      ns: value.ns === null ? null : typeof value.ns === 'string' ? value.ns : undefined,
      issueId: typeof value.issueId === 'string' ? value.issueId : '',
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    };
  } catch {
    return null;
  }
}

function releaseStaleOutboundClaim(path: string): boolean {
  if (!existsSync(path)) return false;
  const claim = readClaim(path);
  if (!claim) {
    try {
      if (Date.now() - statSync(path).mtimeMs > 30_000) {
        unlinkSync(path);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
  if (isProofCapableSpace(claim.ns ?? undefined) && sameProcessNamespace(claim.ns ?? undefined)) {
    if (!processAppearsAlive(claim.pid)) {
      try { unlinkSync(path); return true; } catch { return false; }
    }
    return false;
  }
  // Cross-namespace or unknown: age-based reclaim only.
  try {
    if (Date.now() - statSync(path).mtimeMs > CLAIM_STALE_MS) {
      unlinkSync(path);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Acquire a durable claim file for outbound Linear creation. Survives crashes:
 * a restarted process finds the claim, re-checks local linearId, and either
 * completes or reclaims after proving the prior owner is gone.
 */
async function withOutboundClaim<T>(issueId: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(OUTBOUND_CLAIM_DIR, { recursive: true });
  const path = claimPathFor(issueId);
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          token,
          ns: processNamespaceId() ?? null,
          issueId,
          createdAt: new Date().toISOString(),
        }), 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      releaseStaleOutboundClaim(path);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for outbound Linear claim: ${issueId}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      if (readClaim(path)?.token === token) unlinkSync(path);
    } catch { /* best-effort */ }
  }
}

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
 * Page size for the inbound sync cursor loop. Linear reliably serves pages of
 * 50; the sync limit is applied to the TOTAL across pages, not per page.
 */
const LINEAR_SYNC_PAGE_SIZE = 50;
/**
 * Hard page cap for one sync run (50 × 20 = 1000 issues). Bounds worst-case
 * API work when the workspace has far more matching issues than the limit:
 * the run stops deterministically and reports what it committed.
 */
export const LINEAR_SYNC_MAX_PAGES = 20;

/** One page of the Linear issue connection, adapted from the SDK response. */
export interface LinearIssuePage {
  nodes: any[];
  hasNextPage: boolean;
  endCursor?: string;
}

/** Durable outcome of an inbound sync run. */
export interface LinearSyncProgress {
  created: number;
  updated: number;
  /** True when the run stopped at the total limit or page cap with data left. */
  truncated: boolean;
  /** The error that aborted the run; everything before it is already committed. */
  failed?: Error;
}

/**
 * Drain a Linear issue connection page by page, applying each issue to the
 * local store. `maxItems` caps the TOTAL imported count across pages (never
 * per page). Termination is deterministic: total limit, page cap, or an
 * exhausted connection. A missing/repeated cursor aborts the run with an
 * explicit error instead of looping forever.
 *
 * Never throws: a per-issue failure (or cursor anomaly) is returned as
 * `failed` alongside the counts that were durably committed before it.
 */
export async function drainLinearIssuesToStore(
  store: SqliteIssueStore,
  projectId: string,
  fetchPage: (after: string | undefined) => Promise<LinearIssuePage>,
  maxItems: number,
): Promise<LinearSyncProgress> {
  let created = 0;
  let updated = 0;
  let after: string | undefined;

  try {
    for (let page = 0; page < LINEAR_SYNC_MAX_PAGES; page++) {
      const conn = await fetchPage(after);
      // Cursor sanity BEFORE applying: a response whose endCursor is absent or
      // identical to the cursor we just used re-served the same window — bail
      // instead of double-applying its nodes or looping forever. (AGT-3421)
      if (conn.hasNextPage === true && (!conn.endCursor || conn.endCursor === after)) {
        throw new Error(
          `Linear inbound sync pagination returned a ${conn.endCursor ? 'repeated' : 'missing'} cursor on page ${page + 1}`,
        );
      }
      for (const issue of conn.nodes) {
        // The limit is global: stop as soon as the total across all pages is met.
        if (created + updated >= maxItems) {
          return { created, updated, truncated: true };
        }
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

      if (conn.hasNextPage !== true) {
        return { created, updated, truncated: false };
      }
      after = conn.endCursor;
    }

    // Page cap exhausted while the connection still reported more pages.
    console.warn(`[LinearBridge] 페이지 상한 ${LINEAR_SYNC_MAX_PAGES}개 도달 — 이번 동기화는 여기서 멈춥니다.`);
    return { created, updated, truncated: true };
  } catch (err) {
    const failed = err instanceof Error ? err : new Error(String(err));
    // Partial failure: everything applied so far is durable — say so.
    console.error(
      `[LinearBridge] 동기화 중단 — 지금까지 커밋됨: created ${created}, updated ${updated}`,
      failed,
    );
    return { created, updated, truncated: false, failed };
  }
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

  const progress = await drainLinearIssuesToStore(
    store,
    projectId,
    async (after) => {
      const conn = await linearClient.issues({
        filter: {
          team: { id: { eq: linearTeamId } },
          state: { name: { in: states } },
        },
        first: LINEAR_SYNC_PAGE_SIZE,
        after,
        orderBy: 'updatedAt',
      });
      return {
        nodes: conn.nodes,
        hasNextPage: conn.pageInfo?.hasNextPage === true,
        endCursor: conn.pageInfo?.endCursor,
      };
    },
    limit,
  );

  if (progress.failed) {
    console.error('[LinearBridge] 동기화 실패:', progress.failed);
  } else {
    const truncatedNote = progress.truncated ? ` (limit ${limit} 도달)` : '';
    console.log(`[LinearBridge] 동기화 완료 — created: ${progress.created}, updated: ${progress.updated}${truncatedNote}`);
  }

  return { created: progress.created, updated: progress.updated };
}

/**
 * 로컬 → Linear: 로컬 이슈를 Linear에 생성 (durable claim + per-issue serialize)
 */
export async function pushToLinear(
  store: SqliteIssueStore,
  issueId: string,
): Promise<string | null> {
  return createOutboundIssue(store, issueId);
}

/**
 * Durable outbound Linear creation for a local issue.
 *
 * Two processes can both see `linearId` absent and both call createIssue —
 * producing duplicates. A claim file (wx) per local issue serializes creators
 * and survives a crash: a restarted process finds the claim, re-checks the
 * local row, and either finishes linking or retries under a fresh claim.
 */
export async function createOutboundIssue(
  store: SqliteIssueStore,
  issueId: string,
): Promise<string | null> {
  // In-process serialize: crash-surviving claim file alone does not serialize
  // two awaits in the same process that both pass the wx race.
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const prev = outboundQueues.get(issueId) ?? Promise.resolve();
  outboundQueues.set(issueId, prev.then(() => held, () => held));
  await prev;

  try {
    return await withOutboundClaim(issueId, async () => {
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

        const created = await linearClient.createIssue({
          teamId: linearTeamId,
          title: issue.title,
          description: issue.description || undefined,
          priority: mapPriorityToLinear(issue.priority),
          stateId,
        });

        const linearIssue = await created.issue;
        if (!linearIssue) return null;

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
    });
  } finally {
    unlock();
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
