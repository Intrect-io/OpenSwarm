import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { LinearIssueInfo } from '../core/types.js';
import { atomicWriteFile } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';
import { safeConsole as console } from '../support/safeLog.js';
import { formatAutomationComment } from './format.js';
import { addComment, effectCommentId, STUCK_LABEL } from './linearComments.js';
import {
  STUCK_ISSUES_QUERY,
  clearLinearCache,
  fetchRawIssues,
  getClient,
  getProjectInfo,
  isLinearInitialized,
  parseBlockerIdentifiers,
  teamId,
  teamIds,
  updateIssueState,
} from './linear.js';

// Daily issue creation limit
const DAILY_ISSUE_LIMIT = 10;
let dailyIssueCount = 0;
let lastResetDate: string = '';
const DAILY_ISSUE_STATE_FILE = process.env.OPENSWARM_DAILY_ISSUE_STATE_FILE
  || resolve(process.env.VITEST ? tmpdir() : homedir(), process.env.VITEST ? `openswarm-linear-quota-${process.pid}.json` : '.openswarm/linear-issue-quota.json');

async function reserveDailyIssue(): Promise<boolean> {
  return withFileLock(`${DAILY_ISSUE_STATE_FILE}.lock`, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let state = { date: today, count: 0 };
    try {
      const parsed = JSON.parse(await readFile(DAILY_ISSUE_STATE_FILE, 'utf8')) as Partial<typeof state>;
      if (parsed.date === today && Number.isSafeInteger(parsed.count) && (parsed.count ?? -1) >= 0) state = { date: today, count: parsed.count! };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (state.count >= DAILY_ISSUE_LIMIT) return false;
    state.count++;
    await atomicWriteFile(DAILY_ISSUE_STATE_FILE, JSON.stringify(state), 0o600);
    dailyIssueCount = state.count;
    lastResetDate = today;
    return true;
  });
}

async function releaseDailyIssue(): Promise<void> {
  await withFileLock(`${DAILY_ISSUE_STATE_FILE}.lock`, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let count = 0;
    try {
      const parsed = JSON.parse(await readFile(DAILY_ISSUE_STATE_FILE, 'utf8')) as { date?: string; count?: number };
      if (parsed.date === today && Number.isSafeInteger(parsed.count)) count = Math.max(0, (parsed.count ?? 0) - 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicWriteFile(DAILY_ISSUE_STATE_FILE, JSON.stringify({ date: today, count }), 0o600);
    dailyIssueCount = count;
    lastResetDate = today;
  });
}

/**
 * Remaining issue creation quota for today
 */
export function getRemainingDailyIssues(): number {
  resetDailyCounterIfNeeded();
  return Math.max(0, DAILY_ISSUE_LIMIT - dailyIssueCount);
}

/**
 * Number of issues created today
 */
export function getDailyIssueCount(): number {
  resetDailyCounterIfNeeded();
  return dailyIssueCount;
}

/**
 * Reset daily counter on date change
 */
function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== lastResetDate) {
    dailyIssueCount = 0;
    lastResetDate = today;
  }
}

/**
 * Outcome of an issue lookup, separating "this issue does not exist" from "the
 * lookup could not be performed".
 *
 * `getIssue` collapses both into `null`, which reads as "no such issue" at
 * every call site. An expired Linear token then surfaced to the operator as
 * `skipped: not found` on dispatch — a report that points at the issue instead
 * of at the credential that actually failed.
 */
export type IssueLookup =
  | { ok: true; issue: LinearIssueInfo | null }
  | { ok: false; error: string };

/**
 * Get a specific issue by ID or identifier, reporting lookup failures instead
 * of folding them into a missing issue. Prefer this over `getIssue` wherever
 * the distinction reaches a human.
 */
