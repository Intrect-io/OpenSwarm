// ============================================
// Claude Swarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearProjectInfo } from '../core/types.js';
import { getDateLocale } from '../locale/index.js';

/**
 * Extract project info from an issue
 */
async function getProjectInfo(issue: any): Promise<LinearProjectInfo | undefined> {
  try {
    const project = await issue.project;
    if (!project) return undefined;
    return {
      id: project.id,
      name: project.name,
      icon: project.icon ?? undefined,
      color: project.color ?? undefined,
    };
  } catch {
    return undefined;
  }
}

let client: LinearClient | null = null;
let teamId: string = '';

// Daily issue creation limit
const DAILY_ISSUE_LIMIT = 10;
let dailyIssueCount = 0;
let lastResetDate: string = '';

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
 * Initialize the Linear client
 */
export function initLinear(apiKey: string, team: string): void {
  client = new LinearClient({ apiKey });
  teamId = team;
}

/**
 * Return the Linear client instance
 */
function getClient(): LinearClient {
  if (!client) {
    throw new Error('Linear client not initialized. Call initLinear() first.');
  }
  return client;
}

/**
 * Get in-progress issues for an agent
 */
export async function getInProgressIssues(
  agentLabel: string
): Promise<LinearIssueInfo[]> {
  const linear = getClient();

  const issues = await linear.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { name: { in: ['In Progress', 'Started'] } },
      labels: { name: { eq: agentLabel } },
    },
  });

  const result: LinearIssueInfo[] = [];

  for (const issue of issues.nodes) {
    const [comments, labels, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      getProjectInfo(issue),
    ]);

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined, // TODO: resolve user name
      })),
      project,
    });
  }

  return result;
}

/**
 * Get the next issue from the backlog
 */
export async function getNextBacklogIssue(
  agentLabel: string
): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  const issues = await linear.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { name: { in: ['Backlog', 'Todo'] } },
      labels: { name: { eq: agentLabel } },
    },
    first: 10, // Fetch multiple and sort by priority
  });

  // Sort by priority (lower = higher priority: 1=Urgent, 4=Low, 0=None)
  const sorted = [...issues.nodes].sort((a, b) => {
    // Push priority 0 (None) to the end
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const issue = sorted[0];
  if (!issue) return null;

  const [comments, labels, project] = await Promise.all([
    issue.comments(),
    issue.labels(),
    getProjectInfo(issue),
  ]);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: (await issue.state)?.name ?? 'Unknown',
    priority: issue.priority,
    labels: labels.nodes.map((l) => l.name),
    comments: comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      user: undefined,
    })),
    project,
  };
}

/**
 * Get assigned active issues
 * (Todo, In Progress, Review states - excludes Backlog)
 */
export async function getMyIssues(
  agentLabel?: string
): Promise<LinearIssueInfo[]> {
  const linear = getClient();

  const filter: any = {
    team: { id: { eq: teamId } },
    // Fetch Todo + Backlog: Todo = ready to execute, Backlog = display only (not auto-executed)
    state: { name: { in: ['Todo', 'Backlog'] } },
  };

  // Add label filter if agentLabel is provided
  if (agentLabel) {
    filter.labels = { name: { eq: agentLabel } };
  }

  const issues = await linear.issues({
    filter,
    first: 50,
  });

  const result: LinearIssueInfo[] = [];

  for (const issue of issues.nodes) {
    const [comments, labels, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      getProjectInfo(issue),
    ]);

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
    });
  }

  // Sort by priority
  return result.sort((a, b) => {
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });
}

/**
 * Get a specific issue by ID or identifier
 */
