import { LinearClient } from '@linear/sdk';
import { createHash } from 'node:crypto';
import { formatAutomationComment, formatPairDialogue, type CommentSection } from './format.js';
import type { PairCompleteStats } from '../automation/taskSource.js';
import {
  clearLinearCache,
  getClient,
  isLinearInitialized,
  teamId,
  teamIds,
  updateIssueState,
} from './linear.js';
import { safeConsole as console } from '../support/safeLog.js';

/**
 * Add a comment to an issue
 */
export async function addComment(
  issueId: string,
  body: string,
  commentId?: string,
): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();

  try {
    await linear.createComment({
      id: commentId,
      issueId,
      body,
    });
  } catch (error) {
    if (commentId) {
      try {
        const existing = await linear.comment({ id: commentId });
        const existingIssue = await existing.issue;
        // The stable id is the identity guarantee, not a byte-for-byte body
        // match — callers like buildTaskStateSyncComment bake in a timestamp,
        // which by construction can never match a prior call's body (AGT-4051,
        // same shape as createSubIssue's AGT-4048 fix).
        if (existingIssue?.id === issueId) {
          if (existing.body !== body) {
            console.warn(`[Linear] Idempotent comment ${commentId} body differs from this retry's content — converging on the existing artifact anyway`);
          }
          return;
        }
      } catch {
        // Preserve the original create error if artifact reconciliation fails.
      }
    }
    throw error;
  }
}

/** Stable UUIDv4-shaped Linear comment id for an outbox idempotency key. Linear
 * enforces comment-id uniqueness, making concurrent stale deliveries converge
 * remotely as well as locally. */
export function effectCommentId(marker: string): string {
  const bytes = createHash('sha256').update(`openswarm-effect:${marker}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Log a HALT event (low confidence) as a comment on a Linear issue */
export async function logHalt(
  issueId: string, sessionId: string, confidence: number, iteration: number, reason: string,
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'HALT — low confidence',
    summary: `Confidence ${confidence}% is below threshold on attempt #${iteration}; manual input needed.`,
    sections: [
      { label: 'Reason', body: reason },
      { label: 'Suggested next step', body: ['Review the task requirements', 'Provide more context', 'Break it into smaller sub-tasks'] },
    ],
    meta: { Session: sessionId, Confidence: `${confidence}%`, Attempt: `#${iteration}` },
  }));
}

/** Log work start comment for an agent */
export async function logWorkStart(issueId: string, sessionName: string): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Work started',
    meta: { Agent: sessionName },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log progress comment for an agent
 */
export async function logProgress(
  issueId: string,
  sessionName: string,
  progress: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Progress update',
    summary: progress,
    meta: { Agent: sessionName },
  }));
}

/**
 * Log work completion comment for an agent
 */
export async function logWorkComplete(
  issueId: string,
  sessionName: string,
  summary?: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Work complete',
    summary: summary?.trim() || undefined,
    meta: { Agent: sessionName },
  }));
  await updateIssueState(issueId, 'Done');
}

/**
 * Log blocked comment for an agent
 */
export async function logBlocked(
  issueId: string,
  sessionName: string,
  reason: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Blocked — user intervention required',
    sections: [{ label: 'Reason', body: reason }],
    meta: { Agent: sessionName },
  }));
  // Use 'Todo' instead of 'Blocked' (Blocked state may not exist in team workflow)
  await updateIssueState(issueId, 'Todo');
}

/**
 * Label applied to issues the autonomous loop has given up on after exhausting
 * its retries. The heartbeat filter excludes issues carrying this label so they
 * are never retried automatically — the user removes it (or moves the issue back
 * to an active state) to request a retry.
 */
export const STUCK_LABEL = 'swarm:stuck';

