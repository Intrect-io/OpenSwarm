// ============================================
// Claude Swarm - Discord Command Handlers
//
// All command handlers (!status, !dev, etc.)
// ============================================

import {
  TextChannel,
  Message,
  EmbedBuilder,
} from 'discord.js';
import * as tmux from './tmux.js';
import * as linear from './linear.js';
import * as github from './github.js';
import * as dev from './dev.js';
import * as scheduler from './scheduler.js';
import * as codex from './codex.js';
import * as autonomous from './autonomousRunner.js';
import { linearIssueToTask, TaskItem } from './decisionEngine.js';

import {
  onPauseAgent,
  onResumeAgent,
  getAgentStatus,
  getGithubRepos,
  pairModeConfig,
  formatTimeAgo,
} from './discordCore.js';
import { t, getDateLocale } from './locale/index.js';

/**
 * !status [session] - 상태 확인
 */
export async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
  if (!getAgentStatus) {
    await msg.reply(t('discord.errors.serviceNotInitialized'));
    return;
  }

  const statuses = getAgentStatus(sessionName);

  if (statuses.length === 0) {
    await msg.reply(sessionName ? t('discord.errors.sessionNotFound', { name: sessionName || '' }) : t('discord.status.noAgents'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.status.title'))
    .setColor(0x00ae86)
    .setTimestamp();

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

    embed.addFields({
      name: `${stateEmoji} ${status.name}`,
      value: `${t('discord.status.stateLabel', { state: status.state })}${issueInfo}${lastHB}`,
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !list - 모든 세션 목록
 */
export async function handleList(msg: Message): Promise<void> {
  const sessions = await tmux.listSessions();

  if (sessions.length === 0) {
    await msg.reply(t('discord.list.noSessions'));
    return;
  }

  await msg.reply(`${t('discord.list.activeSessions')}\n${sessions.map(s => `- ${s}`).join('\n')}`);
}

/**
 * !run <session> "<task>" - 작업 실행
 */
export async function handleRun(msg: Message, args: string[]): Promise<void> {
  const sessionName = args[0];
  const taskMatch = msg.content.match(/!run \w+ "(.+)"/);
  const task = taskMatch?.[1];

  if (!sessionName || !task) {
    await msg.reply(t('discord.run.usage'));
    return;
  }

  const exists = await tmux.sessionExists(sessionName);
  if (!exists) {
    await msg.reply(t('discord.run.sessionNotExist', { name: sessionName }));
    return;
  }

  await tmux.sendTask(sessionName, task);
  await msg.reply(t('discord.run.taskSent', { session: sessionName, task }));

  // 결과 캡처 (5초 후)
  setTimeout(async () => {
    const output = await tmux.capturePane(sessionName, 20);
    const truncated = output.length > 1500 ? output.slice(-1500) + '...' : output;
    await msg.reply(`${t('discord.run.output', { session: sessionName })}\n\`\`\`\n${truncated}\n\`\`\``);
  }, 5000);
}

/**
 * !pause <session> - 자율 작업 중지
 */
export async function handlePause(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply(t('discord.pause.usage'));
    return;
  }

  if (onPauseAgent) {
    onPauseAgent(sessionName);
    await msg.reply(`⏸️ ${t('discord.pause.paused', { name: sessionName })}`);
  }
}

/**
 * !resume <session> - 자율 작업 재개
 */
export async function handleResume(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply(t('discord.resume.usage'));
    return;
  }

  if (onResumeAgent) {
    onResumeAgent(sessionName);
    await msg.reply(`▶️ ${t('discord.resume.resumed', { name: sessionName })}`);
  }
}

/**
 * !issues [session] - Linear 이슈 목록
 */
export async function handleIssues(msg: Message, _sessionName?: string): Promise<void> {
  // TODO: Linear 이슈 조회 구현
  await msg.reply(t('discord.issues.notImplemented'));
}

/**
 * !log <session> [lines] - 최근 출력 확인
 */
export async function handleLog(msg: Message, sessionName: string, lines: number): Promise<void> {
  if (!sessionName) {
    await msg.reply(t('discord.log.usage'));
    return;
  }

  const exists = await tmux.sessionExists(sessionName);
  if (!exists) {
    await msg.reply(t('discord.log.sessionNotExist', { name: sessionName }));
    return;
  }

  const output = await tmux.capturePane(sessionName, lines);
  const truncated = output.length > 1800 ? output.slice(-1800) + '\n...(truncated)' : output;

  await msg.reply(`${t('discord.log.recentLines', { session: sessionName, lines })}\n\`\`\`\n${truncated}\n\`\`\``);
}

/**
 * !ci - GitHub CI 상태 확인
 */
export async function handleCI(msg: Message): Promise<void> {
  const repos = getGithubRepos?.() ?? [];

  if (repos.length === 0) {
    await msg.reply(t('discord.ci.noRepos'));
    return;
  }

  await msg.reply(`🔍 ${t('discord.ci.checking')}`);
  const summary = await github.summarizeCIFailures(repos);
  await msg.reply(summary);
}

/**
 * !notifications - GitHub 알림 확인
 */
export async function handleNotifications(msg: Message): Promise<void> {
  await msg.reply(`🔍 ${t('discord.notifications.checking')}`);
  const summary = await github.summarizeNotifications();
  await msg.reply(summary);
}

/**
 * !dev <repo> "<task>" - 특정 저장소에서 개발 작업 실행
 */
export async function handleDev(msg: Message, args: string[]): Promise<void> {
  // !dev list - 알려진 저장소 목록 (repos로 리다이렉트)
  if (args[0] === 'list') {
    await handleRepos(msg);
    return;
  }

  // !dev scan - ~/dev 스캔
  if (args[0] === 'scan') {
    const repos = dev.scanDevRepos();
    if (repos.length === 0) {
      await msg.reply(t('discord.dev.noRepos'));
      return;
    }
    await msg.reply(`${t('discord.dev.repoList')}\n${repos.map(r => `- ${r}`).join('\n')}`);
    return;
  }

  // !dev <repo> "<task>" 파싱
  const repo = args[0];
  const taskMatch = msg.content.match(/!dev \S+ "(.+)"/s);
  const task = taskMatch?.[1];

  if (!repo || !task) {
    await msg.reply(t('discord.dev.usage'));
    return;
  }

  // 경로 확인
  const resolvedPath = dev.resolveRepoPath(repo);
  if (!resolvedPath) {
    await msg.reply(t('discord.errors.repoNotFound', { repo }));
    return;
  }

  // 작업 시작 알림
  await msg.reply(`🚀 ${t('discord.dev.taskStarting', { repo, path: resolvedPath, task: task.slice(0, 100) + (task.length > 100 ? '...' : '') })}`);

  // 진행 상황 수집용
  let progressChunks: string[] = [];
  let _lastProgressMsg: Message | null = null;
  let progressTimer: NodeJS.Timeout | null = null;

  // 작업 실행
  const result = await dev.runDevTask(
    repo,
    task,
    msg.author.username,
    // onProgress: 10초마다 중간 진행 상황 알림
    (chunk) => {
      progressChunks.push(chunk);

      if (!progressTimer) {
        progressTimer = setTimeout(async () => {
          const combined = progressChunks.join('').slice(-500);
          if (combined.trim()) {
            try {
              _lastProgressMsg = await msg.reply(`${t('discord.dev.inProgress', { repo })}\n\`\`\`\n${combined}\n\`\`\``);
            } catch { /* 무시 */ }
          }
          progressChunks = [];
          progressTimer = null;
        }, 10000);
      }
    },
    // onComplete: 완료 시 결과 전송
    async (output, exitCode) => {
      if (progressTimer) {
        clearTimeout(progressTimer);
      }

      // 결과 분할 전송 (Discord 2000자 제한)
      const MAX_LEN = 1800;
      const truncated = output.length > MAX_LEN * 3
        ? `...(${output.length - MAX_LEN * 3}자 생략)\n\n${output.slice(-MAX_LEN * 3)}`
        : output;

      const statusEmoji = exitCode === 0 ? '✅' : '⚠️';
      const header = `${statusEmoji} ${t('discord.dev.completed', { repo, exitCode: exitCode ?? 'unknown' })}`;

      // 결과가 짧으면 한 번에
      if (truncated.length <= MAX_LEN) {
        await msg.reply(`${header}\n\`\`\`\n${truncated || t('discord.dev.noOutput')}\n\`\`\``);
      } else {
        // 결과가 길면 분할
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

  if ('error' in result) {
    await msg.reply(`❌ ${result.error}`);
  }
}

/**
 * !repos - 알려진 저장소 목록
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
      name: `✅ ${t('discord.repos.available')}`,
      value: available.map(r => `\`${r.alias}\` → ${r.path}`).join('\n'),
      inline: false,
    });
  }

  if (unavailable.length > 0) {
    embed.addFields({
      name: `❌ ${t('discord.repos.unavailable')}`,
      value: unavailable.map(r => `\`${r.alias}\` → ${r.path}`).join('\n'),
      inline: false,
    });
  }

  embed.addFields({
    name: `💡 ${t('discord.repos.tip')}`,
    value: t('discord.repos.tipContent'),
    inline: false,
  });

  await msg.reply({ embeds: [embed] });
}

/**
 * !tasks - 실행 중인 dev 작업 목록
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
      name: `${task.repo}`,
      value: `ID: \`${task.taskId}\`\n${t('discord.tasks.path', { path: task.path })}\n${t('discord.tasks.requester', { user: task.requestedBy })}\n${t('discord.tasks.elapsed', { seconds: elapsed })}`,
      inline: false,
    });
  }

  embed.setFooter({ text: t('discord.tasks.cancelHint') });

  await msg.reply({ embeds: [embed] });
}

/**
 * !cancel <taskId> - 작업 취소
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
 * !limits - 에이전트 일일 제한 현황
 */
export async function handleLimits(msg: Message): Promise<void> {
  const remaining = linear.getRemainingDailyIssues();
  const used = linear.getDailyIssueCount();
  const total = 10;

  const progressBar = '█'.repeat(used) + '░'.repeat(remaining);

  const embed = new EmbedBuilder()
    .setTitle(t('discord.limits.title'))
    .setColor(remaining > 3 ? 0x00ae86 : remaining > 0 ? 0xffaa00 : 0xff0000)
    .addFields(
      {
        name: t('discord.limits.issueCreation'),
        value: `${progressBar} ${used}/${total}\n${t('discord.limits.remaining', { n: remaining })}`,
        inline: false,
      }
    )
    .setFooter({ text: t('discord.limits.resetNote') })
    .setTimestamp();

  await msg.reply({ embeds: [embed] });
}

/**
 * !schedule - 스케줄 관리
 */
export async function handleSchedule(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !schedule list 또는 !schedule (목록)
  if (!subCommand || subCommand === 'list') {
    const schedules = await scheduler.listSchedules();
    const formatted = scheduler.formatScheduleList(schedules);

    const embed = new EmbedBuilder()
      .setTitle(t('discord.schedule.title'))
      .setDescription(formatted)
      .setColor(0x00ae86)
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  // !schedule run <name> - 즉시 실행
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

  // !schedule toggle <name> - 활성화/비활성화
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

  // 알 수 없는 서브 명령
  await msg.reply(t('discord.schedule.helpText'));
}

/**
 * !codex - 세션 기록 관리
 */
export async function handleCodex(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !codex 또는 !codex list - 최근 세션 목록
  if (!subCommand || subCommand === 'list') {
    const recent = await codex.getRecentSessions(10);

    if (recent.length === 0) {
      await msg.reply(t('discord.codex.noSessions'));
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(t('discord.codex.title'))
      .setDescription(recent.join('\n'))
      .setColor(0x9b59b6)
      .setFooter({ text: t('discord.codex.pathLabel', { path: codex.getCodexPath() }) })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  // !codex save "<title>" [tags...] - 현재 세션 저장
  if (subCommand === 'save') {
    const titleMatch = msg.content.match(/!codex save "(.+?)"/);
    const title = titleMatch?.[1];

    if (!title) {
      await msg.reply(t('discord.codex.saveUsage'));
      return;
    }

    // 태그 추출 (제목 뒤의 단어들)
    const afterTitle = msg.content.slice(msg.content.indexOf('"', msg.content.indexOf('"') + 1) + 1).trim();
    const tags = afterTitle.split(/\s+/).filter(t => t.length > 0);

    // 세션 저장 요청 메시지
    await msg.reply(t('discord.codex.saving', { title, tags: tags.length > 0 ? tags.map(tag => `\`${tag}\``).join(' ') : t('discord.codex.noTags') }));

    // 실제 저장은 Claude가 작업 완료 후 호출해야 함
    // 여기서는 빈 세션으로 저장 (나중에 업데이트 가능)
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

  // !codex path - 경로 확인
  if (subCommand === 'path') {
    await msg.reply(`📁 ${t('discord.codex.pathLabel', { path: codex.getCodexPath() })}`);
    return;
  }

  // 알 수 없는 서브 명령
  await msg.reply(t('discord.codex.helpText'));
}

// ============================================
// Autonomous Runner Commands
// ============================================

/**
 * !auto - 자율 실행 모드 관리
 */
export async function handleAuto(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !auto status 또는 !auto - 상태 확인
  if (!subCommand || subCommand === 'status') {
    try {
      const runner = autonomous.getRunner();
      const stats = runner.getStats();

      const embed = new EmbedBuilder()
        .setTitle(t('discord.auto.title'))
        .setColor(stats.isRunning ? 0x00AE86 : 0x95A5A6)
        .addFields(
          { name: t('discord.auto.statusLabel'), value: stats.isRunning ? `✅ ${t('discord.auto.statusRunning')}` : `⏹️ ${t('discord.auto.statusStopped')}`, inline: true },
          { name: t('discord.auto.completedFailed'), value: `${stats.engineStats.totalCompleted}/${stats.engineStats.totalFailed}`, inline: true },
          { name: t('discord.auto.pendingApprovalLabel'), value: stats.pendingApproval ? `⏳ ${t('discord.auto.pendingApproval')}` : t('discord.auto.noPending'), inline: true },
        )
        .setTimestamp();

      if (stats.lastHeartbeat > 0) {
        embed.addFields({
          name: t('discord.auto.lastHeartbeatLabel'),
          value: new Date(stats.lastHeartbeat).toLocaleString(getDateLocale()),
          inline: false,
        });
      }

      await msg.reply({ embeds: [embed] });
    } catch {
      await msg.reply(t('discord.auto.notInitialized'));
    }
    return;
  }

  // !auto start [schedule] [--pair] - 시작
  if (subCommand === 'start') {
    // --pair 옵션 체크
    const hasPairFlag = args.includes('--pair') || args.includes('pair');
    const scheduleArg = args.find(a => a !== 'start' && a !== '--pair' && a !== 'pair');
    const schedule = scheduleArg || '*/30 * * * *'; // 기본: 30분마다

    const startingMsg = hasPairFlag ? t('discord.auto.startingPair') : t('discord.auto.startingSolo');
    await msg.reply(`🚀 ${startingMsg}\nSchedule: \`${schedule}\``);

    try {
      // Discord reporter 등록
      autonomous.setDiscordReporter(async (content) => {
        const channel = msg.channel as TextChannel;
        if (typeof content === 'string') {
          await channel.send(content);
        } else {
          await channel.send(content);
        }
      });

      // Linear fetcher 등록
      autonomous.setLinearFetcher(async (): Promise<TaskItem[]> => {
        try {
          const issues = await linear.getMyIssues();
          return issues.map((issue: any) => linearIssueToTask({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            priority: issue.priority || 3,
            dueDate: issue.dueDate,
            project: issue.project,
          }));
        } catch (err) {
          console.error('Linear fetch error:', err);
          return [];
        }
      });

      // Runner 시작
      console.log(`[Auto] Starting with pairMode: ${hasPairFlag}`);
      await autonomous.startAutonomous({
        linearTeamId: process.env.LINEAR_TEAM_ID || '',
        allowedProjects: ['~/dev/claude-swarm', '~/dev/tools/pykis', '~/dev'],
        heartbeatSchedule: schedule,
        autoExecute: true, // 자동 실행 (승인 불필요)
        maxConsecutiveTasks: 3,
        cooldownSeconds: 300,
        dryRun: false,
        pairMode: hasPairFlag,
        pairMaxAttempts: pairModeConfig?.maxAttempts ?? 3,
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

  // !auto stop - 중지
  if (subCommand === 'stop') {
    autonomous.stopAutonomous();
    await msg.reply(`⏹️ ${t('discord.auto.stopped')}`);
    return;
  }

  // !auto run - 즉시 heartbeat 실행
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

  // !auto approve on/off - 자동 승인 토글
  if (subCommand === 'approve' && (args[1] === 'on' || args[1] === 'off')) {
    const autoApprove = args[1] === 'on';
    await msg.reply(`${autoApprove ? '⚠️ 자동 실행' : '✅ 수동 승인'} 모드로 변경하려면 재시작이 필요합니다.`);
    return;
  }

  // 도움말
  await msg.reply(t('discord.auto.helpText'));
}

/**
 * !approve - 대기 중인 작업 승인
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
 * !reject - 대기 중인 작업 거부
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
