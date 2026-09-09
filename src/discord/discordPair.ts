// ============================================
// OpenSwarm - Discord Pair System
//
// Worker/Reviewer pair session management.

import {
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
  ChannelType,
} from 'discord.js';
import * as linear from '../linear/index.js';
import * as dev from '../support/dev.js';
import * as agentPair from '../agents/agentPair.js';
import * as worker from '../agents/worker.js';
import * as reviewer from '../agents/reviewer.js';
import * as pairMetrics from '../agents/pairMetrics.js';
import * as pairWebhook from '../agents/pairWebhook.js';

import {
  pairModeConfig,
} from './discordCore.js';
import { t, getDateLocale } from '../locale/index.js';
import { safeConsole as console } from '../support/safeLog.js';

/**
 * !pair command handler
 */
export async function handlePair(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !pair or !pair status - Current status
  if (!subCommand || subCommand === 'status') {
    await handlePairStatus(msg);
    return;
  }

  // !pair start [taskId] - Start pair session
  if (subCommand === 'start') {
    const taskId = args[1];
    await handlePairStart(msg, taskId);
    return;
  }

  // !pair stop [sessionId] - Stop pair session
  if (subCommand === 'stop') {
    const sessionId = args[1];
    await handlePairStop(msg, sessionId);
    return;
  }

  // !pair stats - Show pair session statistics
  if (subCommand === 'stats') {
    await handlePairStats(msg);
    return;
  }

  // !pair run <taskId> <project> - Run pair session
  if (subCommand === 'run') {
    const taskId = args[1];
    const project = args[2];
    if (!taskId || !project) {
      await msg.reply(t('discord.pair.runUsage'));
      return;
    }
    await handlePairRun(msg, taskId, project);
    return;
  }

  // !pair history [limit] - Show recent pair sessions
  if (subCommand === 'history') {
    const limit = parseInt(args[1] || '10', 10);
    await handlePairHistory(msg, limit);
    return;
  }

  await msg.reply(t('discord.pair.unknownCommand'));
}

/**
 * !pair stats handler
 */
