// ============================================
// OpenSwarm - Discord Command Handlers
//
// All command handlers (!status, !dev, etc.)

import {
  TextChannel,
  Message,
  EmbedBuilder,
} from 'discord.js';
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
  clampDiscordText,
} from './discordCore.js';
import { t, getDateLocale } from '../locale/index.js';
import { clampAndSanitize } from '../tui/sanitize.js';

/**
 * Helper: Reply with Embed for consistent Discord UI
 */
async function replyWithEmbed(msg: Message, content: string, color: number = 0x00ff41): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(content)
    .setColor(color)
    .setTimestamp();
  await msg.reply({ embeds: [embed] });
}

/**
 * !status [session] - Check status
 */
export async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
  if (!getAgentStatus) {
    await replyWithEmbed(msg, t('discord.errors.notInitialized'));
    return;
  }

  const statuses = getAgentStatus(sessionName);
  if (statuses.length === 0) {
    await replyWithEmbed(msg, t('discord.status.noAgents'));
    return;
  }

  const lines = statuses.map(s => {
    const emoji = s.paused ? '⏸️' : '▶️';
    return `${emoji} **${s.name}** — ${s.status}${s.paused ? ` (${t('discord.status.paused')})` : ''}`;
  });

  await replyWithEmbed(msg, lines.join('\n'));
}

/**
 * !list - List active sessions
 */
export async function handleList(msg: Message): Promise<void> {
  const statuses = getAgentStatus();
  if (statuses.length === 0) {
    await replyWithEmbed(msg, t('discord.list.noSessions'));
    return;
  }

  const lines = statuses.map(s => {
    const emoji = s.paused ? '⏸️' : '▶️';
    return `${emoji} **${s.name}** — ${s.status}`;
  });

  await replyWithEmbed(msg, lines.join('\n'));
}

/**
 * !run <task> - Run a task
 */
export async function handleRun(msg: Message, _args: string[]): Promise<void> {
  await msg.reply(t('discord.run.usage'));
}

/**
 * !pause <session> - Pause a session
 */
export async function handlePause(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply(t('discord.pause.usage'));
    return;
  }

  if (!onPauseAgent) {
    await msg.reply(t('discord.errors.notInitialized'));
    return;
  }

  onPauseAgent(sessionName);
  await msg.reply(t('discord.pause.confirmed', { session: sessionName }));
}

/**
 * !resume <session> - Resume a session
 */
export async function handleResume(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply(t('discord.resume.usage'));
    return;
  }

  if (!onResumeAgent) {
    await msg.reply(t('discord.errors.notInitialized'));
    return;
  }

  onResumeAgent(sessionName);
  await msg.reply(t('discord.resume.confirmed', { session: sessionName }));
}

/**
 * !issues [session] - List issues
 */
export async function handleIssues(msg: Message, sessionName?: string): Promise<void> {
  const issues = linear.fetchIssuesForStates(sessionName ? [sessionName] : undefined);
  if (issues.length === 0) {
    await replyWithEmbed(msg, t('discord.issues.noIssues'));
    return;
  }

  const lines = issues.map(i => `• **${i.identifier}** — ${i.title}`);
  await replyWithEmbed(msg, lines.join('\n'));
}

/**
 * !issue <id> - Show issue details
 */
