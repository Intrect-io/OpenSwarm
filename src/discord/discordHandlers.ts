// ============================================
// OpenSwarm - Discord Command Handlers
//
// All command handlers (!status, !dev, etc.)

import {
  TextChannel,
  Message,
  EmbedBuilder,
} from 'discord.js';
import { enforceEmbedLimits } from './embedUtils.js';
import * as linear from '../linear/index.js';
import * as github from '../github/index.js';
import * as dev from '../support/dev.js';
import * as scheduler from '../automation/scheduler.js';
import * as codex from '../memory/codex.js';
import * as autonomous from '../automation/autonomousRunner.js';
import { selectTaskSource } from '../automation/taskSource.js';
import { linearIssueToTask, TaskItem } from '../orchestration/decisionEngine.js';

import {
  onPauseAgent,
  onResumeAgent,
  getAgentStatus,
  getGithubRepos,
  pairModeConfig,
  formatTimeAgo,
} from './discordCore.js';
import { t, getDateLocale } from '../locale/index.js';

// Discord embed limits: 6000 total chars, 1024 per field value, 256 per field name
const EMBED_TOTAL_LIMIT = 6000;
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

/** Enforce total embed description limit with truncation. */
function truncateDescription(desc: string): string {
  if (desc.length <= EMBED_TOTAL_LIMIT) return desc;
  return `${desc.slice(0, EMBED_TOTAL_LIMIT - 12)}\n…[truncated]`;
}

/**
 * Helper: Reply with Embed for consistent Discord UI
 */
async function replyWithEmbed(msg: Message, content: string, color: number = 0x00ff41): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(truncateDescription(content))
    .setTitle(truncateField(title))
    .setAuthor({ name: truncateField(authorName) })
    .setFooter({ text: truncateField(footerText) })
    .setColor(color)
    .setTimestamp();
  await msg.reply({ embeds: [embed] });
}

/**
 * !status [session] - Check status
 */
