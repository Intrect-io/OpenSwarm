import type { DraftAnalysis, DraftPeerIssue } from '../agents/draftAnalyzer.js';
import { isScopeDeclined } from '../agents/draftScope.js';
import { createHash } from 'node:crypto';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { findOpenPRFileOverlaps } from '../support/worktreeManager.js';
import { createGhOpenPrLookup, type OpenLinkedPrLookup } from './backlogGrooming.js';
import type { ITaskSource } from './taskSource.js';

/** Duplicate marks draft grooming may attempt per rolling hour, across all tasks (AGT-4603). */
export const DRAFT_DUPLICATE_CAP_PER_HOUR = 5;
const DRAFT_DUPLICATE_WINDOW_MS = 60 * 60 * 1000;
let draftDuplicateAttempts: number[] = [];

/** Test hook: forget every duplicate mark counted against the hourly cap. */
export function resetDraftDuplicateBudget(): void {
  draftDuplicateAttempts = [];
}

/** Synchronously claims a cap slot (so concurrent callers cannot overshoot); returns its timestamp, or null when the cap is used up. */
function takeDraftDuplicateSlot(): number | null {
  const now = Date.now();
  draftDuplicateAttempts = draftDuplicateAttempts.filter(at => now - at < DRAFT_DUPLICATE_WINDOW_MS);
  if (draftDuplicateAttempts.length >= DRAFT_DUPLICATE_CAP_PER_HOUR) return null;
  draftDuplicateAttempts.push(now);
  return now;
}

/** Gives back one slot claimed at `at` when markDuplicate was never attempted. */
function releaseDraftDuplicateSlot(at: number): void {
  const index = draftDuplicateAttempts.indexOf(at);
  if (index >= 0) draftDuplicateAttempts.splice(index, 1);
}

export function projectDraftPeers(task: TaskItem, peers?: TaskItem[]): DraftPeerIssue[] | undefined {
  return peers
    ?.filter(peer =>
      (peer.issueId || peer.id) !== (task.issueId || task.id)
      && (
        (task.linearProject?.id && peer.linearProject?.id === task.linearProject.id)
        || (!task.linearProject?.id && peer.linearProject?.name === task.linearProject?.name)
      )
    )
    .map(peer => ({
      issueId: peer.issueId || peer.id,
      identifier: peer.issueIdentifier,
      title: peer.title,
      description: peer.description,
      state: peer.linearState,
      createdAt: peer.createdAt,
    }));
}

/** Stable per kind and reason, so the claim-time gate and this one leave a single comment between them. */
export function scopeDeclineMarker(scope: { kind: string; reason: string }): string {
  return `draft-scope:${createHash('sha256').update(`${scope.kind}:${scope.reason}`).digest('hex').slice(0, 24)}`;
}

export function scopeDeclineComment(scope: { kind: string; reason: string; evidence: string[] }): string {
  return `Draft grooming did not start a worker for this issue: \`${scope.kind}\`.\n\nReason: ${scope.reason}\n\nEvidence:\n${scope.evidence.map((item) => `- ${item}`).join('\n')}\n\n`
    + 'Change the issue so it names work this project goal can act on, then move it to Todo to run it.';
}