async function handlePairStats(msg: Message): Promise<void> {
  const stats = agentPair.getPairStats();
  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.statsTitle'))
    .setColor(0x00AE86)
    .addFields(
      { name: t('discord.pair.statsActive'), value: String(stats.activeSessions), inline: true },
      { name: t('discord.pair.statsCompleted'), value: String(stats.completedSessions), inline: true },
      { name: t('discord.pair.statsFailed'), value: String(stats.failedSessions), inline: true },
    );
  await msg.reply({ embeds: [embed] });
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * !pair status handler
 */
async function handlePairStatus(msg: Message): Promise<void> {
  const sessions = agentPair.getActiveSessions();
  if (sessions.length === 0) {
    await msg.reply(t('discord.pair.noActiveSessions'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.activeSessions'))
    .setColor(0x00AE86);

  for (const session of sessions) {
    const duration = formatDuration(Date.now() - session.startedAt);
    embed.addFields({
      name: `${session.taskId || t('discord.pair.unknownTask')}`,
      value: `${t('discord.pair.status')}: ${session.status}\n${t('discord.pair.duration')}: ${duration}`,
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !pair start handler
 */
async function handlePairStart(msg: Message, taskId?: string): Promise<void> {
  if (!taskId) {
    await msg.reply(t('discord.pair.startUsage'));
    return;
  }

  const sessionId = agentPair.createPairSession(taskId, msg.author.id);
  await msg.reply(t('discord.pair.sessionStarted', { sessionId }));
}

/**
 * !pair run handler
 */
async function handlePairRun(msg: Message, taskId: string, project: string): Promise<void> {
  const sessionId = agentPair.createPairSession(taskId, msg.author.id, project);
  await msg.reply(t('discord.pair.sessionStarted', { sessionId }));

  // Start pair session in background
  const thread = await (msg.channel as TextChannel).threads.create({
    name: `pair-${taskId}`,
    autoArchiveDuration: 60,
    reason: 'Pair session thread',
  });

  startPairSession(sessionId, thread).catch(async (err) => {
    console.error('[Pair] Session error:', err);
    try {
      await thread.send(t('discord.pair.sessionError'));
    } catch { /* ignore */ }
  });
}

/**
 * Start a pair session
 */
async function startPairSession(
  sessionId: string,
  thread: ThreadChannel,
): Promise<void> {
  const session = agentPair.getPairSession(sessionId);
  if (!session) {
    await thread.send(t('discord.pair.sessionNotFound'));
    return;
  }

  agentPair.updateSessionStatus(sessionId, 'running');
  await thread.send(t('discord.pair.sessionStarted', { sessionId }));

  // Run the pair loop
  await runPairLoop(sessionId, thread);
}

/**
 * Truncate and neutralize a worker report string before posting to Discord.
 * Caps total length at 4096 characters and strips content that could be
 * attacker-controlled or excessively verbose.
 */
function sanitizeReport(report: string): string {
  // Hard cap at 4096 characters (Discord embed field limit is 1024, but
  // thread.send accepts longer text; 4096 is a safe bound for a single message).
  if (report.length > 4096) {
    report = report.slice(0, 4093) + '...';
  }
  return report;
}

/**
 * Main pair loop
 */
async function runPairLoop(
  sessionId: string,
  thread: ThreadChannel,
): Promise<void> {
  let session = agentPair.getPairSession(sessionId);
  if (!session) return;

  let lastWorkerResult: worker.WorkerResult | null = null;
  let previousFeedback: string | undefined;

  while (session && session.status === 'running') {
    // === Worker Execution ===
    agentPair.updateSessionStatus(sessionId, 'working');
    await thread.send(t('discord.pair.workerStarting'));

    const workerResult = await worker.runWorker({
      task: session.task,
      projectPath: session.projectPath,
      previousFeedback,
      timeoutMs: 300000, // 5 minutes
      issueIdentifier: session.taskId,
    });

    session = agentPair.getPairSession(sessionId);
    if (!session || session.status === 'cancelled') {
      return;
    }

    lastWorkerResult = workerResult;
    agentPair.saveWorkerResult(sessionId, workerResult);
    // Sanitize and bound the worker report before posting to Discord
    const report = sanitizeReport(worker.formatWorkReport(workerResult, {
      issueIdentifier: session.taskId,
      projectPath: session.projectPath,
    }));
    await thread.send(report);

    // On Worker failure, retry or exit
    if (!workerResult.success) {
      if (!agentPair.canRetry(sessionId)) {
        agentPair.updateSessionStatus(sessionId, 'failed');
        await thread.send(t('discord.pair.maxAttemptsExceeded'));

        // Log failure in Linear
        try {
          await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
            `Worker failed after max attempts (${session.worker.maxAttempts}) exceeded`);
        } catch (err) {
          console.error('[Pair] Linear logPairFailed failed:', err);
        }

        // Send final summary
        await sendFinalSummary(thread, session, 'failed');
        return;
      }
      continue;
    }

    // === Reviewer Execution ===
    agentPair.updateSessionStatus(sessionId, 'reviewing');
    await thread.send(t('discord.pair.reviewerStarting'));

    // Log review start in Linear
    try {
      await linear.logPairReview(session.taskId, sessionId, session.worker.attempts);
    } catch (err) {
      console.error('[Pair] Linear logPairReview failed:', err);
    }

    const reviewResult = await reviewer.runReviewer({
      task: session.task,
      projectPath: session.projectPath,
      workerResult,
      issueIdentifier: session.taskId,
    });

    session = agentPair.getPairSession(sessionId);
    if (!session || session.status === 'cancelled') {
      return;
    }

    // Handle review result
    if (reviewResult.approved) {
      agentPair.updateSessionStatus(sessionId, 'approved');
      await thread.send(t('discord.pair.reviewApproved'));

      // Log approval in Linear
      try {
        await linear.logPairApproved(session.taskId, sessionId);
      } catch (err) {
        console.error('[Pair] Linear logPairApproved failed:', err);
      }

      // Send final summary
      await sendFinalSummary(thread, session, 'approved');
      return;
    }

    // Rejected - no more retries
    if (!agentPair.canRetry(sessionId)) {
      agentPair.updateSessionStatus(sessionId, 'rejected');
      await thread.send(t('discord.pair.reviewRejected'));

      try {
        await linear.logPairRejected(session.taskId, sessionId,
          reviewResult.feedback, reviewResult.issues || []);
      } catch (err) {
        console.error('[Pair] Linear logPairRejected failed:', err);
      }

      await sendFinalSummary(thread, session, 'rejected');
      return;
    }

    // revise: Worker will fix in next loop iteration
    if (!agentPair.canRetry(sessionId)) {
      agentPair.updateSessionStatus(sessionId, 'failed');
      await thread.send(t('discord.pair.maxAttemptsEnd'));

      try {
        await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
          `Max attempts (${session.worker.maxAttempts}) exceeded`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      await sendFinalSummary(thread, session, 'failed');
      return;
    }

    // Log revision request in Linear
    try {
      await linear.logPairRevision(session.taskId, sessionId,
        reviewResult.feedback, reviewResult.issues || []);
    } catch (err) {
      console.error('[Pair] Linear logPairRevision failed:', err);
    }

    agentPair.updateSessionStatus(sessionId, 'revising');
    await thread.send(t('discord.pair.revisionNeeded'));
  }

  // Max attempts exceeded
  session = agentPair.getPairSession(sessionId);
  if (session) {
    agentPair.updateSessionStatus(sessionId, 'failed');
    await thread.send(t('discord.pair.maxAttemptsEnd'));

    try {
      await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
        `Max attempts (${session.worker.maxAttempts}) exceeded`);
    } catch (err) {
      console.error('[Pair] Linear logPairFailed failed:', err);
    }

    await sendFinalSummary(thread, session, 'failed');
  }
}

/**
 * Send final summary Embed
 */
async function sendFinalSummary(
  thread: ThreadChannel,
  session: agentPair.PairSession,
  result: 'approved' | 'rejected' | 'failed' | 'cancelled'
): Promise<void> {
  const finishedAt = Date.now();
  const durationMs = finishedAt - session.startedAt;
  const duration = Math.round(durationMs / 1000);

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.finalSummary'))
    .setColor(result === 'approved' ? 0x00FF00 : 0xFF0000)
    .addFields(
      { name: t('discord.pair.result'), value: result, inline: true },
      { name: t('discord.pair.duration'), value: `${duration}s`, inline: true },
    );

  if (session.taskId) {
    embed.addFields({ name: t('discord.pair.taskId'), value: session.taskId, inline: true });
  }

  await thread.send({ embeds: [embed] });
}

/**
 * Format discussion summary
 */
function formatDiscussionSummary(session: agentPair.PairSession): string {
  const lines: string[] = [];
  lines.push(t('discord.pair.discussionSummary'));
  lines.push('');
  lines.push(`${t('discord.pair.taskId')}: ${session.taskId || t('discord.pair.unknown')}`);
  lines.push(`${t('discord.pair.status')}: ${session.status}`);
  lines.push(`${t('discord.pair.duration')}: ${formatDuration(Date.now() - session.startedAt)}`);

  if (session.worker.attempts > 0) {
    lines.push(`${t('discord.pair.workerAttempts')}: ${session.worker.attempts}`);
  }

  return lines.join('\n');
}

/**
 * !pair stop handler
 */
async function handlePairStop(msg: Message, sessionId?: string): Promise<void> {
  if (!sessionId) {
    await msg.reply(t('discord.pair.stopUsage'));
    return;
  }

  const session = agentPair.getPairSession(sessionId);
  if (!session) {
    await msg.reply(t('discord.pair.sessionNotFound'));
    return;
  }

  agentPair.updateSessionStatus(sessionId, 'cancelled');
  await msg.reply(t('discord.pair.sessionStopped', { sessionId }));
}

/**
 * !pair history handler
 */
async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const sessions = agentPair.getRecentSessions(limit);
  if (sessions.length === 0) {
    await msg.reply(t('discord.pair.noHistory'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.historyTitle'))
    .setColor(0x00AE86);

  for (const session of sessions) {
    embed.addFields({
      name: session.taskId || t('discord.pair.unknownTask'),
      value: `${t('discord.pair.status')}: ${session.status}\n${t('discord.pair.duration')}: ${formatDuration(session.duration)}`,
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}