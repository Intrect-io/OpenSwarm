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
} from './discordCore.js';
import {
  enforceAggregateBudget,
  safeAddField,
  safeSetDescription,
  safeSetFooter,
  safeSetTitle,
  truncateField,
  EMBED_LIMITS,
} from './embedUtils.js';
import { t, getDateLocale } from '../locale/index.js';

/**
 * Helper: Reply with Embed for consistent Discord UI
 */
async function replyWithEmbed(msg: Message, content: string, color: number = 0x00ff41): Promise<void> {
  let embed = new EmbedBuilder().setColor(color).setTimestamp();
  embed = safeSetDescription(embed, content);
  embed = enforceAggregateBudget(embed);
  await msg.reply({ embeds: [embed] });
}

/**
 * !status [session] - Check status
 */
export async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
  if (!getAgentStatus) {
    await replyWithEmbed(msg, t('discord.errors.serviceNotInitialized'), 0xff0000);
    return;
  }

  const statuses = getAgentStatus(sessionName);

  if (statuses.length === 0) {
    await replyWithEmbed(msg, sessionName ? t('discord.errors.sessionNotFound', { name: sessionName || '' }) : t('discord.status.noAgents'), 0xffaa00);
    return;
  }

  let embed = new EmbedBuilder()
    .setColor(0x00ae86)
    .setTimestamp();
  embed = safeSetTitle(embed, t('discord.status.title'));

  for (const status of statuses) {
    const stateEmoji = {
      idle: '💤',
      working: '⚙️',
      blocked: '⚠️',
      paused: '⏸️',
    }[status.state];

    const issueInfo = status.currentIssue
      ? `\n📋 ${status.currentIssue.identifier}: ${status.currentIssue.title}`
      : `\n📋 ${t('discord.status.noIssueAssigned')}`;

    const lastHB = status.lastHeartbeat
      ? `\n🕐 ${t('discord.status.lastHeartbeat', { time: formatTimeAgo(status.lastHeartbeat) })}`
      : '';

    embed = safeAddField(
      embed,
      `${stateEmoji} ${status.name}`,
      `${t('discord.status.stateLabel', { state: status.state })}${issueInfo}${lastHB}`,
      false,
    );
  }

  embed = enforceAggregateBudget(embed);
  await msg.reply({ embeds: [embed] });
}

/**
 * !list - (deprecated) tmux session list -> dashboard redirect
 */
export async function handleList(msg: Message): Promise<void> {
  await replyWithEmbed(msg, 'Use web dashboard at /dashboard for session management. tmux mode has been removed.', 0xffaa00);
}

/**
 * !run <session> "<task>" - (deprecated) tmux task execution -> !dev redirect
 */
export async function handleRun(msg: Message, _args: string[]): Promise<void> {
  await replyWithEmbed(msg, 'tmux mode has been removed. Use `!dev <repo> "<task>"` instead.', 0xffaa00);
}

/**
 * !pause <session> - Pause autonomous work
 */
export async function handlePause(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await replyWithEmbed(msg, t('discord.pause.usage'), 0xffaa00);
    return;
  }

  if (onPauseAgent) {
    onPauseAgent(sessionName);
    await replyWithEmbed(msg, `⏸️ ${t('discord.pause.paused', { name: sessionName })}`);
  }
}

/**
 * !resume <session> - Resume autonomous work
 */
export async function handleResume(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await replyWithEmbed(msg, t('discord.resume.usage'), 0xffaa00);
    return;
  }

  if (onResumeAgent) {
    onResumeAgent(sessionName);
    await replyWithEmbed(msg, `▶️ ${t('discord.resume.resumed', { name: sessionName })}`);
  }
}

/**
 * !issues [session] - List Linear issues
 */
