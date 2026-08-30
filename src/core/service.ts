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
import { createNotifier } from '../notify/notifier.js';
import { selectTaskSource } from '../automation/taskSource.js';
import { PRProcessor, type PRProcessorConfig } from '../automation/prProcessor.js';
import { startCIWorker, stopCIWorker } from '../automation/ciWorker.js';
import { initMonitors } from '../automation/longRunningMonitor.js';
import * as dailyReporter from '../automation/dailyReporter.js';
import { initLocale, t } from '../locale/index.js';
import { initRateLimiters, destroyRateLimiters } from '../support/rateLimiter.js';
import { compactMemoryTable, shouldCompact, cleanupBackupFiles } from '../memory/compaction.js';
import { Cron } from 'croner';
import { setDefaultAdapter } from '../adapters/index.js';
import { readProviderOverride, formatProviderOverrideMismatchWarning } from './providerOverride.js';
import { enrichTaskFromState, hydrateTaskStateFromComments, updateTaskLinearState } from '../taskState/store.js';
import { probeDaemonPort } from '../cli/daemon.js';
import { rotateServiceLogs } from '../support/logRotation.js';
import { acquireServiceInstanceLock, type ServiceInstanceLock } from '../support/serviceInstanceLock.js';

let state: ServiceState = {
  running: false,
  agents: new Map(),
  timers: new Map(),
};

let githubRepos: string[] = [];
let githubCheckTimer: NodeJS.Timeout | null = null;
let prProcessor: PRProcessor | null = null;
let memoryCompactionJob: Cron | null = null;
let serviceInstanceLock: ServiceInstanceLock | null = null;

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
  if (serviceInstanceLock) throw new Error('OpenSwarm service is already starting or running in this process');
  const lock = acquireServiceInstanceLock();
  serviceInstanceLock = lock;
  try {
    await startServiceLocked(config);
  } catch (error) {
    try {
      await stopServiceLocked();
    } catch (cleanupError) {
      console.error('[Service] Startup rollback was incomplete:', cleanupError);
    }
    if (serviceInstanceLock === lock) {
      lock.release();
      serviceInstanceLock = null;
    }
    throw error;
  }
}

