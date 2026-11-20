// Created: 2026-11-21
// Purpose: the pre-claim hold — no worker starts on an issue whose draft declined it or could not be made (AGT-4784)
// Dependencies: readinessGate (verdict rule), draftScope (decline bar), draftGrooming (shared decline comment/marker),
//               dispatchFingerprint (daemon-comment recognition)
// Test Status: readinessGate.test.ts, draftCache.test.ts

import { isScopeDeclined, type DraftScopeVerdict } from '../agents/draftScope.js';
import { evaluateReadiness, type ReadinessTask } from './readinessGate.js';
import { scopeDeclineComment, scopeDeclineMarker } from './draftGrooming.js';
import { isDaemonComment } from './dispatchFingerprint.js';

// The hold used to run only for a project with a standing goal, and an issue whose draft call failed
// kept going with no verdict at all: the gap that let decision-pending and human-only issues reach a
// worker. Every project now gets a verdict, and "no verdict because the call failed" holds the
// issue for this heartbeat instead of reading as "in scope".

type DraftLike = { scope?: DraftScopeVerdict; failed?: boolean };

/** The declined scope kind of a draft, for any project (goal or not); undefined when it says nothing against the issue. */
export function draftScopeVerdict(draft: DraftLike | undefined): string | undefined {
  return draft && isScopeDeclined(draft.scope) ? draft.scope.kind : undefined;
}

/**
 * Run the pre-admission draft and record whether it failed: it threw, or every adapter failed
 * (`draft.failed`). `resolveTaskFileScope` swallows the throw, so this is the only place that sees
 * it. Undefined (drafting disabled) is not a failure. A throw is rethrown unchanged.
 */
export async function recordDraftOutcome<D extends { failed?: boolean }>(
  failed: Set<string>,
  key: string,
  run: () => Promise<D | undefined>,
): Promise<D | undefined> {
  try {
    const draft = await run();
    if (draft?.failed) failed.add(key);
    else failed.delete(key);
    return draft;
  } catch (err) {
    failed.add(key);
    throw err;
  }
}

export type PreClaimDecision =
  | { hold: false }
  | { hold: true; reason: string; scope?: DraftScopeVerdict };

/**
 * Whether the candidate may be claimed. An explicit dispatch is the operator's decision and always
 * passes. A failed draft holds (`draft_unavailable`): the verdict is unknown, not "in scope". A
 * confident decline holds with its kind. Anything else passes.
 */
export function preClaimDecision(
  task: ReadinessTask & { preAdmissionDraft?: DraftLike },
  draftFailed: boolean,
): PreClaimDecision {
  if (task.explicitDispatch) return { hold: false };
  if (draftFailed) return { hold: true, reason: 'draft_unavailable' };
  const draft = task.preAdmissionDraft;
  const decision = evaluateReadiness(task, { verdict: draftScopeVerdict(draft), includeBacklog: true });
  return decision.claim || !draft?.scope ? { hold: false } : { hold: true, reason: decision.reason, scope: draft.scope };
}

type HoldTask = ReadinessTask & { id: string; issueId?: string; preAdmissionDraft?: DraftLike };

export interface PreClaimHoldDeps<T extends HoldTask> {
  log: (line: string) => void;
  label: (task: T) => string;
  /** Post the decline comment (the worker-start gate's marker, so the two never double-post). Absent = hold silently. */
  comment?: (issueId: string, body: string, marker: string) => Promise<void>;
}

// One log line per issue for a failed draft, until a draft for it succeeds again; one decline comment
// per issue and marker per process (the tracker dedupes the marker too, but each repeat costs a failed create).
const loggedDraftFailures = new Set<string>();
const postedDeclines = new Set<string>();

/** Test hook. */
export function resetPreClaimHoldMemo(): void {
  loggedDraftFailures.clear();
  postedDeclines.clear();
}