export async function handleIssues(msg: Message, sessionName?: string): Promise<void> {
  try {
    // Validate session name
    if (sessionName) {
      const status = getAgentStatus?.(sessionName);
      if (!status || status.length === 0) {
        await replyWithEmbed(msg, t('discord.errors.sessionNotFound', { name: sessionName }), 0xff0000);
        return;
      }
    }

    const agentLabel = sessionName || undefined;
    const issues = await linear.getMyIssues(agentLabel ? { agentLabel, slim: true } : { slim: true });

    if (issues.length === 0) {
      await replyWithEmbed(msg, t('discord.issues.noIssues'), 0xffaa00);
      return;
    }

    // Priority emoji mapping (Linear: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low)
    const priorityEmoji = {
      0: '⚪',
      1: '🔴',
      2: '🟠',
      3: '🟡',
      4: '🟢',
    };

    // State color mapping
    const stateColor = {
      'Todo': 0x808080,
      'In Progress': 0x3498db,
      'In Review': 0x9b59b6,
      'Done': 0x2ecc71,
      'Backlog': 0x95a5a6,
    };

    // Pagination (max 10 per embed)
    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(issues.length / ITEMS_PER_PAGE);

    const embeds: EmbedBuilder[] = [];

    for (let page = 0; page < totalPages; page++) {
      const startIdx = page * ITEMS_PER_PAGE;
      const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, issues.length);
      const pageIssues = issues.slice(startIdx, endIdx);

      let embed = new EmbedBuilder()
        .setColor(stateColor[pageIssues[0]?.state as keyof typeof stateColor] ?? 0x3498db)
        .setTimestamp();
      embed = safeSetTitle(embed, sessionName
        ? t('discord.issues.sessionIssues', { session: sessionName })
        : t('discord.issues.myIssues')
      );

      if (totalPages > 1) {
        embed = safeSetFooter(embed, t('discord.issues.page', { current: page + 1, total: totalPages }));
      }

      for (const issue of pageIssues) {
        const priority = priorityEmoji[issue.priority as keyof typeof priorityEmoji] ?? '⚪';
        const stateEmoji = {
          'Todo': '📝',
          'In Progress': '⚙️',
          'In Review': '👀',
          'Done': '✅',
          'Backlog': '📦',
        }[issue.state] ?? '📋';

        let value = `${priority} **${issue.identifier}**: ${issue.title}\n`;
        value += `${stateEmoji} ${issue.state}`;

        if (issue.project) {
          value += ` · ${issue.project.name}`;
        }

        if (issue.labels && issue.labels.length > 0) {
          value += `\n🏷️ ${issue.labels.join(', ')}`;
        }

        embed = safeAddField(embed, '\u200b', value, false);
      }

      embed = enforceAggregateBudget(embed);
      embeds.push(embed);
    }

    // Send embeds (all at once or split)
    if (embeds.length === 1) {
      await msg.reply({ embeds });
    } else {
      // First one as reply, rest as messages
      await msg.reply({ embeds: [embeds[0]] });

      // Send additional embeds (paging)
      for (let i = 1; i < embeds.length; i++) {
        const channel = msg.channel as any;
        if (channel?.send) {
          await channel.send({ embeds: [embeds[i]] });
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await replyWithEmbed(msg, t('discord.issues.fetchError', { error: errorMsg }), 0xff0000);
  }
}

/**
 * !issue <ID> - View Linear issue details
 */
export async function handleIssue(msg: Message, issueId: string): Promise<void> {
  try {
    if (!issueId) {
      await replyWithEmbed(msg, t('discord.issues.usage'), 0xffaa00);
      return;
    }

    const issue = await linear.getIssue(issueId);

    if (!issue) {
      await replyWithEmbed(msg, t('discord.issue.notFound', { id: issueId }), 0xff0000);
      return;
    }

    // Priority labels
    const priorityLabel = {
      0: 'None',
      1: 'Urgent',
      2: 'High',
      3: 'Normal',
      4: 'Low',
    };

    // State color mapping
    const stateColor = {
      'Todo': 0x808080,
      'In Progress': 0x3498db,
      'In Review': 0x9b59b6,
      'Done': 0x2ecc71,
      'Backlog': 0x95a5a6,
    };

    let embed = new EmbedBuilder()
      .setColor(stateColor[issue.state as keyof typeof stateColor] ?? 0x3498db)
      .setTimestamp();
    embed = safeSetTitle(embed, `${issue.identifier}: ${issue.title}`);

    // Description
    if (issue.description) {
      embed = safeAddField(embed, '📝 Description', issue.description, false);
    }

    // State, priority, project
    const stateEmoji = {
      'Todo': '📝',
      'In Progress': '⚙️',
      'In Review': '👀',
      'Done': '✅',
      'Backlog': '📦',
    }[issue.state] ?? '📋';

    let infoValue = `${stateEmoji} ${t('discord.issue.stateLabel', { state: issue.state })}`;
    infoValue += `\n⭐ ${t('discord.issues.priorityLabel', { priority: priorityLabel[issue.priority as keyof typeof priorityLabel] ?? 'Unknown' })}`;

    if (issue.project) {
      infoValue += `\n📦 ${t('discord.issues.projectLabel', { project: issue.project.name })}`;
    }

    if (issue.labels && issue.labels.length > 0) {
      infoValue += `\n🏷️ ${t('discord.issues.labelsLabel', { labels: issue.labels.join(', ') })}`;
    }

    embed = safeAddField(embed, '📊 Details', infoValue, false);

    // Show comments
    if (issue.comments && issue.comments.length > 0) {
      const commentSummary = issue.comments.slice(0, 3).map((comment, idx) => {
        const preview = truncateField(comment.body, 100, true);
        const createdAt = new Date(comment.createdAt).toLocaleDateString(getDateLocale());
        return `${idx + 1}. ${preview}\n   _${createdAt}_`;
      }).join('\n\n');

      const commentValue = issue.comments.length > 3
        ? `${commentSummary}\n\n_+${issue.comments.length - 3} more..._`
        : commentSummary;

      embed = safeAddField(
        embed,
        `💬 ${t('discord.issues.commentsCount', { count: issue.comments.length })}`,
        commentValue,
        false,
      );
    } else {
      embed = safeAddField(embed, '💬 Comments', t('discord.issue.noComments'), false);
    }

    embed = enforceAggregateBudget(embed);
    await msg.reply({ embeds: [embed] });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await replyWithEmbed(msg, t('discord.issue.fetchError', { error: errorMsg }), 0xff0000);
  }
}

/**
 * !log <session> [lines] - (deprecated) tmux logs -> dashboard redirect
 */
export async function handleLog(msg: Message, _sessionName: string, _lines: number): Promise<void> {
  await replyWithEmbed(msg, 'tmux mode has been removed. Use web dashboard at /dashboard for logs.', 0xffaa00);
}

/**
 * !ci - Check GitHub CI status
 */
export async function handleCI(msg: Message): Promise<void> {
  const repos = getGithubRepos?.() ?? [];

  if (repos.length === 0) {
    await replyWithEmbed(msg, t('discord.ci.noRepos'), 0xffaa00);
    return;
  }

  await replyWithEmbed(msg, `🔍 ${t('discord.ci.checking')}`);
  const summary = await github.summarizeCIFailures(repos);
  await replyWithEmbed(msg, summary);
}

/**
 * !notifications - Check GitHub notifications
 */
export async function handleNotifications(msg: Message): Promise<void> {
  await replyWithEmbed(msg, `🔍 ${t('discord.notifications.checking')}`);
  const summary = await github.summarizeNotifications();
  await replyWithEmbed(msg, summary);
}

/**
 * !dev <repo> "<task>" - Run dev task in a specific repository
 */
export async function handleDev(msg: Message, args: string[]): Promise<void> {
  // !dev list - Known repo list (redirects to repos)
  if (args[0] === 'list') {
    await handleRepos(msg);
    return;
  }

  // !dev scan - Scan ~/dev
  if (args[0] === 'scan') {
    const repos = dev.scanDevRepos();
    if (repos.length === 0) {
      await replyWithEmbed(msg, t('discord.dev.noRepos'), 0xffaa00);
      return;
    }
    await replyWithEmbed(msg, `${t('discord.dev.repoList')}\n${repos.map(r => `- ${r}`).join('\n')}`);
    return;
  }

  // !dev <repo> "<task>" parsing
  const repo = args[0];
  const taskMatch = msg.content.match(/!dev \S+ "(.+)"/s);
  const task = taskMatch?.[1];

  if (!repo || !task) {
    await replyWithEmbed(msg, t('discord.dev.usage'), 0xffaa00);
    return;
  }

  // Verify path
  const resolvedPath = dev.resolveRepoPath(repo);
  if (!resolvedPath) {
    await replyWithEmbed(msg, t('discord.errors.repoNotFound', { repo }), 0xff0000);
    return;
  }

  // Task start notification
  await replyWithEmbed(msg, `🚀 ${t('discord.dev.taskStarting', { repo, path: resolvedPath, task: task.slice(0, 100) + (task.length > 100 ? '...' : '') })}`);

  // For collecting progress updates
  let progressChunks: string[] = [];
  let _lastProgressMsg: Message | null = null;
  let progressTimer: NodeJS.Timeout | null = null;
  // Set once the task is over, however it ended. The progress timer is armed
  // from a callback and fires 10s later, so without this a task that already
  // finished — or failed — still posts an "in progress" reply afterwards,
  // quoting output the user has already seen the conclusion for.
  let settled = false;

  /**
   * Stop the progress timer.
   *
   * Deliberately NOT called after `await runDevTask` returns. runDevTask
   * registers the child's stdout/close listeners and returns `{taskId, path}`
   * immediately — it does not await the process. Disarming there would set
   * `settled` before the first chunk ever arrived and suppress every progress
   * reply for the whole run. The task's real end is onComplete, which fires for
   * both 'close' and 'error'; the only cases that never reach it are a task
   * that failed to launch, handled explicitly below.
   */
  const stopProgressReporting = (): void => {
    settled = true;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

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

  let embed = new EmbedBuilder().setColor(0x00ae86);
  embed = safeSetTitle(embed, t('discord.repos.title'));
  embed = safeSetDescription(embed, t('discord.repos.description'));

  const available = repos.filter(r => r.exists);
  const unavailable = repos.filter(r => !r.exists);

  if (available.length > 0) {
    const value = available
      .map(r => `\`${truncateField(r.alias, 64)}\` → ${truncateField(r.path, 200)}`)
      .join('\n');
    embed = safeAddField(embed, `✅ ${t('discord.repos.available')}`, value);
  }

  if (unavailable.length > 0) {
    const value = unavailable
      .map(r => `\`${truncateField(r.alias, 64)}\` → ${truncateField(r.path, 200)}`)
      .join('\n');
    embed = safeAddField(embed, `❌ ${t('discord.repos.unavailable')}`, value);
  }

  embed = safeAddField(embed, `💡 ${t('discord.repos.tip')}`, t('discord.repos.tipContent'));
  embed = enforceAggregateBudget(embed);

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

  let embed = new EmbedBuilder().setColor(0xffaa00);
  embed = safeSetTitle(embed, t('discord.tasks.title'));

  for (const task of tasks.slice(0, EMBED_LIMITS.MAX_FIELDS - 1)) {
    const elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    embed = safeAddField(
      embed,
      `${task.repo}`,
      `ID: \`${task.taskId}\`\n${t('discord.tasks.path', { path: task.path })}\n${t('discord.tasks.requester', { user: task.requestedBy })}\n${t('discord.tasks.elapsed', { seconds: elapsed })}`,
    );
  }

  embed = safeSetFooter(embed, t('discord.tasks.cancelHint'));
  embed = enforceAggregateBudget(embed);

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
 * !limits - Agent daily limit status
 */
export async function handleLimits(msg: Message): Promise<void> {
  const remaining = linear.getRemainingDailyIssues();
  const used = linear.getDailyIssueCount();
  const total = 10;

  const progressBar = '█'.repeat(used) + '░'.repeat(remaining);

  let embed = new EmbedBuilder()
    .setColor(remaining > 3 ? 0x00ae86 : remaining > 0 ? 0xffaa00 : 0xff0000)
    .setTimestamp();
  embed = safeSetTitle(embed, t('discord.limits.title'));
  embed = safeAddField(
    embed,
    t('discord.limits.issueCreation'),
    `${progressBar} ${used}/${total}\n${t('discord.limits.remaining', { n: remaining })}`,
    false,
  );
  embed = safeSetFooter(embed, t('discord.limits.resetNote'));
  embed = enforceAggregateBudget(embed);

  await msg.reply({ embeds: [embed] });
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

    let embed = new EmbedBuilder().setColor(0x00ae86).setTimestamp();
    embed = safeSetTitle(embed, t('discord.schedule.title'));
    embed = safeSetDescription(embed, formatted);
    embed = enforceAggregateBudget(embed);

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

    const job = await scheduler.toggleSchedule(name);
    if (job) {
      const status = job.enabled ? t('discord.schedule.toggleEnabled', { name: job.name }) : t('discord.schedule.toggleDisabled', { name: job.name });
      await msg.reply(status);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
    return;
  }

  // !schedule add <name> <project> <interval> "<prompt>"
  if (subCommand === 'add') {
    const name = args[1];
    const projectPath = args[2];
    const interval = args[3];
    const promptMatch = msg.content.match(/!schedule add \S+ \S+ \S+ "(.+)"/s);
    const prompt = promptMatch?.[1];

    if (!name || !projectPath || !interval || !prompt) {
      await msg.reply(t('discord.schedule.addUsage'));
      return;
    }

    try {
      const job = await scheduler.addSchedule(name, projectPath, prompt, interval, msg.author.username);
      await msg.reply(`✅ ${t('discord.schedule.addSuccess', { name: job.name, schedule: job.schedule })}`);
    } catch (err) {
      await msg.reply(`❌ ${t('discord.schedule.addFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    }
    return;
  }

  // !schedule remove <name>
  if (subCommand === 'remove' || subCommand === 'delete') {
    const name = args[1];
    if (!name) {
      await msg.reply(t('discord.schedule.removeUsage'));
      return;
    }

    const success = await scheduler.removeSchedule(name);
    if (success) {
      await msg.reply(`🗑️ ${t('discord.schedule.removeSuccess', { name })}`);
    } else {
      await msg.reply(`❌ ${t('discord.schedule.notFound', { name })}`);
    }
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

    let embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTimestamp();
    embed = safeSetTitle(embed, t('discord.codex.title'));
    embed = safeSetDescription(embed, recent.join('\n'));
    embed = safeSetFooter(embed, t('discord.codex.pathLabel', { path: codex.getCodexPath() }));
    embed = enforceAggregateBudget(embed);

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
        result: 'success',
      });

      await msg.reply(`✅ ${t('discord.codex.saveSuccess', { path: summaryPath })}`);
    } catch (err) {
      await msg.reply(`❌ ${t('discord.codex.saveFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    }
    return;
  }

  // !codex path - Check path
  if (subCommand === 'path') {
    await msg.reply(`📁 ${t('discord.codex.pathLabel', { path: codex.getCodexPath() })}`);
    return;
  }

  // Unknown subcommand
  await msg.reply(t('discord.codex.helpText'));
}

// Autonomous Runner Commands

/**
 * !auto - Autonomous execution mode management
 */
export async function handleAuto(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !auto status or !auto - Check status
  if (!subCommand || subCommand === 'status') {
    try {
      const runner = autonomous.getRunner();
      const stats = runner.getStats();

      let embed = new EmbedBuilder()
        .setColor(stats.isRunning ? 0x00AE86 : 0x95A5A6)
        .setTimestamp();
      embed = safeSetTitle(embed, t('discord.auto.title'));
      embed = safeAddField(embed, t('discord.auto.statusLabel'), stats.isRunning ? `✅ ${t('discord.auto.statusRunning')}` : `⏹️ ${t('discord.auto.statusStopped')}`, true);
      embed = safeAddField(embed, t('discord.auto.completedFailed'), `${stats.engineStats.totalCompleted}/${stats.engineStats.totalFailed}`, true);
      embed = safeAddField(embed, t('discord.auto.pendingApprovalLabel'), stats.pendingApproval ? `⏳ ${t('discord.auto.pendingApproval')}` : t('discord.auto.noPending'), true);

      if (stats.lastHeartbeat > 0) {
        embed = safeAddField(
          embed,
          t('discord.auto.lastHeartbeatLabel'),
          new Date(stats.lastHeartbeat).toLocaleString(getDateLocale()),
          false,
        );
      }

      embed = enforceAggregateBudget(embed);
      await msg.reply({ embeds: [embed] });
    } catch {
      await msg.reply(t('discord.auto.notInitialized'));
    }
    return;
  }

  // !auto start [schedule] [--pair] - Start
  if (subCommand === 'start') {
    // Check --pair option
    const hasPairFlag = args.includes('--pair') || args.includes('pair');
    const scheduleArg = args.find(a => a !== 'start' && a !== '--pair' && a !== 'pair');
    const schedule = scheduleArg || '*/30 * * * *'; // Default: every 30 minutes

    const startingMsg = hasPairFlag ? t('discord.auto.startingPair') : t('discord.auto.startingSolo');
    await msg.reply(`🚀 ${startingMsg}\nSchedule: \`${schedule}\``);

    try {
      // Register a notifier that reports back to the command's channel.
      autonomous.setNotifier({
        async notify(message: string | EmbedBuilder) {
          const channel = msg.channel as TextChannel;
          if (typeof message === 'string') {
            await channel.send(message);
          } else {
            await channel.send({ embeds: [message] });
          }
        },
      });

      // Register the task source (Linear when configured, else local SQLite).
      autonomous.setTaskSource(selectTaskSource(linear.isLinearInitialized(), async (): Promise<TaskItem[]> => {
        try {
          const issues = await linear.getMyIssues({ slim: true, timeoutMs: 30000 });
          return issues.map((issue: any) => linearIssueToTask({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            description: issue.description,
            priority: issue.priority || 3,
            dueDate: issue.dueDate,
            state: issue.state,
            labels: issue.labels,
            updatedAt: issue.updatedAt,
            project: issue.project ? {
              id: issue.project.id,
              name: issue.project.name,
            } : undefined,
          }));
        } catch (err) {
          console.error('Linear fetch error:', err);
          return [];
        }
      }));

      // Start runner
      console.log(`[Auto] Starting with pairMode: ${hasPairFlag}`);
      await autonomous.startAutonomous({
        linearTeamId: process.env.LINEAR_TEAM_ID || '',
        allowedProjects: ['~/dev/OpenSwarm', '~/dev/tools/pykis', '~/dev'],
        heartbeatSchedule: schedule,
        autoExecute: true, // Auto-execute (no approval needed)
        dryRun: false,
        pairMode: hasPairFlag,
        pairMaxAttempts: pairModeConfig?.maxAttempts ?? 3,
        maxConcurrentTasks: 4,
        enableDecomposition: true,
        decompositionThresholdMinutes: 30,
        worktreeMode: true,
      });

      const startMsg = hasPairFlag
        ? `✅ ${t('discord.auto.startedPair')}`
        : `✅ ${t('discord.auto.startedSolo')}`;
      await msg.reply(startMsg);
    } catch (err) {
      await msg.reply(`❌ ${t('discord.errors.startFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    }
    return;
  }

  // !auto stop - Stop
  if (subCommand === 'stop') {
    void autonomous.stopAutonomous();
    await msg.reply(`⏹️ ${t('discord.auto.stopped')}`);
    return;
  }

  // !auto run - Run heartbeat immediately
  if (subCommand === 'run') {
    try {
      const runner = autonomous.getRunner();
      await msg.reply(`🔄 ${t('discord.auto.runningHeartbeat')}`);
      await runner.runNow();
    } catch {
      await msg.reply(`❌ ${t('discord.errors.runnerNotStarted')}`);
    }
    return;
  }

  // !auto approve on/off - Toggle auto-approval
  if (subCommand === 'approve' && (args[1] === 'on' || args[1] === 'off')) {
    const autoApprove = args[1] === 'on';
    await msg.reply(`Restart required to switch to ${autoApprove ? '⚠️ auto-execute' : '✅ manual approval'} mode.`);
    return;
  }

  // Help
  await msg.reply(t('discord.auto.helpText'));
}

/**
 * !approve - Approve pending task
 */
export async function handleApprove(msg: Message): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const approved = await runner.approve();

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