export async function lookupIssue(issueIdOrIdentifier: string): Promise<IssueLookup> {
  if (!isLinearInitialized()) return { ok: false, error: 'Linear client is not initialized' };
  try {
    return { ok: true, issue: await fetchIssue(issueIdOrIdentifier) };
  } catch (error) {
    // Fixed first argument: the id is user-supplied (reachable from the
    // /api/work HTTP surface), and console's printf-style formatting must
    // never receive a tainted format string (CodeQL js/tainted-format-string).
    console.error('[Linear] getIssue error:', issueIdOrIdentifier, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Get a specific issue by ID or identifier
 */
export async function getIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const result = await lookupIssue(issueIdOrIdentifier);
  return result.ok ? result.issue : null;
}

async function fetchIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  {
    // Check if it's an identifier format (e.g., LIN-123)
    const isIdentifier = /^[A-Z]+-\d+$/.test(issueIdOrIdentifier);

    let issue;
    if (isIdentifier) {
      // Search by identifier - match both team key and number.
      const [teamKey, numPart] = issueIdOrIdentifier.split('-');
      const issueNumber = parseInt(numPart, 10);

      const issues = await linear.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { eq: issueNumber },
        },
        first: 1,
      });
      issue = issues.nodes[0];
    } else {
      // Look up directly by ID
      issue = await linear.issue(issueIdOrIdentifier);
    }

    if (!issue) return null;

    const [comments, labels, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      getProjectInfo(issue),
    ]);

    // Blockers from BOTH sources. The bulk (slim) path only parses prose;
    // this single-issue path can afford the structured-relations call, and
    // `openswarm work`'s unresolved-blocker gate depends on it — without
    // this, direct-id dispatch never saw any blocker at all.
    const blockedBy = new Set<string>();
    try {
      const inverse = await issue.inverseRelations();
      for (const rel of inverse.nodes) {
        if (rel.type !== 'blocks') continue;
        const blocker = await rel.issue;
        if (blocker?.id && blocker.id !== issue.id) blockedBy.add(blocker.id);
      }
    } catch {
      // relations unavailable — prose below still covers the common case
    }
    for (const ident of parseBlockerIdentifiers(issue.description ?? undefined)) {
      if (ident.toUpperCase() !== issue.identifier.toUpperCase()) blockedBy.add(ident);
    }

    const issueState = await issue.state;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? undefined,
      state: issueState?.name ?? 'Unknown',
      stateType: issueState?.type ?? undefined,
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
      blockedBy: blockedBy.size > 0 ? [...blockedBy] : undefined,
      createdAt: issue.createdAt instanceof Date ? issue.createdAt.toISOString() : undefined,
      updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : undefined,
    };
  }
}