export async function applyDraftGates(options: {
  task: TaskItem;
  projectPath: string;
  draft: DraftAnalysis;
  peers?: TaskItem[];
  source: ITaskSource | null;
  worktreeMode?: boolean;
  /** Issues a worker currently holds; only their PRs reserve files. (AGT-4097) */
  activeWorkerIssues?: readonly string[];
  /** A project goal is set, so the draft's scope verdict may stop the task. (AGT-4662) */
  goalScopeGate?: boolean;
  /** Open linked PRs of the task; defaults to the gh-backed lookup. Any URL or a throw keeps the worker. (AGT-4603) */
  openPrLookup?: OpenLinkedPrLookup;
}): Promise<PipelineResult | null> {
  const { task, draft, peers, source } = options;
  const duplicateTarget = peers?.find(peer => (peer.issueId || peer.id) === draft.duplicateOfIssueId);
  const evidence = draft.duplicateEvidence ?? [];
  if (task.issueId && duplicateTarget && duplicateTarget.createdAt < task.createdAt
    && (draft.duplicateConfidence ?? 0) >= 0.9 && evidence.length >= 2 && source?.markDuplicate) {
    const canonicalId = duplicateTarget.issueId || duplicateTarget.id;
    const label = task.issueIdentifier ?? task.issueId;
    const canonicalLabel = duplicateTarget.issueIdentifier ?? canonicalId;
    const lookupOpenPrs = options.openPrLookup ?? createGhOpenPrLookup(
      options.projectPath, task.issueIdentifier ? { [task.issueId]: task.issueIdentifier } : undefined);
    const marked = await markDraftDuplicate(source, {
      issueId: task.issueId, identifier: task.issueIdentifier, canonicalId, lookupOpenPrs,
      label: `${label} -> ${canonicalLabel}`,
      body: `Draft grooming is marking this issue as a duplicate of ${canonicalLabel}.\n\nReason: ${draft.duplicateReason ?? 'Same observable implementation.'}\n\nEvidence:\n${evidence.map(item => `- ${item}`).join('\n')}`,
    });
    if (marked) {
      console.log(`[AutonomousRunner] Draft grooming: ${label} duplicates ${canonicalLabel}`);
      return supersededResult('duplicate', draft.durationMs);
    }
  }

  // Decided before any worktree exists: a task no worker can usefully do here
  // should not cost a checkout, a worker run and two retries to find that out.
  // Opt-in per project, and only on a verdict that clears the duplicate gate's bar.
  if (options.goalScopeGate && isScopeDeclined(draft.scope)) {
    const { kind, reason } = draft.scope;
    console.log(`[AutonomousRunner] Draft scope gate: ${task.issueIdentifier ?? task.issueId} is ${kind} — ${reason}`);
    if (task.issueId && source?.kind === 'linear') {
      await source.addComment(task.issueId, scopeDeclineComment(draft.scope), scopeDeclineMarker(draft.scope));
    }
    return supersededResult('out_of_scope', draft.durationMs, `${kind}: ${reason}`);
  }

  if (options.worktreeMode && draft.relevantFiles.length > 0) {
    // An open PR reserves its files only while a worker is editing them.
    // `publishOnPark` publishes a run that stops for an operator, so its PR
    // outlives the worker by hours or days: the task first collided with its
    // own PR (AGT-4095) and then with every sibling's — seven such PRs held
    // cgf-portal's hot files for 7-12h, and each blocked attempt doubled the
    // backoff again. (AGT-4097)
    const overlaps = await findOpenPRFileOverlaps(
      options.projectPath,
      draft.relevantFiles,
      {
        selfIssueIdentifier: task.issueIdentifier ?? task.issueId,
        // Passed through as-is: undefined means the caller could not ask the
        // ledger, and every swarm PR keeps reserving. See findOpenPRFileOverlaps.
        activeIssueIdentifiers: options.activeWorkerIssues,
      },
    );
    if (overlaps.length > 0) {
      const reason = formatOpenPullRequestOverlap(overlaps);
      console.warn(`[AutonomousRunner] ${reason}`);
      // A recurring overlap is operational information, not a new finding on
      // every heartbeat. Linear's stable comment id makes this one comment per
      // exact PR/file fingerprint while a changed owner or file set is visible.
      if (task.issueId && source?.kind === 'linear') {
        const marker = `draft-overlap:${createHash('sha256').update(reason).digest('hex').slice(0, 24)}`;
        await source.addComment(
          task.issueId,
          `Draft grooming deferred this task because an open pull request owns its planned files.\n\n${reason}`,
          marker,
        );
      }
      return supersededResult('superseded', draft.durationMs, reason);
    }
  }
  return null;
}

/**
 * Safe duplicate path (AGT-4603): refuse while the task has an open linked PR
 * (or the lookup cannot tell), honour the hourly cap, then post the evidence
 * comment before the mark. Any refusal returns false so the worker runs.
 */
async function markDraftDuplicate(source: ITaskSource, mark: {
  issueId: string;
  identifier?: string;
  canonicalId: string;
  lookupOpenPrs: OpenLinkedPrLookup;
  label: string;
  body: string;
}): Promise<boolean> {
  const { issueId, canonicalId, label } = mark;
  if (!source.markDuplicate) return false;
  let openPrs: string[];
  try {
    openPrs = await mark.lookupOpenPrs({ issueId, identifier: mark.identifier });
  } catch (error) {
    console.warn(`[AutonomousRunner] Draft duplicate ${label} not marked: linked-PR lookup failed (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  if (openPrs.length > 0) {
    console.warn(`[AutonomousRunner] Draft duplicate ${label} not marked: open linked PR ${openPrs.join(', ')}`);
    return false;
  }
  const slot = takeDraftDuplicateSlot();
  if (slot === null) {
    console.warn(`[AutonomousRunner] Draft duplicate ${label} not marked: ${DRAFT_DUPLICATE_CAP_PER_HOUR} duplicate marks already made this hour`);
    return false;
  }
  const marker = `draft-duplicate:${createHash('sha256').update(issueId + canonicalId).digest('hex').slice(0, 24)}`;
  try {
    await source.addComment(issueId, mark.body, marker);
  } catch (error) {
    releaseDraftDuplicateSlot(slot);
    console.warn(`[AutonomousRunner] Draft duplicate ${label} not marked: evidence comment failed (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  return source.markDuplicate(issueId, canonicalId);
}

function supersededResult(kind: string, durationMs: number, failureDetail?: string): PipelineResult {
  return {
    success: true, sessionId: `${kind}-${Date.now()}`, iterations: 0, totalDuration: durationMs,
    finalStatus: 'superseded', stages: [], failureDetail,
  };
}

function formatOpenPullRequestOverlap(overlaps: Array<{ url: string; files: string[] }>): string {
  const owners = overlaps
    .map(({ url, files }) => `${url}: ${[...files].sort().map(file => `\`${file}\``).join(', ')}`)
    .sort();
  return `Existing open PR owns planned files — skipping duplicate worker: ${owners.join('; ')}`;
}