export async function handleIssue(msg: Message, issueId: string): Promise<void> {
  if (!issueId) {
    await msg.reply(t('discord.issue.usage'));
    return;
  }

  const issues = linear.fetchIssuesForStates();
  const issue = issues.find(i => i.identifier === issueId.toUpperCase());
  if (!issue) {
    await msg.reply(t('discord.issue.notFound', { id: issueId }));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${issue.identifier} — ${issue.title}`)
    .setDescription(clampDiscordText(issue.description || t('discord.issue.noDescription'), 4096))
    .setColor(0x00ae86)
    .setTimestamp();

  if (issue.state) embed.addFields({ name: t('discord.issue.state'), value: issue.state, inline: true });
  if (issue.assignee) embed.addFields({ name: t('discord.issue.assignee'), value: issue.assignee, inline: true });

  await msg.reply({ embeds: [embed] });
}

/**
 * !log <session> [lines] - Show session log
 */
export async function handleLog(msg: Message, _sessionName: string, _lines: number): Promise<void> {
  await msg.reply(t('discord.log.usage'));
}

/**
 * !ci - Check CI status
 */
export async function handleCI(msg: Message): Promise<void> {
  await msg.reply(t('discord.ci.checking'));
}

/**
 * !notifications - Show notifications
 */
export async function handleNotifications(msg: Message): Promise<void> {
  await msg.reply(t('discord.notifications.none'));
}

/**
 * !dev <repo> <task> - Run a development task
 */
export async function handleDev(msg: Message, args: string[]): Promise<void> {
  if (args.length < 2) {
    await msg.reply(t('discord.dev.usage'));
    return;
  }

  const repo = args[0];
  const task = args.slice(1).join(' ');

  // Progress reporting
  let progressTimer: NodeJS.Timeout | null = null;
  let settled = false;
  const progressChunks: string[] = [];
  let _lastProgressMsg: Message | null = null;

  const stopProgressReporting = () => {
    settled = true;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  // Notify user that task is starting
  await msg.reply(t('discord.dev.starting', { repo, task: task.slice(0, 100) }));

  // Execute task
  let result: Awaited<ReturnType<typeof dev.runDevTask>>;
  try {
    result = await dev.runDevTask(
    repo,
    task,
    msg.author.username,
    // onProgress: intermediate progress notification every 10 seconds
    (chunk) => {
      progressChunks.push(chunk);

      if (!progressTimer) {
        progressTimer = setTimeout(async () => {
          progressTimer = null;
          const combined = progressChunks.join('').slice(-500);
          progressChunks = [];
          if (settled || !combined.trim()) return;
          try {
            _lastProgressMsg = await msg.reply(`${t('discord.dev.inProgress', { repo })}\n\`\`\`\n${combined}\n\`\`\``);
          } catch { /* ignore */ }
        }, 10000);
      }
    },
    // onComplete: send result on completion
    async (output, exitCode) => {
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
        await msg.reply(`${header}\n\`\`\`\n${truncated}\n\`\`\``);
        return;
      }

      // Otherwise send header + chunks
      await msg.reply(header);
      for (let i = 0; i < truncated.length; i += MAX_LEN) {
        const chunk = truncated.slice(i, i + MAX_LEN);
        await msg.reply(`\`\`\`\n${chunk}\n\`\`\``);
      }
    });
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
    const errMsg = typeof result.error === 'string' ? result.error : String(result.error);
    await msg.reply(`❌ ${clampDiscordText(errMsg, 1800)}`);
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
      name: t('discord.repos.available'),
      value: available.map(r => `• ${r.name} — ${r.path}`).join('\n'),
    });
  }

  if (unavailable.length > 0) {
    embed.addFields({
      name: t('discord.repos.unavailable'),
      value: unavailable.map(r => `• ${r.name}`).join('\n'),
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !tasks - List active tasks
 */
export async function handleTasks(msg: Message): Promise<void> {
  const tasks = dev.getActiveTasks();
  if (tasks.length === 0) {
    await msg.reply(t('discord.tasks.none'));
    return;
  }

  const lines = tasks.map(t => {
    const elapsed = Date.now() - t.startedAt;
    const minutes = Math.floor(elapsed / 60000);
    return `• **${t.id}** — ${t.description.slice(0, 80)} (${minutes}m)`;
  });

  await replyWithEmbed(msg, lines.join('\n'));
}

/**
 * !cancel <taskId> - Cancel a running task
 */
export async function handleCancel(msg: Message, taskId: string): Promise<void> {
  if (!taskId) {
    await msg.reply(t('discord.cancel.usage'));
    return;
  }

  const cancelled = dev.cancelTask(taskId);
  if (cancelled) {
    await msg.reply(t('discord.cancel.confirmed', { id: taskId }));
  } else {
    await msg.reply(t('discord.cancel.notFound', { id: taskId }));
  }
}

/**
 * !schedule - Schedule management
 */
export async function handleSchedule(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  if (subCommand === 'list') {
    const tasks = scheduler.getScheduledTasks();
    if (tasks.length === 0) {
      await msg.reply(t('discord.schedule.noTasks'));
      return;
    }

    const lines = tasks.map(t => {
      const nextRun = t.nextRun ? formatTimeAgo(t.nextRun.getTime()) : t('discord.schedule.notScheduled');
      return `• **${t.name}** — ${t.cron} (${nextRun})`;
    });

    await replyWithEmbed(msg, lines.join('\n'));
    return;
  }

  if (subCommand === 'add') {
    const name = args[1];
    const cron = args[2];
    if (!name || !cron) {
      await msg.reply(t('discord.schedule.addUsage'));
      return;
    }
    scheduler.addTask(name, cron);
    await msg.reply(t('discord.schedule.added', { name, cron }));
    return;
  }

  if (subCommand === 'remove') {
    const name = args[1];
    if (!name) {
      await msg.reply(t('discord.schedule.removeUsage'));
      return;
    }
    scheduler.removeTask(name);
    await msg.reply(t('discord.schedule.removed', { name }));
    return;
  }

  // Unknown subcommand
  await msg.reply(t('discord.schedule.helpText'));
}

/**
 * !codex - Session record management
 */
export async function handleCodex(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !codex or !codex list - Recent session list
  if (!subCommand || subCommand === 'list') {
    const recent = await codex.getRecentSessions(10);

    if (recent.length === 0) {
      await msg.reply(t('discord.codex.noSessions'));
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(t('discord.codex.title'))
      .setDescription(clampAndSanitize(recent.join('\n'), 4096))
      .setColor(0x9b59b6)
      .setFooter({ text: clampAndSanitize(t('discord.codex.pathLabel', { path: codex.getCodexPath() }), 2048) })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  // !codex save "<title>" [tags...] - Save current session
  if (subCommand === 'save') {
    const titleMatch = msg.content.match(/!codex save "(.+?)"/);
    const title = titleMatch?.[1];

    if (!title) {
      await msg.reply(t('discord.codex.saveUsage'));
      return;
    }

    // Extract tags (words after the title)
    const afterTitle = msg.content.slice(msg.content.indexOf('"', msg.content.indexOf('"') + 1) + 1).trim();
    const tags = afterTitle.split(/\s+/).filter(t => t.length > 0);

    // Session save request message
    await msg.reply(t('discord.codex.saving', { title, tags: tags.length > 0 ? tags.map(tag => `\`${tag}\``).join(' ') : t('discord.codex.noTags') }));

    // Actual save should be called after Claude completes work
    // Here we save an empty session (can be updated later)
    try {
      const { summaryPath } = await codex.quickSave({
        title,
        tags,
        description: '',
        result: 'incomplete',
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      await msg.reply(t('discord.codex.saved', { path: summaryPath }));
    } catch (err) {
      await msg.reply(t('discord.codex.saveError', { error: clampDiscordText(err instanceof Error ? err.message : String(err), 500) }));
    }
    return;
  }

  // !codex show <id> - Show session details
  if (subCommand === 'show') {
    const id = args[1];
    if (!id) {
      await msg.reply(t('discord.codex.showUsage'));
      return;
    }

    try {
      const session = await codex.getSession(id);
      if (!session) {
        await msg.reply(t('discord.codex.notFound', { id }));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(t('discord.codex.sessionTitle', { id }))
        .setDescription(clampAndSanitize(session.description || t('discord.codex.noDescription'), 4096))
        .setColor(0x9b59b6)
        .setTimestamp(session.startedAt);

      if (session.tags && session.tags.length > 0) {
        embed.addFields({ name: t('discord.codex.tags'), value: session.tags.map(t => `\`${t}\``).join(' '), inline: true });
      }
      embed.addFields({ name: t('discord.codex.result'), value: session.result, inline: true });

      await msg.reply({ embeds: [embed] });
    } catch (err) {
      await msg.reply(t('discord.codex.loadError', { error: clampDiscordText(err instanceof Error ? err.message : String(err), 500) }));
    }
    return;
  }

  // Unknown subcommand
  await msg.reply(t('discord.codex.helpText'));
}

/**
 * !turbo - Toggle turbo mode
 */
export async function handleTurbo(msg: Message): Promise<void> {
  await msg.reply(t('discord.turbo.toggle'));
}

/**
 * !help - Show help
 */
export async function handleHelp(msg: Message): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(t('discord.help.title'))
    .setDescription(t('discord.help.description'))
    .setColor(0x00ae86);

  const commands = [
    '!status', '!list', '!run', '!pause', '!resume',
    '!issues', '!issue', '!log', '!ci', '!notifications',
    '!dev', '!repos', '!tasks', '!cancel', '!schedule',
    '!codex', '!turbo', '!help',
  ];

  embed.addFields({ name: t('discord.help.commands'), value: commands.map(c => `• \`${c}\``).join('\n') });

  await msg.reply({ embeds: [embed] });
}