export async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
  if (!getAgentStatus) {
    await replyWithEmbed(msg, t('discord.errors.noStatusFn'));
    return;
  }

  const status = getAgentStatus(sessionName);
  if (!status) {
    await replyWithEmbed(msg, t('discord.status.noSession', { session: sessionName || 'default' }));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.status.title'))
    .setColor(0x00ae86)
    .setTimestamp();

  embed.addFields(
    { name: truncateFieldName(t('discord.status.session')), value: truncateFieldValue(status.sessionName || 'default'), inline: true },
    { name: truncateFieldName(t('discord.status.state')), value: truncateFieldValue(status.state), inline: true },
    { name: truncateFieldName(t('discord.status.task')), value: truncateFieldValue(status.currentTask || t('discord.status.noTask')), inline: true },
  );

  if (status.currentRepo) {
    embed.addFields({ name: truncateFieldName(t('discord.status.repo')), value: truncateFieldValue(status.currentRepo), inline: true });
  }

  if (status.currentBranch) {
    embed.addFields({ name: truncateFieldName(t('discord.status.branch')), value: truncateFieldValue(status.currentBranch), inline: true });
  }

  if (status.uptime) {
    embed.addFields({ name: truncateFieldName(t('discord.status.uptime')), value: truncateFieldValue(status.uptime), inline: true });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !list - List active sessions
 */
export async function handleList(msg: Message): Promise<void> {
  if (!getAgentStatus) {
    await replyWithEmbed(msg, t('discord.errors.noStatusFn'));
    return;
  }

  const sessions = getAgentStatus();
  if (!sessions || (Array.isArray(sessions) && sessions.length === 0)) {
    await replyWithEmbed(msg, t('discord.list.noSessions'));
    return;
  }

  const sessionList = Array.isArray(sessions) ? sessions : [sessions];
  const embed = new EmbedBuilder()
    .setTitle(t('discord.list.title'))
    .setColor(0x00ae86)
    .setTimestamp();

  for (const s of sessionList) {
    const value = `State: ${s.state}\nTask: ${s.currentTask || 'none'}\nRepo: ${s.currentRepo || 'none'}`;
    embed.addFields({
      name: truncateFieldName(s.sessionName || 'default'),
      value: truncateFieldValue(value),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !run <session> - Run a session
 */
export async function handleRun(msg: Message, _args: string[]): Promise<void> {
  await replyWithEmbed(msg, t('discord.run.notImplemented'));
}

/**
 * !pause <session> - Pause a session
 */
export async function handlePause(msg: Message, sessionName: string): Promise<void> {
  if (!onPauseAgent) {
    await replyWithEmbed(msg, t('discord.errors.noPauseFn'));
    return;
  }

  const success = onPauseAgent(sessionName);
  if (success) {
    await msg.reply(`⏸️ ${t('discord.pause.paused', { session: sessionName })}`);
  } else {
    await msg.reply(`❌ ${t('discord.pause.notFound', { session: sessionName })}`);
  }
}

/**
 * !resume <session> - Resume a session
 */
export async function handleResume(msg: Message, sessionName: string): Promise<void> {
  if (!onResumeAgent) {
    await replyWithEmbed(msg, t('discord.errors.noResumeFn'));
    return;
  }

  const success = onResumeAgent(sessionName);
  if (success) {
    await msg.reply(`▶️ ${t('discord.resume.resumed', { session: sessionName })}`);
  } else {
    await msg.reply(`❌ ${t('discord.resume.notFound', { session: sessionName })}`);
  }
}

/**
 * !issues [session] - List issues
 */
export async function handleIssues(msg: Message, sessionName?: string): Promise<void> {
  await replyWithEmbed(msg, t('discord.issues.notImplemented'));
}

/**
 * !issue <id> - Show issue details
 */
export async function handleIssue(msg: Message, issueId: string): Promise<void> {
  await replyWithEmbed(msg, t('discord.issue.notImplemented'));
}

/**
 * !log <session> [lines] - Show recent log lines
 */
export async function handleLog(msg: Message, _sessionName: string, _lines: number): Promise<void> {
  await replyWithEmbed(msg, t('discord.log.notImplemented'));
}

/**
 * !ci - Show CI status
 */
export async function handleCI(msg: Message): Promise<void> {
  await replyWithEmbed(msg, t('discord.ci.notImplemented'));
}

/**
 * !notifications - Show notifications
 */
export async function handleNotifications(msg: Message): Promise<void> {
  await replyWithEmbed(msg, t('discord.notifications.notImplemented'));
}

/**
 * !dev [repo] [task] - Start dev task
 */
export async function handleDev(msg: Message, args: string[]): Promise<void> {
  const repo = args[0] || 'default';
  const task = args.slice(1).join(' ') || t('discord.dev.defaultTask');

  // Check if already running
  const activeTasks = dev.getActiveTasks();
  if (activeTasks.length > 0) {
    await msg.reply(`⚠️ ${t('discord.dev.alreadyRunning', { count: activeTasks.length })}`);
    return;
  }

  // Start progress reporting
  const stopProgressReporting = startProgressReporting(msg);

  // Run dev task
  const result = await dev.runDevTask(repo, task, {
    onProgress: (progress: string) => {
      if (progress) {
        msg.reply(`⏳ ${progress}`);
      }
    },
    onComplete: (output: string, exitCode: number | null) => {
      // The task's actual end, for both a normal close and a spawn error.
      stopProgressReporting();

      // Split result for sending (Discord 2000 char limit)
      const MAX_LEN = 1800;
      const truncated = output.length > MAX_LEN * 3
        ? `...(${output.length - MAX_LEN * 3} chars omitted)\n\n${output.slice(-MAX_LEN * 3)}`
        : output;

      const statusEmoji = exitCode === 0 ? '✅' : '⚠️';
      const header = `${statusEmoji} ${t('discord.dev.completed', { repo, exitCode: exitCode ?? 'unknown' })}`;

      // If result is short, send at once
      if (truncated.length <= MAX_LEN) {
        await msg.reply(`${header}\n\`\`\`\n${truncated || t('discord.dev.noOutput')}\n\`\`\``);
      } else {
        // If result is long, split
        await msg.reply(header);

        const chunks = [];
        for (let i = 0; i < truncated.length; i += MAX_LEN) {
          chunks.push(truncated.slice(i, i + MAX_LEN));
        }

        for (let i = 0; i < Math.min(chunks.length, 3); i++) {
          await msg.reply(`\`\`\`\n${chunks[i]}\n\`\`\``);
        }

        if (chunks.length > 3) {
          await msg.reply(t('discord.dev.outputTooLong', { shown: 3, total: chunks.length }));
        }
      }
    }
    );
  } catch (err) {
    // runDevTask threw before the child was registered (e.g. spawn failed), so
    // onComplete will never fire. Previously this propagated out of handleDev
    // with the timer still armed, and a stale "in progress" reply arrived ten
    // seconds after the error had already been reported to the user.
    stopProgressReporting();
    throw err;
  }

  if ('error' in result) {
    // Rejected before launch — time window, unknown repo, task already running.
    // No child process exists, so nothing will ever call onComplete.
    stopProgressReporting();
    await msg.reply(`❌ ${result.error}`);
  }
}

/**
 * !repos - List known repositories
 */
export async function handleRepos(msg: Message): Promise<void> {
  const repos = dev.listKnownRepos();

  const embed = new EmbedBuilder()
    .setTitle(t('discord.repos.title'))
    .setColor(0x00ae86)
    .setDescription(t('discord.repos.description'));

  const available = repos.filter(r => r.exists);
  const unavailable = repos.filter(r => !r.exists);

  if (available.length > 0) {
    embed.addFields({
      name: truncateFieldName(`✅ ${t('discord.repos.available')}`),
      value: truncateFieldValue(available.map(r => `\`${r.alias}\` → ${r.path}`).join('\n')),
      inline: false,
    });
  }

  if (unavailable.length > 0) {
    embed.addFields({
      name: truncateFieldName(`❌ ${t('discord.repos.unavailable')}`),
      value: truncateFieldValue(unavailable.map(r => `\`${r.alias}\` → ${r.path}`).join('\n')),
      inline: false,
    });
  }

  embed.addFields({
    name: truncateFieldName(`💡 ${t('discord.repos.tip')}`),
    value: truncateFieldValue(t('discord.repos.tipContent')),
    inline: false,
  });

  await msg.reply({ embeds: [embed] });
}

/**
 * !tasks - List running dev tasks
 */
export async function handleTasks(msg: Message): Promise<void> {
  const tasks = dev.getActiveTasks();

  if (tasks.length === 0) {
    await msg.reply(t('discord.tasks.noTasks'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.tasks.title'))
    .setColor(0xffaa00);

  for (const task of tasks) {
    const elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    embed.addFields({
      name: truncateFieldName(`${task.repo}`),
      value: truncateFieldValue(`ID: \`${task.taskId}\`\n${t('discord.tasks.path', { path: task.path })}\n${t('discord.tasks.requester', { user: task.requestedBy })}\n${t('discord.tasks.elapsed', { seconds: elapsed })}`),
      inline: false,
    });
  }

  embed.setFooter({ text: t('discord.tasks.cancelHint') });

  await msg.reply({ embeds: [embed] });
}

/**
 * !cancel <taskId> - Cancel task
 */
export async function handleCancel(msg: Message, taskId: string): Promise<void> {
  if (!taskId) {
    await msg.reply(t('discord.cancel.usage'));
    return;
  }

  const success = dev.cancelTask(taskId);

  if (success) {
    await msg.reply(`⏹️ ${t('discord.cancel.cancelled', { id: taskId })}`);
  } else {
    await msg.reply(`❌ ${t('discord.cancel.notFound', { id: taskId })}`);
  }
}

/**
 * !schedule - Schedule management
 */
export async function handleSchedule(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !schedule list or !schedule (list)
  if (!subCommand || subCommand === 'list') {
    const schedules = await scheduler.listSchedules();
    const formatted = scheduler.formatScheduleList(schedules);

    const embed = new EmbedBuilder()
      .setTitle(t('discord.schedule.title'))
      .setDescription(truncateDescription(formatted))
      .setColor(0x00ae86)
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  // !schedule run <name> - Run immediately
  if (subCommand === 'run') {
    const name = args[1];
    if (!name) {
      await msg.reply(t('discord.schedule.runUsage'));
      return;
    }

    const success = await scheduler.runNow(name);
    if (success) {
      await msg.reply(`▶️ ${t('discord.schedule.runStarted', { name })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
    return;
  }

  // !schedule toggle <name> - Enable/disable
  if (subCommand === 'toggle') {
    const name = args[1];
    if (!name) {
      await msg.reply(t('discord.schedule.toggleUsage'));
      return;
    }

    const newState = await scheduler.toggleSchedule(name);
    if (newState !== undefined) {
      await msg.reply(`🔄 ${t('discord.schedule.toggled', { name, state: newState ? 'enabled' : 'disabled' })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
    return;
  }

  // !schedule add <name> <cron> - Add schedule
  if (subCommand === 'add') {
    const name = args[1];
    const cron = args[2];
    if (!name || !cron) {
      await msg.reply(t('discord.schedule.addUsage'));
      return;
    }

    const success = await scheduler.addSchedule(name, cron);
    if (success) {
      await msg.reply(`✅ ${t('discord.schedule.added', { name, cron })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.addFailed', { name })}`);
    }
    return;
  }

  // !schedule remove <name> - Remove schedule
  if (subCommand === 'remove') {
    const name = args[1];
    if (!name) {
      await msg.reply(t('discord.schedule.removeUsage'));
      return;
    }

    const success = await scheduler.removeSchedule(name);
    if (success) {
      await msg.reply(`🗑️ ${t('discord.schedule.removed', { name })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
    return;
  }

  // Unknown subcommand
  await msg.reply(t('discord.schedule.usage'));
}

/**
 * !auto - Show autonomous runner status
 */
export async function handleAuto(msg: Message): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const status = runner.getStatus();

    const embed = new EmbedBuilder()
      .setTitle(t('discord.auto.title'))
      .setColor(0x00ae86)
      .setTimestamp();

    embed.addFields(
      { name: truncateFieldName(t('discord.auto.state')), value: truncateFieldValue(status.state), inline: true },
      { name: truncateFieldName(t('discord.auto.task')), value: truncateFieldValue(status.currentTask || t('discord.auto.noTask')), inline: true },
    );

    if (status.queueLength !== undefined) {
      embed.addFields({ name: truncateFieldName(t('discord.auto.queue')), value: truncateFieldValue(String(status.queueLength)), inline: true });
    }

    await msg.reply({ embeds: [embed] });
  } catch {
    await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
  }
}

/**
 * !approve - Approve pending task
 */
export async function handleApprove(msg: Message): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const approved = runner.approve();

    if (approved) {
      await msg.reply(`✅ ${t('discord.auto.approved')}`);
    } else {
      await msg.reply(`⏳ ${t('discord.auto.noPendingApproval')}`);
    }
  } catch {
    await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
  }
}

/**
 * !reject - Reject pending task
 */
export async function handleReject(msg: Message): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const rejected = runner.reject();

    if (rejected) {
      await msg.reply(`❌ ${t('discord.auto.rejected')}`);
    } else {
      await msg.reply(`⏳ ${t('discord.auto.noPendingApproval')}`);
    }
  } catch {
    await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
  }
}catch {
    await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
  }
}