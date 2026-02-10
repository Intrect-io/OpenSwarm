// ============================================
// Claude Swarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearProjectInfo } from './types.js';

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
 * 내게 할당된 작업 중인 이슈 가져오기
 * (Todo, In Progress, Review 상태 - Backlog 제외)
 */
export async function getMyIssues(
  agentLabel?: string
): Promise<LinearIssueInfo[]> {
  const linear = getClient();

  const filter: any = {
    team: { id: { eq: teamId } },
    state: { name: { in: ['Todo', 'In Progress', 'Started', 'In Review'] } },
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
 * 특정 이슈 조회 (ID 또는 identifier로)
 */
export async function getIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  try {
    // identifier (예: LIN-123) 형식인지 확인
    const isIdentifier = /^[A-Z]+-\d+$/.test(issueIdOrIdentifier);

    let issue;
    if (isIdentifier) {
      // identifier로 검색 - number 필드 사용
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
      // ID로 직접 조회
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
 * 이슈 상태 변경
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'In Review' | 'Done' | 'Blocked' | 'Backlog' | 'Todo'
): Promise<void> {
  const linear = getClient();

  try {
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

    console.log(`[Linear] Issue ${issueId} state changed to ${stateName}`);
  } catch (error) {
    console.error(`[Linear] Failed to update issue state:`, error);
  }
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

// ============================================
// Pair Mode Linear Integration
// ============================================

/**
 * 페어 세션 시작 코멘트
 */
export async function logPairStart(
  issueId: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  const timestamp = new Date().toLocaleString('ko-KR');
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
 * 페어 세션 리뷰 시작 코멘트
 */
export async function logPairReview(
  issueId: string,
  sessionId: string,
  attempt: number
): Promise<void> {
  const timestamp = new Date().toLocaleString('ko-KR');
  const body = `🔍 **[Pair Session] 리뷰 중**

🆔 Session: \`${sessionId}\`
🔢 시도: ${attempt}회차
⏰ 시간: ${timestamp}

Reviewer가 Worker의 작업을 검토 중입니다.`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Review');
}

/**
 * 페어 세션 수정 요청 코멘트
 */
export async function logPairRevision(
  issueId: string,
  sessionId: string,
  feedback: string,
  issues: string[]
): Promise<void> {
  const timestamp = new Date().toLocaleString('ko-KR');
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
 * 페어 세션 완료 코멘트
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
  const timestamp = new Date().toLocaleString('ko-KR');
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
 * 페어 세션 실패/거부 코멘트
 */
export async function logPairFailed(
  issueId: string,
  sessionId: string,
  reason: 'rejected' | 'max_attempts' | 'error',
  details: string
): Promise<void> {
  const timestamp = new Date().toLocaleString('ko-KR');
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
  // 실패 시 상태는 변경하지 않고 사용자가 결정하도록 함
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
 * Sub-issue 생성 (Planner 분해용)
 * - parentId를 지정하여 부모 이슈의 하위 이슈로 생성
 * - 일일 제한에서 제외 (자동 분해는 필수 작업)
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
    // 부모 이슈 정보 가져오기
    const parentIssue = await linear.issue(parentId);
    if (!parentIssue) {
      return { error: `Parent issue not found: ${parentId}` };
    }

    // 라벨 ID 조회
    const team = await linear.team(teamId);
    const teamLabels = await team.labels();
    const labelIds = (options?.labels || [])
      .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    // 자동 분해 라벨 추가
    const autoLabel = teamLabels.nodes.find((l) => l.name === 'auto-decomposed');
    if (autoLabel) {
      labelIds.push(autoLabel.id);
    }

    // Sub-issue 생성
    const issuePayload = await linear.createIssue({
      teamId,
      parentId,  // 부모 이슈 연결
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
 * 부모 이슈를 '분해됨' 상태로 표시
 */
export async function markAsDecomposed(
  issueId: string,
  subIssueCount: number,
  totalMinutes: number
): Promise<void> {
  const timestamp = new Date().toLocaleString('ko-KR');
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

  // 라벨 추가 (decomposed 라벨이 있으면)
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