/** Resolve a team label id by name, creating the label if it does not exist. */
async function ensureTeamLabel(
  linear: LinearClient,
  resolvedTeamId: string,
  name: string,
): Promise<string | undefined> {
  const team = await linear.team(resolvedTeamId);
  const labels = await team.labels();
  const existing = labels.nodes.find((l) => l.name === name);
  if (existing) return existing.id;
  try {
    const created = await linear.createIssueLabel({ teamId: resolvedTeamId, name, color: '#d4504f' });
    const label = await created.issueLabel;
    return label?.id;
  } catch (err) {
    console.error(`[Linear] Failed to create label "${name}":`, err);
    return undefined;
  }
}

/** Add a label (by name) to an issue without removing its existing labels. */
export async function addIssueLabel(issueId: string, labelName: string): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();
  try {
    const issue = await linear.issue(issueId);
    const issueTeam = await issue.team;
    const resolvedTeamId = issueTeam?.id ?? teamIds[0] ?? teamId;
    const labelId = await ensureTeamLabel(linear, resolvedTeamId, labelName);
    if (!labelId) return;
    const current = await issue.labels();
    const ids = new Set(current.nodes.map((l) => l.id));
    if (ids.has(labelId)) return; // already labelled
    ids.add(labelId);
    await linear.updateIssue(issueId, { labelIds: Array.from(ids) });
    clearLinearCache();
  } catch (err) {
    console.error(`[Linear] Failed to add label "${labelName}" to ${issueId}:`, err);
  }
}

/** Remove a label (by name) from an issue if present. */
export async function removeIssueLabel(issueId: string, labelName: string): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();
  try {
    const issue = await linear.issue(issueId);
    const current = await issue.labels();
    const remaining = current.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
    if (remaining.length === current.nodes.length) return; // label not present
    await linear.updateIssue(issueId, { labelIds: remaining });
    clearLinearCache();
  } catch (err) {
    console.error(`[Linear] Failed to remove label "${labelName}" from ${issueId}:`, err);
  }
}

/**
 * Mark an issue as permanently stuck: automatic retries are exhausted, so the
 * heartbeat must NOT re-attempt it. Adds the durable {@link STUCK_LABEL} (survives
 * daemon restarts, unlike the in-memory failure counters) and parks the issue in
 * Backlog — a non-recoverable state, so the heartbeat's recovery branch won't
 * silently un-block it. Moving the issue back to Todo is the explicit signal to
 * retry, and the heartbeat strips the label itself on that recovery.
 *
 * Todo is named because it is the one action that works in every mode. Under the
 * durable ledger, exhausting retries also parks the run in NEEDS_HUMAN and
 * `filterAlreadyProcessed` returns on that state before it ever reaches the label
 * check — so there, removing the label alone does nothing, and 'In Progress' cannot
 * help either, being a state the pipeline writes itself when it claims a task
 * (AGT-4155). Only Todo or an explicit dispatch from the issue board / `work` CLI
 * retry a parked run. The legacy non-primary path still recovers a labelled issue
 * from any active state, and Todo satisfies that one too.
 */
export async function logStuck(
  issueId: string,
  sessionName: string,
  reason: string,
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Stuck — automatic retries exhausted',
    sections: [
      { label: 'Reason', body: reason },
      { label: 'How to retry', body: [
        'Move this issue back to Todo — the `' + STUCK_LABEL + '` label is cleared automatically on retry.',
        'The agent will not retry on its own until then.',
      ] },
    ],
    meta: { Agent: sessionName },
  }));
  await addIssueLabel(issueId, STUCK_LABEL);
  await updateIssueState(issueId, 'Backlog');
}

// Pair Mode Linear Integration

/**
 * Log pair session start comment
 */
export async function logPairStart(
  issueId: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Pair session started',
    summary: 'Starting work in Worker/Reviewer pair mode.',
    meta: { Session: sessionId, Project: projectPath },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session review start comment
 */
export async function logPairReview(
  issueId: string,
  sessionId: string,
  attempt: number
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Reviewing',
    summary: "Reviewer is evaluating the Worker's output.",
    meta: { Session: sessionId, Attempt: `#${attempt}` },
  }));
  await updateIssueState(issueId, 'In Review');
}

