// ============================================
// OpenSwarm - Discord Pair System
//
// Worker/Reviewer pair session management.

import {
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
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

// Discord embed limits
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_NAME_LIMIT = 256;

/** Truncate a string to fit within Discord embed field limits, appending a marker. */
function truncateFieldValue(value: string, max = EMBED_FIELD_VALUE_LIMIT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 12)}\n…[truncated]`;
}

function truncateFieldName(name: string): string {
  if (name.length <= EMBED_FIELD_NAME_LIMIT) return name;
  return `${name.slice(0, EMBED_FIELD_NAME_LIMIT - 12)}…[truncated]`;
}

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

  // !pair stats - Show pair statistics
  if (subCommand === 'stats') {
    await handlePairStats(msg);
    return;
  }

  // !pair history [limit] - Show pair session history
  if (subCommand === 'history') {
    const limit = parseInt(args[1] || '5', 10);
    await handlePairHistory(msg, limit);
    return;
  }

  // Unknown subcommand
  await msg.reply(t('discord.pair.usage'));
}

/**
 * !pair stats - Show pair statistics
 */
export async function handlePairStats(msg: Message): Promise<void> {
  const stats = agentPair.getPairStats();

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.statsTitle'))
    .setColor(0x9b59b6)
    .setTimestamp();

  embed.addFields(
    { name: truncateFieldName(t('discord.pair.totalSessions')), value: truncateFieldValue(String(stats.totalSessions)), inline: true },
    { name: truncateFieldName(t('discord.pair.activeSessions')), value: truncateFieldValue(String(stats.activeSessions)), inline: true },
    { name: truncateFieldName(t('discord.pair.approvalRate')), value: truncateFieldValue(`${stats.approvalRate}%`), inline: true },
  );

  if (stats.averageDuration) {
    embed.addFields({ name: truncateFieldName(t('discord.pair.avgDuration')), value: truncateFieldValue(formatDuration(stats.averageDuration)), inline: true });
  }

  await msg.reply({ embeds: [embed] });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * !pair status - Show current pair session status
 */
export async function handlePairStatus(msg: Message): Promise<void> {
  const sessions = agentPair.listPairSessions();

  if (sessions.length === 0) {
    await msg.reply(t('discord.pair.noActiveSessions'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.statusTitle'))
    .setColor(0x00ae86)
    .setTimestamp();

  for (const session of sessions) {
    const value = `Task: ${session.taskTitle.slice(0, 80)}\nStatus: ${session.status}\nAttempts: ${session.worker.attempts}/${session.worker.maxAttempts}`;
    embed.addFields({
      name: truncateFieldName(`Session ${session.id}`),
      value: truncateFieldValue(value),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !pair start [taskId] - Start pair session
 */
export async function handlePairStart(msg: Message, taskId?: string): Promise<void> {
  if (!taskId) {
    await msg.reply(t('discord.pair.startUsage'));
    return;
  }

  // Check if already running
  const activeSessions = agentPair.listPairSessions();
  if (activeSessions.length > 0) {
    await msg.reply(`⚠️ ${t('discord.pair.alreadyRunning')}`);
    return;
  }

  // Resolve task
  const task = await linear.getTask(taskId);
  if (!task) {
    await msg.reply(`❌ ${t('discord.pair.taskNotFound', { id: taskId })}`);
    return;
  }

  // Create session
  const session = agentPair.createPairSession({
    taskId: task.id,
    taskTitle: task.title,
    projectPath: task.projectPath,
    requestedBy: msg.author.username,
  });

  // Create thread
  let thread: ThreadChannel;
  try {
    thread = await (msg.channel as TextChannel).threads.create({
      name: `pair-${task.id}-${Date.now().toString(36)}`,
      autoArchiveDuration: 60,
      reason: t('discord.pair.threadReason'),
    });
  } catch (err) {
    await msg.reply(`❌ ${t('discord.errors.threadCreateFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    agentPair.cancelSession(session.id);
    return;
  }

  // 3. Start message
  const startEmbed = new EmbedBuilder()
    .setTitle(truncateField(`📋 ${t('discord.pair.taskStartTitle', { title: truncateFieldValue(options.taskTitle, 80) })}`))
    .setColor(0x00AE86)
    .addFields(
      { name: truncateFieldName('Session ID'), value: truncateFieldValue(session.id), inline: true },
      { name: truncateFieldName('Task'), value: truncateFieldValue(options.taskId), inline: true },
      { name: truncateFieldName('Project'), value: truncateFieldValue(options.projectPath), inline: true },
    )
    .setTimestamp();

  await thread.send({ embeds: [startEmbed] });
  agentPair.addMessage(session.id, 'system', t('discord.pair.sessionStartMsg'));

  // 4. Start Worker/Reviewer loop (async)
  runPairLoop(session.id, thread).catch((err) => {
    console.error('[Pair] Loop error:', err);
    thread.send(`❌ ${t('discord.pair.loopError', { error: err instanceof Error ? err.message : String(err) })}`).catch(e => console.error('[Pair] Failed to post loop error:', e));
    agentPair.updateSessionStatus(session.id, 'failed');
  });

  // 5. Notify main channel
  await msg.reply(`👥 ${t('discord.pair.sessionStarted', { thread: String(thread) })}`);
}

