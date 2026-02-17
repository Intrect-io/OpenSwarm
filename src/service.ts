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
import { PRProcessor } from './prProcessor.js';
import { initLocale, t } from './locale/index.js';

let state: ServiceState = {
  running: false,
  agents: new Map(),
  timers: new Map(),
};

let githubRepos: string[] = [];
let githubCheckTimer: NodeJS.Timeout | null = null;
let prProcessor: PRProcessor | null = null;

/**
 * Start the service
 */
export async function startService(config: SwarmConfig): Promise<void> {
  console.log('Starting Claude Swarm service...');

  // Locale initialization
  initLocale(config.language);

  // Linear initialization
  console.log('🔗 Initializing Linear client...');
  linear.initLinear(config.linearApiKey, config.linearTeamId);
  console.log('✅ Linear client connected');

  // Discord initialization
  console.log('🤖 Connecting Discord bot...');
  await discord.initDiscord(config.discordToken, config.discordChannelId);
  console.log('✅ Discord bot connected successfully');

  // Start web interface
  console.log('🌐 Starting web interface...');
  await web.startWebServer(3847);
  console.log('✅ Web interface ready');

  // GitHub repo configuration
  githubRepos = config.githubRepos ?? [];

  // Start GitHub CI monitoring
  if (githubRepos.length > 0) {
    const checkInterval = config.githubCheckInterval ?? 5 * 60 * 1000; // default 5 minutes
    console.log(`📊 Starting GitHub CI monitoring for ${githubRepos.length} repos...`);
    startGitHubMonitoring(checkInterval);
    console.log(`✅ GitHub monitoring active (interval: ${Math.floor(checkInterval/1000/60)}min)`);
  } else {
    console.log('⚠️ No GitHub repos configured - CI monitoring disabled');
  }

  // Discord callback setup
  discord.setCallbacks({
    onPause: pauseAgent,
    onResume: resumeAgent,
    getStatus: getAgentStatuses,
    getRepos: () => githubRepos,
  });

  // Pair mode configuration
  if (config.pairMode) {
    discord.setPairModeConfig({
      webhookUrl: config.pairMode.webhookUrl,
      maxAttempts: config.pairMode.maxAttempts,
      workerTimeoutMs: config.pairMode.workerTimeoutMs,
      reviewerTimeoutMs: config.pairMode.reviewerTimeoutMs,
    });
    console.log(`Pair mode configured (maxAttempts: ${config.pairMode.maxAttempts})`);
  }

  // Initialize agent states
  for (const agent of config.agents) {
    if (!agent.enabled) continue;

    state.agents.set(agent.name, {
      name: agent.name,
      state: agent.paused ? 'paused' : 'idle',
    });
  }

  // Start timers
  for (const agent of config.agents) {
    if (!agent.enabled) continue;
    startAgentTimer(agent);
  }

  state.running = true;
  state.startedAt = Date.now();

  // Start scheduler
  await scheduler.startAllSchedules();
  const schedules = await scheduler.listSchedules();
  console.log(`Scheduler started with ${schedules.length} schedules`);

  console.log('');
  console.log('🎉 ════════════════════════════════════════');
  console.log(`🎉  ${t('service.startComplete')}`);
  console.log(`🎉  ├─ ${t('service.agentCount', { n: config.agents.length })}`);
  console.log(`🎉  ├─ ${t('service.repoCount', { n: githubRepos.length })}`);
  console.log(`🎉  └─ ${t('service.heartbeatInterval', { n: Math.floor(config.defaultHeartbeatInterval/1000/60) })}`);
  console.log('🎉 ════════════════════════════════════════');
  console.log('');

  // Auto-start autonomous mode
  if (config.autonomous?.enabled) {
    console.log('[Service] Autonomous mode auto-start enabled');

    // Register Linear fetcher
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

    // Register Discord reporter (to default channel)
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
      workerTimeoutMs: config.autonomous.workerTimeoutMs || 0, // 0 = unlimited
      reviewerTimeoutMs: config.autonomous.reviewerTimeoutMs || 0, // 0 = unlimited
      triggerNow: true,  // Execute immediately on start
      maxConcurrentTasks: config.autonomous.maxConcurrentTasks,
      defaultRoles: config.autonomous.defaultRoles,
      projectAgents: config.autonomous.projectAgents,
      // Task decomposition (Planner) configuration
      enableDecomposition: config.autonomous.decomposition?.enabled ?? false,
      decompositionThresholdMinutes: config.autonomous.decomposition?.thresholdMinutes ?? 30,
      plannerModel: config.autonomous.decomposition?.plannerModel,
      plannerTimeoutMs: config.autonomous.decomposition?.plannerTimeoutMs,
    });
    const modelInfo = config.autonomous.models
      ? `, Worker: ${config.autonomous.models.worker || 'default'}, Reviewer: ${config.autonomous.models.reviewer || 'default'}`
      : '';
    console.log(`[Service] Autonomous runner started (pairMode: ${config.autonomous.pairMode}, schedule: ${config.autonomous.schedule}${modelInfo})`);
  }

  // Start PR Auto-Improvement
  if (config.prProcessor?.enabled && githubRepos.length > 0) {
    prProcessor = new PRProcessor({
      repos: githubRepos,
      schedule: config.prProcessor.schedule,
      cooldownHours: config.prProcessor.cooldownHours,
      maxIterations: config.prProcessor.maxIterations,
      roles: config.autonomous?.defaultRoles,
    });
    prProcessor.start();
    console.log(`[Service] PR Processor started (schedule: ${config.prProcessor.schedule}, repos: ${githubRepos.length})`);
  }

  // Startup notification
  const autoStatus = config.autonomous?.enabled
    ? t('service.autoModeActive', { mode: config.autonomous.pairMode ? 'Pair' : 'Solo' })
    : '';
  await discord.reportEvent({
    type: 'issue_started',
    session: 'swarm',
    message: t('service.startedMessage', {
      agents: config.agents.length,
      schedules: schedules.length,
      autoStatus,
    }),
    timestamp: Date.now(),
  });
}