async function startServiceLocked(config: SwarmConfig): Promise<void> {
  let postMergeIntegration: PRProcessorConfig['postMergeIntegration'];
  // The lifetime SQLite lock above is the atomic single-instance authority.
  // Keep the port probe as a diagnostic for older daemons or unrelated
  // processes that predate/do not own that lock. Refuse to start if another instance — however it was
  // launched (`openswarm start`, launchd, or a stray manual `node dist/index.js`)
  // — is already serving the API port. `openswarm start` already checks this via
  // startDaemon(), but launchd's plist invokes `node dist/index.js` directly and
  // a manual invocation skips the CLI entirely, so neither path went through that
  // check. Real incident: a launchd kickstart spawned a second daemon alongside
  // an already-running one; both raced on the same Linear queue AND the same
  // unlocked local state files, silently losing each other's failure-counter
  // writes so structurally-failing tasks never reached the STUCK threshold and
  // retried forever instead. (INT-2570)
  if (await probeDaemonPort()) {
    throw new Error(
      'Another OpenSwarm instance is already serving port 3847 — refusing to start a duplicate. ' +
      "Check for stray processes ('ps aux | grep dist/index.js') or restart the managed one " +
      "('launchctl kickstart -k gui/$UID/com.intrect.openswarm')."
    );
  }

  const rotatedLogs = rotateServiceLogs();
  console.log('Starting OpenSwarm service...');
  if (rotatedLogs.rotated.length > 0) {
    console.log(`[Service] Rotated oversized logs: ${rotatedLogs.rotated.join(', ')}`);
  }

  // Locale initialization
  initLocale(config.language);

  // Default CLI adapter
  setDefaultAdapter(config.adapter ?? 'codex');
  console.log(`🛠️ CLI adapter: ${config.adapter ?? 'codex'}`);

  // Rate limiter initialization
  console.log('⚡ Initializing rate limiters...');
  initRateLimiters();
  console.log('✅ Rate limiters ready');

  // Linear initialization (optional). Prefer an OAuth profile (linear:default,
  // from `openswarm auth login --provider linear`) over a personal API key.
  // Startup uses ensureValidToken (refreshes if near expiry). NOTE: long-running
  // OAuth-token refresh during runtime is a follow-up — startup token is used.
  if (config.linearTeamId) {
    const { AuthProfileStore, ensureValidToken } = await import('../auth/index.js');
    const authStore = new AuthProfileStore();
    if (authStore.getProfile('linear:default')) {
      console.log('🔗 Initializing Linear client (OAuth)...');
      const token = await ensureValidToken(authStore, 'linear:default');
      linear.initLinear(token, config.linearTeamId, true);
      console.log('✅ Linear client connected (OAuth)');
    } else if (config.linearApiKey) {
      console.log('🔗 Initializing Linear client...');
      linear.initLinear(config.linearApiKey, config.linearTeamId);
      console.log('✅ Linear client connected');
    } else {
      console.log('⏭ Linear not configured — skipping');
    }
  } else {
    console.log('⏭ Linear not configured — skipping');
  }

  // Discord initialization (optional)
  if (config.discordToken && config.discordChannelId) {
    console.log('🤖 Connecting Discord bot...');
    await discord.initDiscord(config.discordToken, config.discordChannelId);
    console.log('✅ Discord bot connected successfully');
  } else {
    console.log('⏭ Discord not configured — skipping');
  }

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

  // Start the runner whenever an autonomous section exists at all. With
  // `enabled: false` it comes up in explicit-dispatch mode: no heartbeat cron,
  // no self-selected backlog work — but durable recovery, worktree pruning,
  // and user-initiated dispatch (POST /api/work, dashboard buttons) all keep
  // working. `enabled: true` additionally turns the heartbeat on. (INT-3388)
  if (config.autonomous) {
    const heartbeatEnabled = config.autonomous.enabled === true;
    console.log(heartbeatEnabled
      ? '[Service] Autonomous mode auto-start enabled'
      : '[Service] Autonomous runner starting in explicit-dispatch mode (heartbeat off)');

    // Select the task source: Linear when configured, else the local SQLite
    // store (no external account). The Linear fetcher closure is preserved
    // verbatim — slim mode (1 resolver call/issue vs 3) + comment hydration +
    // task-state enrichment — and only used by LinearTaskSource.
    const linearConfigured = !!(config.linearApiKey && config.linearTeamId);
    const selectedTaskSource = selectTaskSource(linearConfigured, async () => {
      await linear.ensureLinearAuthFresh(); // refresh OAuth token (no-op for API key) each heartbeat
      const issues = await linear.getMyIssues({ slim: true, timeoutMs: 300000 });
      const { linearIssueToTask } = await import('../orchestration/decisionEngine.js');
      return issues.map((issue: any) => {
        updateTaskLinearState(issue.id, issue.state);
        hydrateTaskStateFromComments(issue.id, issue.comments || []);
        return enrichTaskFromState(linearIssueToTask({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          state: issue.state,
          labels: issue.labels,
          blockedBy: issue.blockedBy,
          updatedAt: issue.updatedAt,
          project: issue.project ? {
            id: issue.project.id,
            name: issue.project.name,
          } : undefined,
        }));
      });
    });
    autonomous.setTaskSource(selectedTaskSource);
    console.log(`[Service] Task source registered (${linearConfigured ? 'linear' : 'local'})`);

    // Register the notifier for the configured channel (Discord/Slack/Telegram/
    // webhook). Discord's sender is injected so the notifier stays decoupled.
    const notifier = createNotifier(config.notifications, async (content: any) => {
      await discord.sendToChannel(content);
    });
    autonomous.setNotifier(notifier);
    console.log(`[Service] Notifier registered (${config.notifications?.channel ?? 'discord'})`);

    const runnerInstance = await autonomous.startAutonomous({
      defaultAdapter: config.adapter,
      linearTeamId: config.linearTeamId,
      allowedProjects: config.autonomous.allowedProjects,
      includeBacklog: config.autonomous.includeBacklog,
      heartbeatSchedule: config.autonomous.schedule,
      autoExecute: true,
      dryRun: false,
      pairMode: config.autonomous.pairMode,
      pairMaxAttempts: config.autonomous.maxAttempts,
      workerModel: config.autonomous.models?.worker,
      reviewerModel: config.autonomous.models?.reviewer,
      workerTimeoutMs: config.autonomous.workerTimeoutMs || 0, // 0 = unlimited
      reviewerTimeoutMs: config.autonomous.reviewerTimeoutMs || 0, // 0 = unlimited
      autonomousHeartbeat: heartbeatEnabled,
      triggerNow: heartbeatEnabled,  // Execute immediately on start (heartbeat mode only)
      maxConcurrentTasks: config.autonomous.maxConcurrentTasks,
      stalledInProgressHours: config.autonomous.stalledInProgressHours,
      maxConcurrentPerProject: config.autonomous.maxConcurrentPerProject,
      automationLedgerMode: config.autonomous.automationLedgerMode,
      automationDbPath: config.autonomous.automationDbPath,
      automationLeaseMs: config.autonomous.automationLeaseMs,
      shutdownGraceMs: config.autonomous.shutdownGraceMs,
      allowSameProjectConcurrent: config.autonomous.allowSameProjectConcurrent,
      defaultRoles: config.autonomous.defaultRoles,
      projectAgents: config.autonomous.projectAgents,
      // Task decomposition (Planner) configuration. The whole object is passed,
      // not a hand-picked subset: the runner reads maxDepth, maxChildrenPerTask,
      // dailyLimit and autoBacklog straight off `config.decomposition`, and
      // forwarding only the four below left every one of them undefined, so the
      // code defaults silently overrode the operator's file. Measured: a
      // configured dailyLimit of 5 ran as 20 and produced 23 issues in two
      // minutes. Forwarding the object means a field added later cannot go
      // missing the same way. (AGT-4122)
      decomposition: config.autonomous.decomposition,
      enableDecomposition: config.autonomous.decomposition?.enabled ?? false,
      decompositionThresholdMinutes: config.autonomous.decomposition?.thresholdMinutes ?? 30,
      plannerModel: config.autonomous.decomposition?.plannerModel,
      plannerTimeoutMs: config.autonomous.decomposition?.plannerTimeoutMs,
      backlogGrooming: config.autonomous.backlogGrooming,
      // Git worktree mode
      worktreeMode: config.autonomous.worktreeMode ?? false,
      // Pipeline guards
      guards: config.autonomous.guards,
      verify: config.autonomous.verify,
      securityAudit: config.autonomous.securityAudit,
      // Bad-edit / reflection self-repair budget
      maxReflections: config.autonomous.maxReflections,
      jobProfiles: config.autonomous.jobProfiles,
      coordinationBoardIssueId: config.autonomous.coordinationBoardIssueId,
      mcpPolicies: config.autonomous.mcpPolicies,
      adapterRouting: config.autonomous.adapterRouting,
      periodicReviews: config.autonomous.periodicReviews,
      orchestrator: config.autonomous.orchestrator,
      orchestratorSchedule: config.autonomous.orchestratorSchedule,
    });
    postMergeIntegration = {
      getActiveLeaseBranches: (projectPath) => runnerInstance.getActiveIntegrationBranches(projectPath),
      getActiveLeaseIdentifiers: (projectPath) => runnerInstance.getActiveIntegrationIssues(projectPath),
      withIntegrationReservation: (projectPath, branch, issueIdentifier, operation) =>
        runnerInstance.withIntegrationReservation(projectPath, branch, issueIdentifier, operation),
      routeConflict: (evidence) => runnerInstance.routeIntegrationConflict(evidence),
    };
    if (config.autonomous.coordinationBoardIssueId) {
      const { TrackerCoordinationBoard } = await import('../coordination/linearBoard.js');
      const board = new TrackerCoordinationBoard(selectedTaskSource, config.autonomous.coordinationBoardIssueId);
      const store = (await import('../coordination/coordinationStore.js')).getCoordinationStore();
      const hub = (await import('./eventHub.js')).getEventHub();
      hub.on('coordination:published', (event) => { void board.publish(event).catch((error) => console.error('[CoordinationBoard] publish failed:', error)); });
      // Import messages posted by another host/session. Local fingerprinting makes this idempotent.
      const remote = await board.read().catch((error) => { console.error('[CoordinationBoard] initial read failed:', error); return []; });
      for (const event of remote) await store.publish(event);
      console.log(`[Service] Coordination board registered (${config.autonomous.coordinationBoardIssueId})`);
    }
    web.setWebRunner(runnerInstance);
    // Re-apply the persisted provider toggle: switchProvider() is in-memory only, so without this a
    // restart silently reverts to config.yaml's adapter. Reusing switchProvider keeps the role +
    // jobProfile remapping identical to a live dashboard toggle.
    const providerOverride = readProviderOverride();
    if (providerOverride && providerOverride !== (config.adapter ?? 'codex')) {
      setDefaultAdapter(providerOverride);
      runnerInstance.switchProvider(providerOverride);
      // The override silently wins over config.yaml — make that divergence loud so the
      // operator isn't left wondering why the daemon runs a different provider than
      // config.yaml declares. Behaviour is unchanged; only visibility. (INT-2408)
      console.warn(formatProviderOverrideMismatchWarning(providerOverride, config.adapter ?? 'codex'));
    }
    const modelInfo = config.autonomous.models
      ? `, Worker: ${config.autonomous.models.worker || 'default'}, Reviewer: ${config.autonomous.models.reviewer || 'default'}`
      : '';
    console.log(heartbeatEnabled
      ? `[Service] Autonomous runner started (pairMode: ${config.autonomous.pairMode}, schedule: ${config.autonomous.schedule}${modelInfo})`
      : `[Service] Autonomous runner ready for explicit dispatch (pairMode: ${config.autonomous.pairMode}${modelInfo})`);
  }

  // Start PR Auto-Improvement
  if (config.prProcessor?.enabled && githubRepos.length > 0) {
    prProcessor = new PRProcessor({
      repos: githubRepos,
      schedule: config.prProcessor.schedule,
      maxIterations: config.prProcessor.maxIterations,
      roles: config.autonomous?.defaultRoles,
      maxRetries: config.prProcessor.maxRetries,
      ciTimeoutMs: config.prProcessor.ciTimeoutMs,
      ciPollIntervalMs: config.prProcessor.ciPollIntervalMs,
      conflictResolver: config.prProcessor.conflictResolver,
      repoMappings: config.prProcessor.repoMappings,
      postMergeIntegration,
      // PR remediation is an autonomous editing path; inherit the same
      // baseline-diff CodeQL policy as heartbeat-dispatched work.
      securityAudit: config.autonomous?.securityAudit,
    });
    prProcessor.start();
    const resolverStatus = config.prProcessor.conflictResolver?.enabled ? ', conflictResolver: ON' : '';
    console.log(`[Service] PR Processor started (schedule: ${config.prProcessor.schedule}, repos: ${githubRepos.length}, maxRetries: ${config.prProcessor.maxRetries ?? 3}${resolverStatus})`);
  }

  // Start CI Worker
  if (config.ciWorker?.enabled && githubRepos.length > 0) {
    startCIWorker({
      repos: githubRepos,
      checkIntervalMs: config.ciWorker.checkIntervalMs,
      autoRetry: config.ciWorker.autoRetry,
      createIssues: config.ciWorker.createIssues,
      maxAgeDays: config.ciWorker.maxAgeDays,
    });
    const features = [
      config.ciWorker.autoRetry && 'auto-retry',
      config.ciWorker.createIssues && 'linear-issues',
    ].filter(Boolean).join(', ');
    console.log(`[Service] CI Worker started (interval: ${(config.ciWorker.checkIntervalMs ?? 300000) / 1000}s, repos: ${githubRepos.length}, features: ${features || 'monitor-only'})`);
  }

  // Initialize long-running monitors
  if (config.monitors?.length) {
    initMonitors(config.monitors);
    console.log(`[Service] Long-running monitors initialized (${config.monitors.length} from config)`);
  } else {
    initMonitors(); // Restore only from persisted files
  }

  // Start daily status reporter
  if (config.dailyReporter?.enabled) {
    dailyReporter.setLinearClient(linear.getClient());
    dailyReporter.setTeamId(config.linearTeamId);
    dailyReporter.setDailyReporterDiscord(async (content: any) => {
      await discord.sendToChannel(content);
    });
    dailyReporter.startDailyReporter(config.dailyReporter);
    console.log(`[Service] Daily reporter started (schedule: ${config.dailyReporter.schedule || '18:00 daily'})`);
  }

  // Sweep attachments once on the way up as well. The daily job is the only
  // other caller, so a daemon that is restarted each morning before 2 AM would
  // otherwise never prune at all, and uploads would accumulate until the volume
  // filled (AGT-4031). Not awaited: startup does not wait on housekeeping.
  void (async () => {
    try {
      const { pruneAttachments } = await import('../coordination/attachmentStore.js');
      const removed = await pruneAttachments();
      if (removed > 0) console.log(`[Service] Removed ${removed} chat attachment(s) on startup`);
    } catch (error) { // cxt-ignore: error_swallow — housekeeping must not block startup
      console.warn('[Service] Attachment sweep failed:', error instanceof Error ? error.message : error);
    }
  })();

  // Memory compaction scheduler (daily at 2 AM)
  console.log('[Service] Scheduling memory compaction (daily at 2 AM)...');
  memoryCompactionJob = Cron('0 2 * * *', async () => {
    console.log('[Compaction] Daily compaction triggered');

    try {
      // Clean up backup files first
      await cleanupBackupFiles();

      // Operator chat attachments live on the same volume as the daemon's own
      // state and every worktree, so they cannot accumulate forever — a per
      // upload cap bounds one file, not the total (AGT-4031).
      try {
        const { pruneAttachments } = await import('../coordination/attachmentStore.js');
        const removed = await pruneAttachments();
        // Not all of these expired: the sweep also reclaims to stay under the
        // total ceiling. Calling every removal an expiry would misexplain the
        // one line an operator reads when an agent reports a missing file.
        if (removed > 0) console.log(`[Compaction] Removed ${removed} chat attachment(s) (expired or over the storage ceiling)`);
      } catch (error) { // cxt-ignore: error_swallow — a failed sweep must not abort compaction
        console.warn('[Compaction] Attachment sweep failed:', error instanceof Error ? error.message : error);
      }

      // Check if compaction is needed
      const needed = await shouldCompact();
      if (needed) {
        const stats = await compactMemoryTable();
        console.log(`[Compaction] Success: ${stats.before} → ${stats.after} records (-${stats.removed})`);

        // Report compaction success (skip Discord notification for routine maintenance)
        console.log(`[Compaction] Reported: ${stats.before} → ${stats.after} records`);
      } else {
        console.log('[Compaction] Skipped (not needed)');
      }
    } catch (error) {
      console.error('[Compaction] Failed:', error);
      // Error already logged above
    }
  });
  console.log('[Service] Memory compaction scheduled');

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
  await stopServiceLocked();
  serviceInstanceLock?.release();
  serviceInstanceLock = null;
}