/**
 * Create a new issue (with daily limit enforcement)
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = [],
  options?: { bypassLimit?: boolean; projectId?: string }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  const linear = getClient();

  // Resolve a single team UUID. Multi-team configs hold a comma-joined list in the
  // module `teamId` (e.g. "uuid1,uuid2"), which is NOT a valid UUID for the API.
  // Prefer the given project's team, else the first configured team. (INT-2210)
  let resolvedTeamId = teamIds[0] ?? teamId;
  if (options?.projectId) {
    try {
      const proj = await linear.project(options.projectId);
      const projTeam = (await proj.teams()).nodes[0]; // a project can span teams; take the first
      if (projTeam?.id) resolvedTeamId = projTeam.id;
    } catch {
      /* project/team lookup failed → keep teamIds[0] fallback */
    }
  }

  // Look up label IDs
  const team = await linear.team(resolvedTeamId);
  const teamLabels = await team.labels();
  const labelIds = labels
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const reserved = options?.bypassLimit ? false : await reserveDailyIssue();
  if (!options?.bypassLimit && !reserved) {
    return { error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please try again tomorrow.` };
  }
  let issuePayload;
  try {
    issuePayload = await linear.createIssue({
      teamId: resolvedTeamId,
      title,
      description,
      labelIds,
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    });
  } catch (error) {
    if (reserved) await releaseDailyIssue();
    throw error;
  }

  const issue = await issuePayload.issue;
  if (!issue) {
    if (reserved) await releaseDailyIssue();
    throw new Error('Failed to create issue');
  }
  const stateName = (await issue.state)?.name ?? 'Unknown';

  // Clear cache after mutation
  clearLinearCache();

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? undefined,
    state: stateName,
    priority: issue.priority,
    labels,
    comments: [],
  };
}

/**
 * Create a sub-issue (for Planner decomposition)
 * - Creates as a child of the parent issue via parentId
 * - Exempt from daily limit (auto-decomposition is required work)
 */
export async function createSubIssue(
  parentId: string,
  title: string,
  description: string,
  options?: {
    priority?: number;  // 1=Urgent, 2=High, 3=Normal, 4=Low
    labels?: string[];
    projectId?: string;
    estimatedMinutes?: number;
    /** Stable UUID v4 for crash-safe decomposition retries. */
    idempotencyId?: string;
  }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  const linear = getClient();

  try {
    // Get parent issue info
    const parentIssue = await linear.issue(parentId);
    if (!parentIssue) {
      return { error: `Parent issue not found: ${parentId}` };
    }

    // Create the sub-issue under the parent issue's team, and resolve labels there.
    const parentTeam = await parentIssue.team;
    const subIssueTeamId = parentTeam?.id ?? (teamIds[0] ?? teamId);
    const team = await linear.team(subIssueTeamId);
    const teamLabels = await team.labels();
    const labelIds = (options?.labels || [])
      .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    // Add auto-decomposed label
    const autoLabel = teamLabels.nodes.find((l) => l.name === 'auto-decomposed');
    if (autoLabel) {
      labelIds.push(autoLabel.id);
    }

    const issuePayload = await linear.createIssue({
      id: options?.idempotencyId,
      teamId: subIssueTeamId,
      parentId,  // Link to parent issue
      title,
      description,
      labelIds,
      priority: options?.priority ?? 3,
      projectId: options?.projectId,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error('Failed to create sub-issue');
    }
    const stateName = (await issue.state)?.name ?? 'Unknown';

    console.log(`[Linear] Created sub-issue: ${issue.identifier} under ${parentIssue.identifier}`);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? undefined,
      state: stateName,
      priority: issue.priority,
      labels: options?.labels || [],
      comments: [],
    };
  } catch (error) {
    if (options?.idempotencyId) {
      try {
        const existing = await linear.issue(options.idempotencyId);
        const existingParent = await existing.parent;
        // The ID alone is the convergence signal (decompositionChildId is a
        // stable hash of parentId+index, deliberately independent of content)
        // — a retry's freshly re-planned title/description is not expected to
        // match the first attempt's byte-for-byte, and requiring that made
        // every retry fail identically forever instead of converging on the
        // artifact its own stable ID already points to (AGT-4048). A content
        // mismatch is still worth knowing about, just not worth failing over.
        if (existingParent?.id === parentId) {
          if (existing.title !== title || (existing.description ?? '') !== description) {
            console.warn(`[Linear] Idempotent sub-issue ${existing.identifier} content differs from this retry's re-plan — converging on the existing artifact anyway`);
          }
          const stateName = (await existing.state)?.name ?? 'Unknown';
          console.warn(`[Linear] Recovered idempotent sub-issue create: ${existing.identifier}`);
          return {
            id: existing.id,
            identifier: existing.identifier,
            title: existing.title,
            description: existing.description ?? undefined,
            state: stateName,
            priority: existing.priority,
            labels: options?.labels || [],
            comments: [],
          };
        }
        console.error(`[Linear] Idempotent child collision for ${options.idempotencyId}: existing artifact belongs to a different parent`);
      } catch {
        // Preserve the original create error when no matching artifact exists.
      }
    }
    console.error('[Linear] createSubIssue error:', error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mark a parent issue as 'decomposed'
 */
export async function markAsDecomposed(
  issueId: string,
  subIssueCount: number,
  totalMinutes: number,
  idempotencyMarker?: string,
): Promise<void> {
  const body = formatAutomationComment({
    heading: 'Decomposed into sub-issues',
    summary: 'The parent stays active while child issues execute; it closes automatically once all sub-issues complete.',
    sections: [{
      label: 'Result',
      body: [`Sub-issues created: ${subIssueCount}`, `Total estimated time: ${totalMinutes} min`],
    }],
    attribution: 'Planner agent',
  });

  await addComment(issueId, body, idempotencyMarker ? effectCommentId(idempotencyMarker) : undefined);

  // Keep parent issue active until all child issues complete. A false return is
  // a real partial-effect failure (comment exists, state did not move), so let
  // the idempotent decomposition retry reconcile it.
  const accepted = await updateIssueState(issueId, 'In Progress');
  if (!accepted) throw new Error(`Linear refused decomposed parent transition for ${issueId}`);

  // Add label (if decomposed label exists)
  try {
    const linear = getClient();
    const team = await linear.team(teamIds[0] ?? teamId);
    const teamLabels = await team.labels();
    const decomposedLabel = teamLabels.nodes.find((l) => l.name === 'decomposed');

    if (decomposedLabel) {
      const issue = await linear.issue(issueId);
      const currentLabels = await issue.labels();
      const currentLabelIds = currentLabels.nodes.map(l => l.id);

      await linear.updateIssue(issueId, {
        labelIds: [...currentLabelIds, decomposedLabel.id],
      });
    }
  } catch (err) {
    console.warn('[Linear] Failed to add decomposed label:', err);
  }
}

/**
 * Agent proposes work by creating a backlog issue
 * - Enforces daily limit of 10
 * - Automatically adds 'agent-proposal' label
 * - Created with low priority (4)
 */
export async function proposeWork(
  sessionName: string,
  title: string,
  rationale: string,
  suggestedApproach?: string
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  const linear = getClient();

  // Look up Backlog state ID
  const proposalTeamId = teamIds[0] ?? teamId;
  const team = await linear.team(proposalTeamId);
  const states = await team.states();
  const backlogState = states.nodes.find((s) =>
    s.name.toLowerCase() === 'backlog'
  );

  // Look up label IDs (agent-proposal + sessionName)
  const teamLabels = await team.labels();
  const proposalLabel = teamLabels.nodes.find((l) => l.name === 'agent-proposal');
  const sessionLabel = teamLabels.nodes.find((l) => l.name === sessionName);

  const labelIds: string[] = [];
  if (proposalLabel) labelIds.push(proposalLabel.id);
  if (sessionLabel) labelIds.push(sessionLabel.id);

  // Compose description
  const description = `## 🤖 Agent Proposal

**Proposed by:** ${sessionName}
**Created at:** ${new Date().toISOString()}

---

### Rationale
${rationale}

${suggestedApproach ? `### Suggested Approach\n${suggestedApproach}` : ''}

---
_This issue was auto-created by an agent. Please review and adjust priority or delete as needed._`;

  const reserved = await reserveDailyIssue();
  if (!reserved) {
    console.log(`[${sessionName}] Daily issue creation limit reached (${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);
    return { error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please defer the proposal to tomorrow.` };
  }
  let issuePayload;
  try {
    issuePayload = await linear.createIssue({
      teamId: proposalTeamId,
      title: `[Proposal] ${title}`,
      description,
      labelIds,
      stateId: backlogState?.id,
      priority: 4, // Low priority
    });
  } catch (error) {
    await releaseDailyIssue();
    throw error;
  }

  const issue = await issuePayload.issue;
  if (!issue) {
    await releaseDailyIssue();
    throw new Error('Failed to create proposal issue');
  }

  console.log(`[${sessionName}] Proposal created: ${issue.identifier} (today ${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: 4,
    labels: ['agent-proposal', sessionName].filter(Boolean),
    comments: [],
  };
}

/**
 * Get stuck/failed issues and PRs (issues stuck in In Progress for >7 days, or with retry/failed labels)
 */
export async function getStuckIssues(): Promise<{
  stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }>;
  failedIssues: Array<LinearIssueInfo & { reason: string }>;
}> {
  if (!isLinearInitialized()) {
    return { stuckIssues: [], failedIssues: [] };
  }
  const linear = getClient();
  const now = Date.now();
  const STUCK_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Fetch all display fields in two nested GraphQL requests. Resolving SDK
  // relations per issue here used to create an N+1 waterfall and made the
  // dashboard endpoint time out whenever the stuck list became sizeable.
  const ids = teamIds.length > 0 ? teamIds : (teamId ? [teamId] : []);
  const team = ids.length === 1 ? { id: { eq: ids[0] } } : { id: { in: ids } };
  const [inProgressIssues, problematicIssues] = await Promise.all([
    fetchRawIssues(linear, {
      ...(ids.length ? { team } : {}),
      state: { name: { eq: 'In Progress' } },
    }, STUCK_ISSUES_QUERY),
    fetchRawIssues(linear, {
      ...(ids.length ? { team } : {}),
      state: { name: { nin: ['Done', 'Canceled'] } },
      labels: { name: { in: ['retry', 'failed', 'blocked', 'needs-help', STUCK_LABEL] } },
    }, STUCK_ISSUES_QUERY),
  ]);

  const stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }> = [];
  const failedIssues: Array<LinearIssueInfo & { reason: string }> = [];

  // Process In Progress issues (check if stuck)
  for (const issue of inProgressIssues.nodes) {
    const updatedAt = new Date(issue.updatedAt ?? 0).getTime();
    const stuckMs = now - updatedAt;

    if (stuckMs > STUCK_THRESHOLD_MS) {
      const stuckDays = Math.floor(stuckMs / (24 * 60 * 60 * 1000));
      stuckIssues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        description: issue.description ?? undefined,
        state: issue.state?.name ?? 'Unknown',
        priority: issue.priority,
        labels: issue.labels?.nodes.map((l) => l.name) ?? [],
        comments: issue.comments?.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: new Date(c.createdAt).toISOString(),
          user: undefined,
        })) ?? [],
        project: issue.project ? {
          id: issue.project.id,
          name: issue.project.name,
          icon: issue.project.icon ?? undefined,
          color: issue.project.color ?? undefined,
        } : undefined,
        stuckDays,
        reason: `No updates for ${stuckDays} days`,
      });
    }
  }

  // Process problematic issues (retry, failed, blocked)
  for (const issue of problematicIssues.nodes) {
    const labelNames = issue.labels?.nodes.map((l) => l.name) ?? [];
    let reason = 'Unknown issue';

    if (labelNames.includes('failed')) {
      reason = 'Marked as failed';
    } else if (labelNames.includes('retry')) {
      reason = 'Requires retry';
    } else if (labelNames.includes('blocked')) {
      reason = 'Blocked by dependencies';
    } else if (labelNames.includes('needs-help')) {
      reason = 'Needs manual intervention';
    } else if (labelNames.includes(STUCK_LABEL)) {
      reason = 'Automatic retries exhausted';
    }

    failedIssues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? undefined,
      state: issue.state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labelNames,
      comments: issue.comments?.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: new Date(c.createdAt).toISOString(),
        user: undefined,
      })) ?? [],
      project: issue.project ? {
        id: issue.project.id,
        name: issue.project.name,
        icon: issue.project.icon ?? undefined,
        color: issue.project.color ?? undefined,
      } : undefined,
      reason,
    });
  }

  return {
    stuckIssues: stuckIssues.sort((a, b) => b.stuckDays - a.stuckDays),
    failedIssues: failedIssues.sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      return pa - pb;
    }),
  };
}