/** The candidates that may be claimed this heartbeat; the rest are held, logged and (for a decline) commented on once. */
export async function holdBeforeClaim<T extends HoldTask, C extends { task: T }>(
  group: readonly C[],
  draftFailed: ReadonlySet<string>,
  deps: PreClaimHoldDeps<T>,
): Promise<C[]> {
  const kept: C[] = [];
  for (const candidate of group) {
    const { task } = candidate;
    const decision = preClaimDecision(task, draftFailed.has(task.id));
    if (!draftFailed.has(task.id)) loggedDraftFailures.delete(task.id);
    if (!decision.hold) {
      kept.push(candidate);
      continue;
    }
    if (!decision.scope) {
      if (!loggedDraftFailures.has(task.id)) deps.log(`⏭ Not claimed this heartbeat: ${deps.label(task)} — the draft failed, so its readiness is unknown`);
      loggedDraftFailures.add(task.id);
      continue;
    }
    deps.log(`⏭ Not claimed: ${deps.label(task)} — ${decision.reason}: ${decision.scope.reason}`);
    // The marker hashes kind and reason only, so two issues declined for the same reason share it.
    const marker = scopeDeclineMarker(decision.scope);
    const memoKey = `${task.issueId}\0${marker}`;
    if (!task.issueId || !deps.comment || postedDeclines.has(memoKey)) continue;
    try {
      await deps.comment(task.issueId, scopeDeclineComment(decision.scope), marker);
      postedDeclines.add(memoKey);
    } catch (err) {
      console.warn('[AutonomousRunner] Readiness comment failed:', err instanceof Error ? err.message : err);
    }
  }
  return kept;
}

// ---- Releasing a held issue when a person answers ----

/** Comments a person wrote: the daemon signs every comment it posts (`isDaemonComment`). */
export function humanCommentCount(comments: ReadonlyArray<{ body: string }>): number {
  return comments.filter((c) => c.body.trim() && !isDaemonComment(c.body)).length;
}

/** What a declined draft is keyed on besides its text: the issue's updatedAt and its human comment count. */
export interface IssueActivity {
  updatedAt?: number;
  humanComments?: number;
  /** When the daemon last commented, so a bump its own decline comment caused is not read as an answer. */
  lastDaemonCommentAt?: number;
}

export function draftActivityStamp(activity: IssueActivity): string {
  return `${activity.updatedAt ?? '-'}:${activity.humanComments ?? '-'}`;
}

type ActivityTask = { issueId?: string; trackerUpdatedAt?: number };
type CommentReader = (issueId: string) => Promise<ReadonlyArray<{ body: string; createdAt?: string }>>;

/** The issue's activity now, or undefined when its comments cannot be read right now. */
export async function currentDraftActivity(task: ActivityTask, readComments?: CommentReader): Promise<IssueActivity | undefined> {
  if (!readComments || !task.issueId) return { updatedAt: task.trackerUpdatedAt };
  try {
    const comments = await readComments(task.issueId);
    const daemonTimes = comments.filter((c) => isDaemonComment(c.body) && c.createdAt).map((c) => Date.parse(c.createdAt!)).filter(Number.isFinite);
    return {
      updatedAt: task.trackerUpdatedAt,
      humanComments: humanCommentCount(comments),
      lastDaemonCommentAt: daemonTimes.length ? Math.max(...daemonTimes) : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a cached draft may be reused. Only a decline is checked: it is the one that holds an issue,
 * and an answer given as a comment changes neither title nor description. Any other draft keeps the
 * text-only key — adding activity to it would re-draft on the daemon's own writes (AGT-4300).
 *
 * - A decline stored without a stamp misses.
 * - Activity that cannot be read right now keeps the hold: holding is the safe side and costs no model call.
 * - A new human comment releases the hold.
 * - A moved updatedAt releases it too, unless the daemon commented after the stamp was taken: that bump
 *   is its own decline comment, so the new value is absorbed into the stored stamp (`persist`) and the
 *   hold stays. Without this the daemon's comment would re-draft the issue, and a re-worded reason
 *   would post a second comment.
 */
export async function cachedDraftReusable(
  entry: { draft: DraftLike; activity?: string },
  current: () => Promise<IssueActivity | undefined>,
  persist?: (stamp: string) => void,
): Promise<boolean> {
  if (!isScopeDeclined(entry.draft.scope)) return true;
  if (!entry.activity) return false;
  const now = await current();
  if (!now) return true;
  const stamp = draftActivityStamp(now);
  if (stamp === entry.activity) return true;
  const [storedUpdated, storedHuman] = entry.activity.split(':');
  if (String(now.humanComments ?? '-') !== storedHuman) return false;
  const storedAt = Number(storedUpdated);
  if (!Number.isFinite(storedAt) || now.lastDaemonCommentAt === undefined || now.lastDaemonCommentAt <= storedAt) return false;
  entry.activity = stamp;
  persist?.(stamp);
  return true;
}