async function stopServiceLocked(): Promise<void> {
  console.log('Stopping OpenSwarm service...');
  const cleanupErrors: unknown[] = [];
  const cleanup = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
      console.error(`[Service] Failed to stop ${label}:`, error);
    }
  };

  // Stop task admission first and let real executors drain while their tracker,
  // notifier, rate limiter, and web dependencies are still alive.
  await cleanup('autonomous runner', () => autonomous.stopAutonomous());
  console.log('Autonomous runner stopped');

  // Clean up GitHub monitoring timer
  if (githubCheckTimer) {
    clearInterval(githubCheckTimer);
    githubCheckTimer = null;
    console.log('GitHub monitoring stopped');
  }

  // Stop memory compaction scheduler
  if (memoryCompactionJob) {
    memoryCompactionJob.stop();
    memoryCompactionJob = null;
    console.log('Memory compaction scheduler stopped');
  }

  // Clean up agent timers
  for (const [name, timer] of state.timers) {
    clearInterval(timer);
    console.log(`Timer stopped for ${name}`);
  }
  state.timers.clear();

  // Stop PR Processor
  if (prProcessor) {
    await cleanup('PR processor', () => prProcessor?.stop());
    prProcessor = null;
    console.log('PR Processor stopped');
  }

  // Stop CI Worker
  await cleanup('CI worker', () => stopCIWorker());
  console.log('CI Worker stopped');

  // Stop scheduler
  await cleanup('scheduler', () => scheduler.stopAllSchedules());
  console.log('Scheduler stopped');

  // Stop web server
  await cleanup('web server', () => web.stopWebServer());

  // Cleanup rate limiters
  await cleanup('rate limiters', () => destroyRateLimiters());
  console.log('Rate limiters destroyed');
  console.log('Web server stopped');

  // Shutdown Discord
  await cleanup('Discord', () => discord.stopDiscord());

  state.running = false;
  console.log('Service stopped');
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'OpenSwarm service shutdown was incomplete');
  }
}
