// ============================================
// OpenSwarm - Discord Command Handlers
//
// All command handlers (!status, !dev, etc.)

import {
  TextChannel,
  Message,
  EmbedBuilder,
} from 'discord.js';
import { enforceEmbedLimits, truncateFieldValue, truncateFieldName } from './embedUtils.js';
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

	/** Enforce total embed description limit with truncation. */
	function truncateDescription(desc: string): string {
	  if (desc.length <= EMBED_TOTAL_LIMIT) return desc;
	  return `${desc.slice(0, EMBED_TOTAL_LIMIT - 12)}\n…[truncated]`;
	}

	/** Truncate a string to fit within Discord embed field limits, appending a marker. */
	function truncateFieldValue(value: string, max = EMBED_FIELD_VALUE_LIMIT): string {
	  if (value.length <= max) return value;
	  return `${value.slice(0, max - 12)}\n…[truncated]`;
	}

	function truncateFieldName(name: string): string {
	  if (name.length <= EMBED_FIELD_NAME_LIMIT) return name;
	  return `${name.slice(0, EMBED_FIELD_NAME_LIMIT - 12)}…[truncated]`;
	}

	/** Enforce all Discord embed limits (total, field value, field name) */
	function enforceEmbedLimits(embed: EmbedBuilder): EmbedBuilder {
	  // Truncate description if needed
	  const desc = embed.data.description;
	  if (desc && desc.length > EMBED_TOTAL_LIMIT) {
	    embed.setDescription(truncateDescription(desc));
	  }

	  // Process fields
	  if (embed.data.fields) {
	    embed.data.fields = embed.data.fields.map(field => ({
	      ...field,
	      name: truncateFieldName(field.name),
	      value: truncateFieldValue(field.value)
	    }));
	  }

	  return embed;
	}

/**
 * Helper: Reply with Embed for consistent Discord UI
 */
async function replyWithEmbed(msg: Message, content: string, color: number = 0x00ff41): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(truncateDescription(content))
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
 * !list - List active sessions (paginated to fit embed budget)
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
  // Paginate: max 10 sessions per embed to stay within aggregate budget
  const PAGE_SIZE = 10;
  const pages = Math.ceil(sessionList.length / PAGE_SIZE);
  const page = 0; // first page only for now; could be extended with pagination

  const pageSessions = sessionList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setTitle(t('discord.list.title'))
    .setColor(0x00ae86)
    .setTimestamp();

  for (const s of pageSessions) {
    const value = `State: ${s.state}\nTask: ${s.currentTask || 'none'}\nRepo: ${s.currentRepo || 'none'}`;
    embed.addFields({
      name: truncateFieldName(s.sessionName || 'default'),
      value: truncateFieldValue(value),
      inline: false,
    });
  }

  if (pages > 1) {
    embed.setFooter({ text: `Page ${page + 1}/${pages}` });
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
      const chunks = splitMessage(output);
      for (const chunk of chunks) {
        msg.reply(chunk);
      }
    },
  });

  // If the task itself threw (not a spawn error), report it
  if (result instanceof Error) {
    stopProgressReporting();
    await msg.reply(`❌ ${t('discord.dev.error', { error: result.message })}`);
  }
}

/**
 * !repos - List configured repositories
 */
export async const EMBED_FIELD_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;

function truncateField(text: string, limit: number = EMBED_FIELD_LIMIT): string {
  if (!text) return '';
  return text.length <= limit ? text : text.slice(0, limit - 3) + '...';
}

function handleRepos(msg: Message): Promise<void> {
  if (!getGithubRepos) {
    await replyWithEmbed(msg, t('discord.errors.noReposFn'));
    return;
  }

  const repos = getGithubRepos();
  if (!repos || repos.length === 0) {
    await replyWithEmbed(msg, t('discord.repos.noRepos'));
    return;
  }

  const fields = repos.map(r => ({
    name: truncateFieldName(r.name || r.fullName || 'unknown'),
    value: truncateFieldValue(r.fullName || r.name || 'unknown'),
  }));

  const embed = new EmbedBuilder()
    .setTitle(t('discord.repos.title'))
    .setColor(0x00ae86)
    .setTimestamp();

  enforceEmbedLimits(embed, t('discord.repos.title'), '', fields);
  await msg.reply({ embeds: [embed] });
}

/**
 * !tasks - List active tasks
 */
export async function handleTasks(msg: Message): Promise<void> {
  const taskSource = selectTaskSource();
  if (!taskSource) {
    await replyWithEmbed(msg, t('discord.errors.noTaskSource'));
    return;
  }

  const tasks = await taskSource.fetchTasks();
  if (!tasks || tasks.length === 0) {
    await replyWithEmbed(msg, t('discord.tasks.noTasks'));
    return;
  }

  const fields = tasks.slice(0, 25).map(t => ({
    name: truncateFieldName(t.title || t.id || 'unknown'),
    value: truncateFieldValue(`ID: ${t.id}\nState: ${t.state || 'unknown'}\nPriority: ${t.priority ?? 'none'}`),
  }));

  const embed = new EmbedBuilder()
    .setTitle(t('discord.tasks.title'))
    .setColor(0x00ae86)
    .setTimestamp();

  enforceEmbedLimits(embed, t('discord.tasks.title'), '', fields);
  await msg.reply({ embeds: [embed] });
}

/**
 * !cancel <taskId> - Cancel a task
 */
export async function handleCancel(msg: Message, taskId: string): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const cancelled = runner.cancel(taskId);

    if (cancelled) {
      await msg.reply(`✅ ${t('discord.auto.cancelled', { id: taskId })}`);
    } else {
      await msg.reply(`⏳ ${t('discord.auto.noTaskFound', { id: taskId })}`);
    }
  } catch {
    await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
  }
}

/**
 * !schedule [list|run|toggle] - Manage schedules
 */
export async function handleSchedule(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !schedule list or !schedule (list)
  if (!subCommand || subCommand === 'list') {
    const schedules = await scheduler.listSchedules();
    const formatted = scheduler.formatScheduleList(schedules);

    // Truncate description to fit embed budget (4096 max for description, but we stay within 6000 total)
    const truncated = formatted.length > 4000 ? formatted.slice(0, 3988) + '\n…[truncated]' : formatted;

    const embed = new EmbedBuilder()
      .setTitle(t('discord.schedule.title'))
      .setDescription(truncated)
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
      await msg.reply(newState ? `✅ ${t('discord.schedule.enabled', { name })}` : `⏸️ ${t('discord.schedule.disabled', { name })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
    return;
  }

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
}