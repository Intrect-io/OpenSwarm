// ============================================
// Claude Swarm - Main Service
// ============================================

import type {
  SwarmConfig,
  AgentSession,
  AgentStatus,
  ServiceState,
} from './types.js';
import * as tmux from './tmux.js';
import * as linear from './linear.js';
import * as discord from './discord.js';
import * as github from './github.js';
import * as scheduler from './scheduler.js';
import * as web from './web.js';
import * as autonomous from './autonomousRunner.js';

let state: ServiceState = {
  running: false,
  agents: new Map(),
  timers: new Map(),
};

let githubRepos: string[] = [];
let seenFailures: Set<number> = new Set(); // 이미 보고한 CI 실패 ID들
let githubCheckTimer: NodeJS.Timeout | null = null;

/**
 * 서비스 시작
 */
export async function startService(config: SwarmConfig): Promise<void> {
  console.log('Starting Claude Swarm service...');

  // Linear 초기화
  console.log('🔗 Initializing Linear client...');
  linear.initLinear(config.linearApiKey, config.linearTeamId);
  console.log('✅ Linear client connected');

  // Discord 초기화
  console.log('🤖 Connecting Discord bot...');
  await discord.initDiscord(config.discordToken, config.discordChannelId);
  console.log('✅ Discord bot connected successfully');

  // 웹 인터페이스 시작
  console.log('🌐 Starting web interface...');
  await web.startWebServer(3847);
  console.log('✅ Web interface ready');

  // GitHub 레포 설정
  githubRepos = config.githubRepos ?? [];

  // GitHub CI 모니터링 시작
  if (githubRepos.length > 0) {
    const checkInterval = config.githubCheckInterval ?? 5 * 60 * 1000; // 기본 5분
    console.log(`📊 Starting GitHub CI monitoring for ${githubRepos.length} repos...`);
    startGitHubMonitoring(checkInterval);
    console.log(`✅ GitHub monitoring active (interval: ${Math.floor(checkInterval/1000/60)}min)`);
  } else {
    console.log('⚠️ No GitHub repos configured - CI monitoring disabled');
  }

  // Discord 콜백 설정
  discord.setCallbacks({
    onPause: pauseAgent,
    onResume: resumeAgent,
    getStatus: getAgentStatuses,
    getRepos: () => githubRepos,
  });

  // Pair 모드 설정
  if (config.pairMode) {
    discord.setPairModeConfig({
      webhookUrl: config.pairMode.webhookUrl,
      maxAttempts: config.pairMode.maxAttempts,
      workerTimeoutMs: config.pairMode.workerTimeoutMs,
      reviewerTimeoutMs: config.pairMode.reviewerTimeoutMs,
    });
    console.log(`Pair mode configured (maxAttempts: ${config.pairMode.maxAttempts})`);
  }

  // 에이전트 상태 초기화
  for (const agent of config.agents) {
    if (!agent.enabled) continue;

    state.agents.set(agent.name, {
      name: agent.name,
      state: agent.paused ? 'paused' : 'idle',
    });
  }

  // 타이머 시작
  for (const agent of config.agents) {
    if (!agent.enabled) continue;
    startAgentTimer(agent);
  }

  state.running = true;
  state.startedAt = Date.now();

  // 스케줄러 시작
  await scheduler.startAllSchedules();
  const schedules = await scheduler.listSchedules();
  console.log(`Scheduler started with ${schedules.length} schedules`);

  console.log('');
  console.log('🎉 ════════════════════════════════════════');
  console.log('🎉  Claude Swarm 서비스 시작 완료!');
  console.log(`🎉  ├─ 에이전트: ${config.agents.length}개`);
  console.log(`🎉  ├─ GitHub 레포: ${githubRepos.length}개`);
  console.log(`🎉  └─ 기본 heartbeat: ${Math.floor(config.defaultHeartbeatInterval/1000/60)}분`);
  console.log('🎉 ════════════════════════════════════════');
  console.log('');

  // 자율 모드 자동 시작
  if (config.autonomous?.enabled) {
    console.log('[Service] Autonomous mode auto-start enabled');

    // Linear fetcher 등록
    autonomous.setLinearFetcher(async () => {
      const issues = await linear.getMyIssues();
      const { linearIssueToTask } = await import('./decisionEngine.js');
      return issues.map((issue: any) => linearIssueToTask({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        project: issue.project ? {
          id: issue.project.id,
          name: issue.project.name,
        } : undefined,
      }));
    });
    console.log('[Service] Linear fetcher registered');

    // Discord reporter 등록 (기본 채널로)
    autonomous.setDiscordReporter(async (content: any) => {
      await discord.sendToChannel(content);
    });
    console.log('[Service] Discord reporter registered');

    await autonomous.startAutonomous({
      linearTeamId: config.linearTeamId,
      allowedProjects: config.autonomous.allowedProjects,
      heartbeatSchedule: config.autonomous.schedule,
      autoExecute: true,
      maxConsecutiveTasks: 3,
      cooldownSeconds: 300,
      dryRun: false,
      pairMode: config.autonomous.pairMode,
      pairMaxAttempts: config.autonomous.maxAttempts,
      workerModel: config.autonomous.models?.worker,
      reviewerModel: config.autonomous.models?.reviewer,
      workerTimeoutMs: config.autonomous.workerTimeoutMs || 0, // 0 = 무제한
      reviewerTimeoutMs: config.autonomous.reviewerTimeoutMs || 0, // 0 = 무제한
      triggerNow: true,  // 시작 시 즉시 실행
      maxConcurrentTasks: config.autonomous.maxConcurrentTasks,
      defaultRoles: config.autonomous.defaultRoles,
      projectAgents: config.autonomous.projectAgents,
    });
    const modelInfo = config.autonomous.models
      ? `, Worker: ${config.autonomous.models.worker || 'default'}, Reviewer: ${config.autonomous.models.reviewer || 'default'}`
      : '';
    console.log(`[Service] Autonomous runner started (pairMode: ${config.autonomous.pairMode}, schedule: ${config.autonomous.schedule}${modelInfo})`);
  }

  // 시작 알림
  const autoStatus = config.autonomous?.enabled
    ? `, 자율모드 활성 (${config.autonomous.pairMode ? 'Pair' : 'Solo'})`
    : '';
  await discord.reportEvent({
    type: 'issue_started',
    session: 'swarm',
    message: `Claude Swarm 시작됨. ${config.agents.length}개 에이전트, ${schedules.length}개 스케줄 활성화${autoStatus}.`,
    timestamp: Date.now(),
  });
}