/**
 * Start agent timer
 */
function startAgentTimer(agent: AgentSession): void {
  console.log(`Starting timer for ${agent.name} (interval: ${agent.heartbeatInterval}ms)`);

  // Clean up existing timer
  const existingTimer = state.timers.get(agent.name);
  if (existingTimer) {
    clearInterval(existingTimer);
  }

  // Set up new timer
  const timer = setInterval(() => {
    void runHeartbeat(agent).catch((err) => {
      console.error(`Heartbeat error for ${agent.name}:`, err);
    });
  }, agent.heartbeatInterval);

  state.timers.set(agent.name, timer);

  // Run once immediately
  void runHeartbeat(agent).catch((err) => {
    console.error(`Initial heartbeat error for ${agent.name}:`, err);
  });
}

/**
 * Run heartbeat
 */
async function runHeartbeat(agent: AgentSession): Promise<void> {
  const status = state.agents.get(agent.name);
  if (!status) return;

  // Skip if paused
  if (status.state === 'paused') {
    console.log(`[${agent.name}] Skipping heartbeat (paused)`);
    return;
  }

  console.log(`[${agent.name}] Running heartbeat...`);

  // Check session existence and create if needed
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

  // Check in-progress issues from Linear
  const inProgress = await linear.getInProgressIssues(agent.linearLabel ?? agent.name);

  if (inProgress.length > 0) {
    // Continue working on existing issue
    const issue = inProgress[0];
    status.currentIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    };
    status.state = 'working';

    // Instruct Claude to continue working
    const context = buildIssueContext(issue);
    await tmux.sendTask(agent.name, context);
  } else {
    // Fetch new issue from backlog
    const nextIssue = await linear.getNextBacklogIssue(agent.linearLabel ?? agent.name);

    if (nextIssue) {
      // Start new issue
      await linear.logWorkStart(nextIssue.id, agent.name);

      status.currentIssue = {
        id: nextIssue.id,
        identifier: nextIssue.identifier,
        title: nextIssue.title,
      };
      status.state = 'working';

      // Discord notification
      await discord.reportEvent({
        type: 'issue_started',
        session: agent.name,
        message: t('service.events.issueStarted', { id: nextIssue.identifier, title: nextIssue.title }),
        issueId: nextIssue.identifier,
        timestamp: Date.now(),
      });

      // Instruct Claude to work on task
      const context = buildIssueContext(nextIssue);
      await tmux.sendTask(agent.name, context);
    } else {
      // Nothing to do - maintenance check only
      status.state = 'idle';
      await tmux.sendHeartbeat(agent.name);
    }
  }

  status.lastHeartbeat = Date.now();

  // Check and report results (after 10 seconds)
  setTimeout(async () => {
    await checkAndReport(agent);
  }, 10000);
}

/**
 * Build issue context
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

  const noDesc = t('common.fallback.noDescription');
  return `
${t('service.issueContext.continueWork')}

${t('service.issueContext.issue', { id: issue.identifier, title: issue.title })}

${t('service.issueContext.description')}
${issue.description ?? noDesc}

${t('service.issueContext.recentProgress')}
${recentComments || noDesc}

---
${t('service.issueContext.instructions')}
`;
}

/**
 * Check results and report
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
            message: t('service.events.issueCompleted', { id: status.currentIssue.identifier, detail: event.detail ?? '' }),
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
            message: t('service.events.issueBlocked', { id: status.currentIssue.identifier, reason: event.detail ?? '' }),
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
          message: t('service.events.commit', { detail: event.detail ?? '' }),
          timestamp: Date.now(),
        });
        break;
    }
  }

  status.lastReport = output.slice(-500);
}

/**
 * Pause agent
 */
