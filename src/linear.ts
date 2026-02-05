// ============================================
// Claude Swarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearComment, LinearProjectInfo } from './types.js';

/**
 * 이슈에서 프로젝트 정보 추출
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

// 일일 이슈 생성 제한
const DAILY_ISSUE_LIMIT = 10;
let dailyIssueCount = 0;
let lastResetDate: string = '';

/**
 * 일일 카운터 리셋 (날짜 변경 시)
 */
function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== lastResetDate) {
    dailyIssueCount = 0;
    lastResetDate = today;
  }
}

/**
 * 오늘 남은 이슈 생성 가능 횟수
 */
export function getRemainingDailyIssues(): number {
  resetDailyCounterIfNeeded();
  return Math.max(0, DAILY_ISSUE_LIMIT - dailyIssueCount);
}

/**
 * 오늘 생성된 이슈 수
 */
export function getDailyIssueCount(): number {
  resetDailyCounterIfNeeded();
  return dailyIssueCount;
}

/**
 * Linear 클라이언트 초기화
 */
export function initLinear(apiKey: string, team: string): void {
  client = new LinearClient({ apiKey });
  teamId = team;
}

/**
 * Linear 클라이언트 반환
 */
function getClient(): LinearClient {
  if (!client) {
    throw new Error('Linear client not initialized. Call initLinear() first.');
  }
  return client;
}

/**
 * 에이전트의 In Progress 이슈 조회
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
 * Backlog에서 다음 이슈 가져오기
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
    first: 10, // 여러 개 가져와서 priority로 정렬
  });

  // priority 기준 정렬 (낮을수록 높은 우선순위: 1=Urgent, 4=Low, 0=None)
  const sorted = [...issues.nodes].sort((a, b) => {
    // priority 0(None)은 맨 뒤로
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
 * 내게 할당된 모든 작업 가능한 이슈 가져오기
 * (Backlog, Todo, In Progress 상태)
 */
export async function getMyIssues(
  agentLabel?: string
): Promise<LinearIssueInfo[]> {
  const linear = getClient();

  const filter: any = {
    team: { id: { eq: teamId } },
    state: { name: { in: ['Backlog', 'Todo', 'In Progress', 'Started'] } },
  };

  // agentLabel이 있으면 라벨 필터 추가
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

  // priority 기준 정렬
  return result.sort((a, b) => {
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });
}

/**
 * 이슈 상태 변경
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'Done' | 'Blocked' | 'Backlog'
): Promise<void> {
  const linear = getClient();

  // 팀의 workflow states 조회
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
}

/**
 * 이슈에 코멘트 추가
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
 * 에이전트 작업 시작 코멘트
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
 * 에이전트 진행상황 코멘트
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
 * 에이전트 작업 완료 코멘트
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
 * 에이전트 막힘 코멘트
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

/**
 * 새 이슈 생성 (일일 제한 적용)
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = [],
  options?: { bypassLimit?: boolean }
): Promise<LinearIssueInfo | { error: string }> {
  resetDailyCounterIfNeeded();

  // 일일 제한 체크 (bypassLimit이 아닌 경우)
  if (!options?.bypassLimit && dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    return {
      error: `일일 이슈 생성 한도(${DAILY_ISSUE_LIMIT}개) 도달. 내일 다시 시도하세요.`,
    };
  }

  const linear = getClient();

  // 라벨 ID 조회
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

  // 카운터 증가
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
 * 에이전트가 작업 제안을 Backlog에 올리기
 * - 일일 10개 제한 적용
 * - 자동으로 'agent-proposal' 라벨 추가
 * - 낮은 우선순위(4)로 생성
 */
export async function proposeWork(
  sessionName: string,
  title: string,
  rationale: string,
  suggestedApproach?: string
): Promise<LinearIssueInfo | { error: string }> {
  resetDailyCounterIfNeeded();

  // 일일 제한 체크
  if (dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    console.log(`[${sessionName}] 일일 이슈 생성 한도 도달 (${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);
    return {
      error: `일일 이슈 생성 한도(${DAILY_ISSUE_LIMIT}개) 도달. 제안을 내일로 미루세요.`,
    };
  }

  const linear = getClient();

  // Backlog 상태 ID 조회
  const team = await linear.team(teamId);
  const states = await team.states();
  const backlogState = states.nodes.find((s) =>
    s.name.toLowerCase() === 'backlog'
  );

  // 라벨 ID 조회 (agent-proposal + sessionName)
  const teamLabels = await team.labels();
  const proposalLabel = teamLabels.nodes.find((l) => l.name === 'agent-proposal');
  const sessionLabel = teamLabels.nodes.find((l) => l.name === sessionName);

  const labelIds: string[] = [];
  if (proposalLabel) labelIds.push(proposalLabel.id);
  if (sessionLabel) labelIds.push(sessionLabel.id);

  // 설명 구성
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

  // 카운터 증가
  dailyIssueCount++;

  console.log(`[${sessionName}] 작업 제안 생성: ${issue.identifier} (오늘 ${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);

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