/**
 * 에이전트 타이머 시작
 */
function startAgentTimer(agent: AgentSession): void {
  console.log(`Starting timer for ${agent.name} (interval: ${agent.heartbeatInterval}ms)`);

  // 기존 타이머 정리
  const existingTimer = state.timers.get(agent.name);
  if (existingTimer) {
    clearInterval(existingTimer);
  }

  // 새 타이머 설정
  const timer = setInterval(() => {
    void runHeartbeat(agent).catch((err) => {
      console.error(`Heartbeat error for ${agent.name}:`, err);
    });
  }, agent.heartbeatInterval);

  state.timers.set(agent.name, timer);

  // 즉시 한 번 실행
  void runHeartbeat(agent).catch((err) => {
    console.error(`Initial heartbeat error for ${agent.name}:`, err);
  });
}

/**
 * Heartbeat 실행
 */
async function runHeartbeat(agent: AgentSession): Promise<void> {
  const status = state.agents.get(agent.name);
  if (!status) return;

  // 일시 중지 상태면 스킵
  if (status.state === 'paused') {
    console.log(`[${agent.name}] Skipping heartbeat (paused)`);
    return;
  }

  console.log(`[${agent.name}] Running heartbeat...`);

  // 세션 존재 확인 및 생성
  const exists = await tmux.sessionExists(agent.name);
  if (!exists) {
    console.log(`[${agent.name}] Creating new tmux session...`);
    try {
      await tmux.createSession(agent.name, agent.projectPath);
      console.log(`[${agent.name}] Tmux session created successfully`);
    } catch (error) {
      console.error(`[${agent.name}] Failed to create tmux session:`, error);
      return;
    }
  }

  // Linear에서 현재 작업 중인 이슈 확인
  const inProgress = await linear.getInProgressIssues(agent.linearLabel ?? agent.name);

  if (inProgress.length > 0) {
    // 기존 이슈 이어서 작업
    const issue = inProgress[0];
    status.currentIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    };
    status.state = 'working';

    // Claude에게 이어서 작업 지시
    const context = buildIssueContext(issue);
    await tmux.sendTask(agent.name, context);
  } else {
    // Backlog에서 새 이슈 가져오기
    const nextIssue = await linear.getNextBacklogIssue(agent.linearLabel ?? agent.name);

    if (nextIssue) {
      // 새 이슈 시작
      await linear.logWorkStart(nextIssue.id, agent.name);

      status.currentIssue = {
        id: nextIssue.id,
        identifier: nextIssue.identifier,
        title: nextIssue.title,
      };
      status.state = 'working';

      // Discord 알림
      await discord.reportEvent({
        type: 'issue_started',
        session: agent.name,
        message: `이슈 시작: ${nextIssue.identifier} ${nextIssue.title}`,
        issueId: nextIssue.identifier,
        timestamp: Date.now(),
      });

      // Claude에게 작업 지시
      const context = buildIssueContext(nextIssue);
      await tmux.sendTask(agent.name, context);
    } else {
      // 할 일 없음 → 유지보수 체크만
      status.state = 'idle';
      await tmux.sendHeartbeat(agent.name);
    }
  }

  status.lastHeartbeat = Date.now();

  // 결과 확인 및 보고 (10초 후)
  setTimeout(async () => {
    await checkAndReport(agent);
  }, 10000);
}

