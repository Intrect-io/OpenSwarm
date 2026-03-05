// ============================================
// OpenSwarm - Main Service
// ============================================

import type {
  SwarmConfig,
  AgentStatus,
  ServiceState,
} from './types.js';
import * as linear from '../linear/index.js';
import * as discord from '../discord/index.js';
import * as github from '../github/index.js';
import * as scheduler from '../automation/scheduler.js';
import * as web from '../support/web.js';
import * as autonomous from '../automation/autonomousRunner.js';
import { PRProcessor } from '../automation/prProcessor.js';
import { initMonitors } from '../automation/longRunningMonitor.js';
import { initLocale, t } from '../locale/index.js';
import { initRateLimiters, destroyRateLimiters } from '../support/rateLimiter.js';

let state: ServiceState = {
  running: false,
  agents: new Map(),
  timers: new Map(),
};

let githubRepos: string[] = [];
let githubCheckTimer: NodeJS.Timeout | null = null;
let prProcessor: PRProcessor | null = null;

/**
 * Get PR Processor instance (for web dashboard)
 */
export function getPRProcessor(): PRProcessor | null {
  return prProcessor;
}

/**
 * Start the service
 */
export async function startService(config: SwarmConfig): Promise<void> {
  console.log('Starting OpenSwarm service...');

  // Locale initialization
  initLocale(config.language);

  // Rate limiter initialization
  console.log('⚡ Initializing rate limiters...');
  initRateLimiters();
  console.log('✅ Rate limiters ready');

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
      const issues = await linear.getMyIssues({ slim: true, timeoutMs: 30000 });
      const { linearIssueToTask } = await import('../orchestration/decisionEngine.js');
      return issues.map((issue: any) => linearIssueToTask({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        state: issue.state,
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

    const runnerInstance = await autonomous.startAutonomous({
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
      // Git worktree mode
      worktreeMode: config.autonomous.worktreeMode ?? false,
      // Pipeline guards
      guards: config.autonomous.guards,
    });
    web.setWebRunner(runnerInstance);
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
      maxRetries: config.prProcessor.maxRetries,
      ciTimeoutMs: config.prProcessor.ciTimeoutMs,
      ciPollIntervalMs: config.prProcessor.ciPollIntervalMs,
      conflictResolver: config.prProcessor.conflictResolver,
    });
    prProcessor.start();
    const resolverStatus = config.prProcessor.conflictResolver?.enabled ? ', conflictResolver: ON' : '';
    console.log(`[Service] PR Processor started (schedule: ${config.prProcessor.schedule}, repos: ${githubRepos.length}, maxRetries: ${config.prProcessor.maxRetries ?? 3}${resolverStatus})`);
  }

  // Initialize long-running monitors
  if (config.monitors?.length) {
    initMonitors(config.monitors);
    console.log(`[Service] Long-running monitors initialized (${config.monitors.length} from config)`);
  } else {
    initMonitors(); // Restore only from persisted files
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
          type: 'ci_recovered',
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
  console.log('Stopping OpenSwarm service...');

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

  // Cleanup rate limiters
  destroyRateLimiters();
  console.log('Rate limiters destroyed');
  console.log('Web server stopped');

  // Shutdown Discord
  await discord.stopDiscord();

  state.running = false;
  console.log('Service stopped');
}