/**
 * Log pair session revision request comment
 */
export async function logPairRevision(
  issueId: string,
  sessionId: string,
  feedback: string,
  issues: string[]
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Revision requested',
    summary: 'Worker will proceed with revisions.',
    sections: [
      { label: 'Feedback', body: feedback },
      { label: 'Issues', body: issues.length > 0 ? issues : ['(none)'] },
    ],
    meta: { Session: sessionId },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session completion comment
 */
export async function logPairComplete(
  issueId: string,
  sessionId: string,
  stats: PairCompleteStats
): Promise<void> {
  const durationStr = stats.duration < 60
    ? `${stats.duration}s`
    : `${Math.floor(stats.duration / 60)}m ${stats.duration % 60}s`;

  const sections: CommentSection[] = [];

  if (stats.testResults) {
    const { passed, failed, coverage, failedTests } = stats.testResults;
    const totalTests = passed + failed;
    const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0';
    const lines = [`Passed ${passed}/${totalTests} (${passRate}%)`];
    if (coverage !== undefined) lines.push(`Coverage ${coverage.toFixed(1)}%`);
    if (failed > 0 && failedTests && failedTests.length > 0) {
      const extra = failedTests.length > 3 ? ` (+${failedTests.length - 3} more)` : '';
      lines.push(`Failed: ${failedTests.slice(0, 3).join(', ')}${extra}`);
    }
    sections.push({ label: 'Tests', body: lines });
  }

  if (stats.remainingWork) {
    sections.push({ label: 'Remaining work', body: stats.remainingWork.trim() });
  }

  sections.push({
    label: 'Changed files',
    body: stats.filesChanged.length > 0
      ? stats.filesChanged.slice(0, 10).map((f) => `\`${f}\``)
      : ['(none)'],
  });

  if (stats.workerCommands && stats.workerCommands.length > 0) {
    sections.push({ label: 'Commands run', body: stats.workerCommands.slice(0, 3).map((c) => `\`${c}\``) });
  }
  if (stats.prUrl) {
    sections.push({ label: 'Pull request', body: stats.prUrl });
  }

  const comment = formatAutomationComment({
    heading: stats.prUrl ? 'Ready for review' : 'Task complete',
    // The exchange itself, as a conversation between named agents (AGT-4019).
    summary: formatPairDialogue(stats) ?? stats.workerSummary?.trim() ?? undefined,
    sections,
    meta: {
      Session: sessionId,
      Iterations: stats.attempts,
      Duration: durationStr,
      Files: stats.filesChanged.length,
    },
    attribution: 'Worker/Reviewer/Tester pipeline',
  }) + (stats.idempotencyMarker ? `\n\n<!-- openswarm-effect:${stats.idempotencyMarker} -->` : '');
  await addComment(issueId, comment, stats.idempotencyMarker ? effectCommentId(stats.idempotencyMarker) : undefined);
  const accepted = await updateIssueState(issueId, 'Done');
  if (!accepted) throw new Error(`Linear refused Done transition for ${issueId}`);
}

/**
 * Log pair session failure/rejection comment
 */
export async function logPairFailed(
  issueId: string,
  sessionId: string,
  reason: 'rejected' | 'max_attempts' | 'error',
  details: string
): Promise<void> {
  const reasonText = {
    rejected: 'Reviewer rejected the work',
    max_attempts: 'Maximum retry attempts exceeded',
    error: 'An error occurred',
  }[reason];

  await addComment(issueId, formatAutomationComment({
    heading: 'Work failed — manual intervention required',
    summary: reasonText,
    sections: [{ label: 'Details', body: details }],
    meta: { Session: sessionId },
  }));
  // Don't change state on failure; let the user decide
}