/**
 * 이슈 컨텍스트 빌드
 */
function buildIssueContext(issue: {
  identifier: string;
  title: string;
  description?: string;
  comments: { body: string; createdAt: string }[];
}): string {
  const recentComments = issue.comments
    .slice(-5)
    .map((c) => `[${c.createdAt}]\n${c.body}`)
    .join('\n\n---\n\n');

  return `
Linear 이슈 작업 계속:

이슈: ${issue.identifier} - ${issue.title}

설명:
${issue.description ?? '(없음)'}

최근 진행 상황:
${recentComments || '(없음)'}

---
위 컨텍스트를 바탕으로 작업을 계속해줘.
진행상황이 있으면 알려주고, 완료되면 "DONE: <요약>"으로 알려줘.
막히면 "BLOCKED: <이유>"로 알려줘.
`;
}

/**
 * 결과 확인 및 보고
 */
async function checkAndReport(agent: AgentSession): Promise<void> {
  const status = state.agents.get(agent.name);
  if (!status) return;

  const output = await tmux.capturePane(agent.name, 50);
  const events = tmux.parseEvents(output);

  for (const event of events) {
    if (!event.type) continue;

    switch (event.type) {
      case 'completed':
        if (status.currentIssue) {
          await linear.logWorkComplete(status.currentIssue.id, agent.name, event.detail);

          await discord.reportEvent({
            type: 'issue_completed',
            session: agent.name,
            message: `이슈 완료: ${status.currentIssue.identifier} ${event.detail ?? ''}`,
            issueId: status.currentIssue.identifier,
            timestamp: Date.now(),
          });

          status.currentIssue = undefined;
          status.state = 'idle';
        }
        break;

      case 'blocked':
        if (status.currentIssue) {
          await linear.logBlocked(status.currentIssue.id, agent.name, event.detail ?? 'Unknown');

          await discord.reportEvent({
            type: 'issue_blocked',
            session: agent.name,
            message: `이슈 막힘: ${status.currentIssue.identifier}\n이유: ${event.detail}`,
            issueId: status.currentIssue.identifier,
            timestamp: Date.now(),
          });

          status.state = 'blocked';
        }
        break;

      case 'failed':
        await discord.reportEvent({
          type: event.detail?.includes('Test') ? 'test_failed' : 'build_failed',
          session: agent.name,
          message: event.detail ?? 'Build/Test failed',
          timestamp: Date.now(),
        });
        break;

      case 'commit':
        await discord.reportEvent({
          type: 'commit',
          session: agent.name,
          message: `커밋: ${event.detail}`,
          timestamp: Date.now(),
        });
        break;
    }
  }

  status.lastReport = output.slice(-500);
}