export async function getIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  try {
    // Check if it's an identifier format (e.g., LIN-123)
    const isIdentifier = /^[A-Z]+-\d+$/.test(issueIdOrIdentifier);

    let issue;
    if (isIdentifier) {
      // Search by identifier - use number field
      const numPart = issueIdOrIdentifier.split('-')[1];
      const issueNumber = parseInt(numPart, 10);

      const issues = await linear.issues({
        filter: {
          team: { id: { eq: teamId } },
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

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
    };
  } catch (error) {
    console.error(`[Linear] getIssue error for ${issueIdOrIdentifier}:`, error);
    return null;
  }
}

/**
 * Update issue state
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'In Review' | 'Done' | 'Blocked' | 'Backlog' | 'Todo'
): Promise<void> {
  const linear = getClient();

  try {
    // Get team workflow states
    const team = await linear.team(teamId);
    const states = await team.states();
    const targetState = states.nodes.find((s) =>
      s.name.toLowerCase().includes(stateName.toLowerCase())
    );

    if (!targetState) {
      console.error(`State "${stateName}" not found in team workflow`);
      return;
    }

    await linear.updateIssue(issueId, {
      stateId: targetState.id,
    });

    console.log(`[Linear] Issue ${issueId} state changed to ${stateName}`);
  } catch (error) {
    console.error(`[Linear] Failed to update issue state:`, error);
  }
}

/**
 * Add a comment to an issue
 */
export async function addComment(
  issueId: string,
  body: string
): Promise<void> {
  const linear = getClient();

  await linear.createComment({
    issueId,
    body,
  });
}

/**
 * Log work start comment for an agent
 */
export async function logWorkStart(
  issueId: string,
  sessionName: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] 작업 시작**

시간: ${timestamp}

---
_자동 생성됨_`;

  await addComment(issueId, body);
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
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] 진행 상황**

${progress}

시간: ${timestamp}`;

  await addComment(issueId, body);
}

/**
 * Log work completion comment for an agent
 */
export async function logWorkComplete(
  issueId: string,
  sessionName: string,
  summary?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ✅ 작업 완료**

${summary ?? ''}

시간: ${timestamp}`;

  await addComment(issueId, body);
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
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ⚠️ 막힘**

이유: ${reason}

사용자 개입 필요

시간: ${timestamp}`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Blocked');
}

// ============================================
// Pair Mode Linear Integration
// ============================================

/**
 * Log pair session start comment
 */
export async function logPairStart(
  issueId: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `👥 **[Pair Session] 작업 시작**

🆔 Session: \`${sessionId}\`
📁 Project: \`${projectPath}\`
⏰ 시간: ${timestamp}

Worker/Reviewer 페어 모드로 작업을 시작합니다.

---
_자동 생성됨_`;

  await addComment(issueId, body);
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
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `🔍 **[Pair Session] 리뷰 중**

🆔 Session: \`${sessionId}\`
🔢 시도: ${attempt}회차
⏰ 시간: ${timestamp}

Reviewer가 Worker의 작업을 검토 중입니다.`;

  await addComment(issueId, body);
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
  const timestamp = new Date().toLocaleString(getDateLocale());
  const issueList = issues.length > 0
    ? issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')
    : '(없음)';

  const body = `🔄 **[Pair Session] 수정 요청**

🆔 Session: \`${sessionId}\`
⏰ 시간: ${timestamp}

**피드백:** ${feedback}

**문제점:**
${issueList}

Worker가 수정 작업을 진행합니다.`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session completion comment
 */
export async function logPairComplete(
  issueId: string,
  sessionId: string,
  stats: {
    attempts: number;
    duration: number;
    filesChanged: string[];
  }
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const durationStr = stats.duration < 60
    ? `${stats.duration}초`
    : `${Math.floor(stats.duration / 60)}분 ${stats.duration % 60}초`;

  const filesStr = stats.filesChanged.length > 0
    ? stats.filesChanged.slice(0, 10).map(f => `- \`${f}\``).join('\n')
    : '(없음)';

  const body = `✅ **[Pair Session] 작업 완료**

🆔 Session: \`${sessionId}\`
⏰ 완료 시간: ${timestamp}

**📊 통계:**
- 시도 횟수: ${stats.attempts}회
- 소요 시간: ${durationStr}
- 변경 파일: ${stats.filesChanged.length}개

**변경된 파일:**
${filesStr}

---
_Worker/Reviewer 페어 리뷰 승인됨_`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Done');
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
  const timestamp = new Date().toLocaleString(getDateLocale());
  const reasonText = {
    rejected: '❌ Reviewer가 작업을 거부했습니다',
    max_attempts: '⚠️ 최대 시도 횟수를 초과했습니다',
    error: '💥 오류가 발생했습니다',
  }[reason];

  const body = `❌ **[Pair Session] 작업 실패**

🆔 Session: \`${sessionId}\`
⏰ 시간: ${timestamp}

**사유:** ${reasonText}

**상세:**
${details}

---
_수동 개입이 필요합니다_`;

  await addComment(issueId, body);
  // Don't change state on failure; let the user decide
}

/**
 * Create a new issue (with daily limit enforcement)
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = [],
  options?: { bypassLimit?: boolean }
): Promise<LinearIssueInfo | { error: string }> {
  resetDailyCounterIfNeeded();

  // Check daily limit (unless bypassLimit is set)
  if (!options?.bypassLimit && dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    return {
      error: `일일 이슈 생성 한도(${DAILY_ISSUE_LIMIT}개) 도달. 내일 다시 시도하세요.`,
    };
  }

  const linear = getClient();

  // Look up label IDs
  const team = await linear.team(teamId);
  const teamLabels = await team.labels();
  const labelIds = labels
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const issuePayload = await linear.createIssue({
    teamId,
    title,
    description,
    labelIds,
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error('Failed to create issue');
  }

  // Increment counter
  dailyIssueCount++;

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
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
  }
): Promise<LinearIssueInfo | { error: string }> {
  const linear = getClient();

  try {
    // Get parent issue info
    const parentIssue = await linear.issue(parentId);
    if (!parentIssue) {
      return { error: `Parent issue not found: ${parentId}` };
    }

    // Look up label IDs
    const team = await linear.team(teamId);
    const teamLabels = await team.labels();
    const labelIds = (options?.labels || [])
      .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    // Add auto-decomposed label
    const autoLabel = teamLabels.nodes.find((l) => l.name === 'auto-decomposed');
    if (autoLabel) {
      labelIds.push(autoLabel.id);
    }

    // Create the sub-issue
    const issuePayload = await linear.createIssue({
      teamId,
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

    console.log(`[Linear] Created sub-issue: ${issue.identifier} under ${parentIssue.identifier}`);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: 'Backlog',
      priority: issue.priority,
      labels: options?.labels || [],
      comments: [],
    };
  } catch (error) {
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
  totalMinutes: number
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `📋 **[Planner] 작업 분해 완료**

⏰ 시간: ${timestamp}

**분해 결과:**
- Sub-issues 생성: ${subIssueCount}개
- 총 예상 시간: ${totalMinutes}분

이 이슈는 sub-issues로 분해되었습니다.
각 sub-issue가 완료되면 자동으로 이 이슈도 완료 처리됩니다.

---
_Planner 에이전트에 의해 자동 분해됨_`;

  await addComment(issueId, body);

  // Move parent issue to Done — sub-issues represent the actual work
  try {
    await updateIssueState(issueId, 'Done');
  } catch (err) {
    console.warn('[Linear] Failed to mark decomposed parent as Done:', err);
  }

  // Add label (if decomposed label exists)
  try {
    const linear = getClient();
    const team = await linear.team(teamId);
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
  resetDailyCounterIfNeeded();

  // Check daily limit
  if (dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    console.log(`[${sessionName}] 일일 이슈 생성 한도 도달 (${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);
    return {
      error: `일일 이슈 생성 한도(${DAILY_ISSUE_LIMIT}개) 도달. 제안을 내일로 미루세요.`,
    };
  }

  const linear = getClient();

  // Look up Backlog state ID
  const team = await linear.team(teamId);
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
  const description = `## 🤖 에이전트 제안

**제안자:** ${sessionName}
**생성 시간:** ${new Date().toISOString()}

---

### 제안 이유
${rationale}

${suggestedApproach ? `### 제안 접근법\n${suggestedApproach}` : ''}

---
_이 이슈는 에이전트가 자동으로 생성했습니다. 검토 후 우선순위를 조정하거나 삭제해주세요._`;

  const issuePayload = await linear.createIssue({
    teamId,
    title: `[제안] ${title}`,
    description,
    labelIds,
    stateId: backlogState?.id,
    priority: 4, // Low priority
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error('Failed to create proposal issue');
  }

  // Increment counter
  dailyIssueCount++;

  console.log(`[${sessionName}] Proposal created: ${issue.identifier} (today ${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: 4,
    labels: ['agent-proposal', sessionName].filter(Boolean),
    comments: [],
  };
}