/**
 * Run Worker/Reviewer loop
 */
async function runPairLoop(sessionId: string, thread: ThreadChannel): Promise<void> {
  let session = agentPair.getPairSession(sessionId);
  if (!session) return;

  // Log pair session start in Linear
  try {
    await linear.logPairStart(session.taskId, sessionId, session.projectPath);
  } catch (err) {
    console.error('[Pair] Linear logPairStart failed:', err);
  }

  // Save last Worker result (for statistics)
  let lastWorkerResult: agentPair.WorkerResult | null = null;

  while (agentPair.canRetry(sessionId)) {
    session = agentPair.getPairSession(sessionId);
    if (!session) return;

    // === Worker Phase ===
    agentPair.updateSessionStatus(sessionId, 'working');
    await thread.send(t('discord.pair.workerStarting'));

    const workerResult = await worker.runWorker(session.taskId, session.projectPath);
    lastWorkerResult = workerResult;

    agentPair.saveWorkerResult(sessionId, workerResult);
    await thread.send(t('discord.pair.workerComplete'));

    // === Reviewer Phase ===
    agentPair.updateSessionStatus(sessionId, 'reviewing');
    await thread.send(t('discord.pair.reviewerStarting'));

    const reviewResult = await reviewer.runReviewer({
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      workerResult,
      projectPath: session.projectPath,
    });

    agentPair.saveReviewerResult(sessionId, reviewResult);
    await thread.send(reviewer.formatReviewFeedback(reviewResult));

    // === Decision Processing ===
    if (reviewResult.decision === 'approve') {
      agentPair.updateSessionStatus(sessionId, 'approved');
      await thread.send(t('discord.pair.workApproved'));

      // Log completion in Linear
      try {
        const duration = Math.round((Date.now() - session.startedAt) / 1000);
        await linear.logPairComplete(session.taskId, sessionId, {
          attempts: session.worker.attempts,
          duration,
          filesChanged: lastWorkerResult?.filesChanged || [],
        });
      } catch (err) {
        console.error('[Pair] Linear logPairComplete failed:', err);
      }

      // Send final summary
      await sendFinalSummary(thread, session, 'approved');
      return;
    }

    if (reviewResult.decision === 'reject') {
      agentPair.updateSessionStatus(sessionId, 'rejected');
      await thread.send(t('discord.pair.workRejected'));

      // Log rejection in Linear
      try {
        await linear.logPairFailed(session.taskId, sessionId, 'rejected',
          `Feedback: ${reviewResult.feedback}\nIssues: ${reviewResult.issues?.join(', ') || 'none'}`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      await sendFinalSummary(thread, session, 'rejected');
      return;
    }

    // === Revision Phase ===
    agentPair.incrementAttempts(sessionId);
    session = agentPair.getPairSession(sessionId);
    if (!session) return;

    await thread.send(t('discord.pair.revisionNeeded'));

    // Log revision in Linear
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
  const durationStr = duration < 60
    ? t('common.duration.seconds', { n: duration })
    : `${Math.floor(duration / 60)}m ${duration % 60}s`;

  // Record metrics
  try {
    await pairMetrics.recordSession({
      sessionId: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      result,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs,
      filesChanged: session.worker.result?.filesChanged.length || 0,
      startedAt: session.startedAt,
      finishedAt,
    });
  } catch (err) {
    console.error('[Pair] Metrics recording failed:', err);
  }

  // Webhook notification
  if (session.webhookUrl && pairWebhook.isValidWebhookUrl(session.webhookUrl)) {
    try {
      await pairWebhook.sendNotification(session.webhookUrl, {
        type: 'session_complete',
        sessionId: session.id,
        taskId: session.taskId,
        taskTitle: session.taskTitle,
        result,
        attempts: session.worker.attempts,
        duration: durationStr,
      });
    } catch (err) {
      console.error('[Pair] Webhook notification failed:', err);
    }
  }

  // Build summary embed
  const summaryEmbed = new EmbedBuilder()
    .setTitle(t('discord.pair.summaryTitle'))
    .setColor(result === 'approved' ? 0x00ff41 : 0xff4444)
    .addFields(
      { name: truncateFieldName(t('discord.pair.result')), value: truncateFieldValue(result), inline: true },
      { name: truncateFieldName(t('discord.pair.attempts')), value: truncateFieldValue(`${session.worker.attempts}/${session.worker.maxAttempts}`), inline: true },
      { name: truncateFieldName(t('discord.pair.duration')), value: truncateFieldValue(durationStr), inline: true },
    )
    .setTimestamp();

  if (session.worker.result?.filesChanged?.length) {
    const files = session.worker.result.filesChanged.slice(0, 10);
    const fileList = files.map(f => `\`${f}\``).join(', ');
    summaryEmbed.addFields({
      name: truncateFieldName(t('discord.pair.filesChanged')),
      value: truncateFieldValue(fileList),
      inline: false,
    });
  }

  await thread.send({ embeds: [summaryEmbed] });
}

/**
 * !pair stop [sessionId] - Stop pair session
 */
export async function handlePairStop(msg: Message, sessionId?: string): Promise<void> {
  if (!sessionId) {
    await msg.reply(t('discord.pair.stopUsage'));
    return;
  }

  const success = agentPair.cancelSession(sessionId);
  if (success) {
    await msg.reply(`⏹️ ${t('discord.pair.stopped', { id: sessionId })}`);
  } else {
    await msg.reply(`❌ ${t('discord.pair.notFound', { id: sessionId })}`);
  }
}

/**
 * !pair history [limit] - Show pair session history
 */
export async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const history = agentPair.getSessionHistory(limit);

  if (history.length === 0) {
    await msg.reply(t('discord.pair.noHistory'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.historyTitle'))
    .setColor(0x9b59b6)
    .setTimestamp();

  for (const session of history) {
    embed.addFields({
      name: truncateFieldName(`${session.id}: ${session.taskTitle.slice(0, 40)}`),
      value: truncateFieldValue(agentPair.formatSessionSummary(session)),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}n history
 */
export async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const history = agentPair.getSessionHistory(limit);

  if (history.length === 0) {
    await msg.reply(t('discord.pair.noHistory'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.historyTitle'))
    .setColor(0x9b59b6)
    .setTimestamp();

  for (const session of history) {
    embed.addFields({
      name: truncateFieldName(`${session.id}: ${session.taskTitle.slice(0, 40)}`),
      value: truncateFieldValue(agentPair.formatSessionSummary(session)),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}