/**
 * 에이전트 일시 중지
 */
export function pauseAgent(name: string): void {
  const status = state.agents.get(name);
  if (status) {
    status.state = 'paused';
    console.log(`Agent ${name} paused`);
  }
}

/**
 * 에이전트 재개
 */
export function resumeAgent(name: string): void {
  const status = state.agents.get(name);
  if (status && status.state === 'paused') {
    status.state = 'idle';
    console.log(`Agent ${name} resumed`);
  }
}

/**
 * 에이전트 상태 조회
 */
export function getAgentStatuses(name?: string): AgentStatus[] {
  if (name) {
    const status = state.agents.get(name);
    return status ? [status] : [];
  }
  return Array.from(state.agents.values());
}

/**
 * GitHub CI 모니터링 시작
 */
function startGitHubMonitoring(interval: number): void {
  // 기존 타이머 정리
  if (githubCheckTimer) {
    clearInterval(githubCheckTimer);
  }

  // 새 타이머 설정
  githubCheckTimer = setInterval(() => {
    void checkGitHubCI().catch((err) => {
      console.error('GitHub CI check error:', err);
    });
  }, interval);

  // 즉시 한 번 실행
  void checkGitHubCI().catch((err) => {
    console.error('Initial GitHub CI check error:', err);
  });
}

/**
 * GitHub CI 실패 확인 및 알림
 */
async function checkGitHubCI(): Promise<void> {
  if (githubRepos.length === 0) return;

  console.log('[GitHub] Checking CI status...');

  const failures = await github.getAllFailedRuns(githubRepos, 5);

  for (const failure of failures) {
    // 이미 보고한 실패는 스킵
    if (seenFailures.has(failure.id)) continue;

    // 24시간 이내 실패만 보고
    const failureTime = new Date(failure.createdAt).getTime();
    const hoursAgo = (Date.now() - failureTime) / (1000 * 60 * 60);
    if (hoursAgo > 24) continue;

    // 새 실패 발견 - Discord 알림
    console.log(`[GitHub] New CI failure: ${failure.repo} - ${failure.name}`);

    await discord.reportEvent({
      type: 'ci_failed',
      session: 'github',
      message: `**${failure.repo}**\nWorkflow: ${failure.name}\nBranch: ${failure.branch}`,
      timestamp: failureTime,
      url: failure.url,
    });

    // 보고 완료로 기록
    seenFailures.add(failure.id);
  }

  // seenFailures 정리 (48시간 이상 지난 것 제거)
  // 참고: 실패 ID는 시간순이 아니므로 별도 관리 필요할 수 있음
  // 현재는 무한 증가 방지를 위해 1000개 초과 시 초기화
  if (seenFailures.size > 1000) {
    console.log('[GitHub] Clearing old seen failures cache');
    seenFailures.clear();
  }
}

/**
 * 서비스 중지
 */
export async function stopService(): Promise<void> {
  console.log('Stopping Claude Swarm service...');

  // GitHub 모니터링 타이머 정리
  if (githubCheckTimer) {
    clearInterval(githubCheckTimer);
    githubCheckTimer = null;
    console.log('GitHub monitoring stopped');
  }

  // 에이전트 타이머 정리
  for (const [name, timer] of state.timers) {
    clearInterval(timer);
    console.log(`Timer stopped for ${name}`);
  }
  state.timers.clear();

  // 스케줄러 중지
  scheduler.stopAllSchedules();
  console.log('Scheduler stopped');

  // 웹 서버 중지
  await web.stopWebServer();
  console.log('Web server stopped');

  // Discord 종료
  await discord.stopDiscord();

  state.running = false;
  console.log('Service stopped');
}