export function pauseAgent(name: string): void {
  const status = state.agents.get(name);
  if (status) {
    status.state = 'paused';
    console.log(`Agent ${name} paused`);
  }
}

/**
 * Resume agent
 */
export function resumeAgent(name: string): void {
  const status = state.agents.get(name);
  if (status && status.state === 'paused') {
    status.state = 'idle';
    console.log(`Agent ${name} resumed`);
  }
}

/**
 * Get agent statuses
 */
export function getAgentStatuses(name?: string): AgentStatus[] {
  if (name) {
    const status = state.agents.get(name);
    return status ? [status] : [];
  }
  return Array.from(state.agents.values());
}

/**
 * Start GitHub CI monitoring
 */
function startGitHubMonitoring(interval: number): void {
  // Clean up existing timer
  if (githubCheckTimer) {
    clearInterval(githubCheckTimer);
  }

  // Set up new timer
  githubCheckTimer = setInterval(() => {
    void checkGitHubCI().catch((err) => {
      console.error('GitHub CI check error:', err);
    });
  }, interval);

  // Run once immediately
  void checkGitHubCI().catch((err) => {
    console.error('Initial GitHub CI check error:', err);
  });
}

/**
 * Check GitHub CI status (state-based)
 * - Persist healthy/broken state per repo to file
 * - Discord notification on state transitions (failure detected, recovery)
 * - Reminder every 24 hours while broken state persists
 */
async function checkGitHubCI(): Promise<void> {
  if (githubRepos.length === 0) return;

  console.log('[GitHub] Checking CI status...');

  const ciState = await github.loadCIState();

  for (const repo of githubRepos) {
    const current = ciState.repos[repo];
    const { health, transition } = await github.checkRepoHealth(repo, current);

    if (transition) {
      if (transition.to === 'broken') {
        const failureList = health.activeFailures
          .map((f) => `  - **${f.workflow}** (${f.branch})`)
          .join('\n');

        console.log(`[GitHub] CI broken: ${repo}`);
        await discord.reportEvent({
          type: 'ci_failed',
          session: 'github',
          message: t('service.events.ciFailDetected', { repo, failures: failureList }),
          timestamp: Date.now(),
          url: health.activeFailures[0]?.url,
        });
        health.lastReminder = new Date().toISOString();

      } else if (transition.to === 'healthy' && transition.from === 'broken') {
        const duration = transition.brokenSince
          ? formatDuration(Date.now() - new Date(transition.brokenSince).getTime())
          : t('common.fallback.unknown');

        console.log(`[GitHub] CI recovered: ${repo} (after ${duration})`);
        await discord.reportEvent({
          type: 'ci_recovered' as any,
          session: 'github',
          message: t('service.events.ciRecovered', { repo, duration }),
          timestamp: Date.now(),
        });
      }
    }

    // Broken state persists + reminder interval reached
    if (health.status === 'broken' && !transition && github.needsReminder(health)) {
      const days = health.brokenSince
        ? Math.floor((Date.now() - new Date(health.brokenSince).getTime()) / (1000 * 60 * 60 * 24))
        : '?';

      const failureList = health.activeFailures
        .map((f) => `  - **${f.workflow}** (${f.branch})`)
        .join('\n');

      console.log(`[GitHub] CI still broken: ${repo} (${days}d)`);
      await discord.reportEvent({
        type: 'ci_failed',
        session: 'github',
        message: t('service.events.ciStillFailing', { repo, days, failures: failureList }),
        timestamp: Date.now(),
        url: health.activeFailures[0]?.url,
      });
      health.lastReminder = new Date().toISOString();
    }

    ciState.repos[repo] = health;
  }

  await github.saveCIState(ciState);
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return t('common.duration.hours', { n: hours });
  const days = Math.floor(hours / 24);
  return t('common.duration.days', { n: days });
}

/**
 * Stop the service
 */
export async function stopService(): Promise<void> {
  console.log('Stopping Claude Swarm service...');

  // Clean up GitHub monitoring timer
  if (githubCheckTimer) {
    clearInterval(githubCheckTimer);
    githubCheckTimer = null;
    console.log('GitHub monitoring stopped');
  }

  // Clean up agent timers
  for (const [name, timer] of state.timers) {
    clearInterval(timer);
    console.log(`Timer stopped for ${name}`);
  }
  state.timers.clear();

  // Stop PR Processor
  if (prProcessor) {
    prProcessor.stop();
    prProcessor = null;
    console.log('PR Processor stopped');
  }

  // Stop scheduler
  scheduler.stopAllSchedules();
  console.log('Scheduler stopped');

  // Stop web server
  await web.stopWebServer();
  console.log('Web server stopped');

  // Shutdown Discord
  await discord.stopDiscord();

  state.running = false;
  console.log('Service stopped');
}
