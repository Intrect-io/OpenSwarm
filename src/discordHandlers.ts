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

/**
 * !status [session] - 상태 확인
 */
export async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
  if (!getAgentStatus) {
    await msg.reply('서비스가 초기화되지 않았습니다.');
    return;
  }

  const statuses = getAgentStatus(sessionName);

  if (statuses.length === 0) {
    await msg.reply(sessionName ? `세션 "${sessionName}"을 찾을 수 없습니다.` : '활성 에이전트가 없습니다.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🤖 Claude Swarm 상태')
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
      : '\n📋 할당된 이슈 없음';

    const lastHB = status.lastHeartbeat
      ? `\n🕐 마지막 heartbeat: ${formatTimeAgo(status.lastHeartbeat)}`
      : '';

    embed.addFields({
      name: `${stateEmoji} ${status.name}`,
      value: `상태: ${status.state}${issueInfo}${lastHB}`,
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
    await msg.reply('활성 tmux 세션이 없습니다.');
    return;
  }

  await msg.reply(`**활성 tmux 세션:**\n${sessions.map(s => `- ${s}`).join('\n')}`);
}

/**
 * !run <session> "<task>" - 작업 실행
 */
export async function handleRun(msg: Message, args: string[]): Promise<void> {
  const sessionName = args[0];
  const taskMatch = msg.content.match(/!run \w+ "(.+)"/);
  const task = taskMatch?.[1];

  if (!sessionName || !task) {
    await msg.reply('사용법: !run <session> "<task>"');
    return;
  }

  const exists = await tmux.sessionExists(sessionName);
  if (!exists) {
    await msg.reply(`세션 "${sessionName}"이 존재하지 않습니다.`);
    return;
  }

  await tmux.sendTask(sessionName, task);
  await msg.reply(`✅ **${sessionName}**에 작업 전송:\n\`${task}\``);

  // 결과 캡처 (5초 후)
  setTimeout(async () => {
    const output = await tmux.capturePane(sessionName, 20);
    const truncated = output.length > 1500 ? output.slice(-1500) + '...' : output;
    await msg.reply(`**[${sessionName}] 출력:**\n\`\`\`\n${truncated}\n\`\`\``);
  }, 5000);
}

/**
 * !pause <session> - 자율 작업 중지
 */
export async function handlePause(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply('사용법: !pause <session>');
    return;
  }

  if (onPauseAgent) {
    onPauseAgent(sessionName);
    await msg.reply(`⏸️ **${sessionName}** 자율 작업 일시 중지`);
  }
}

/**
 * !resume <session> - 자율 작업 재개
 */
export async function handleResume(msg: Message, sessionName: string): Promise<void> {
  if (!sessionName) {
    await msg.reply('사용법: !resume <session>');
    return;
  }

  if (onResumeAgent) {
    onResumeAgent(sessionName);
    await msg.reply(`▶️ **${sessionName}** 자율 작업 재개`);
  }
}

/**
 * !issues [session] - Linear 이슈 목록
 */
export async function handleIssues(msg: Message, _sessionName?: string): Promise<void> {
  // TODO: Linear 이슈 조회 구현
  await msg.reply('Linear 이슈 조회 기능 구현 예정');
}

/**
 * !log <session> [lines] - 최근 출력 확인
 */
export async function handleLog(msg: Message, sessionName: string, lines: number): Promise<void> {
  if (!sessionName) {
    await msg.reply('사용법: !log <session> [lines]');
    return;
  }

  const exists = await tmux.sessionExists(sessionName);
  if (!exists) {
    await msg.reply(`세션 "${sessionName}"이 존재하지 않습니다.`);
    return;
  }

  const output = await tmux.capturePane(sessionName, lines);
  const truncated = output.length > 1800 ? output.slice(-1800) + '\n...(truncated)' : output;

  await msg.reply(`**[${sessionName}] 최근 ${lines}줄:**\n\`\`\`\n${truncated}\n\`\`\``);
}

/**
 * !ci - GitHub CI 상태 확인
 */
export async function handleCI(msg: Message): Promise<void> {
  const repos = getGithubRepos?.() ?? [];

  if (repos.length === 0) {
    await msg.reply('설정된 GitHub 레포가 없습니다.');
    return;
  }

  await msg.reply('🔍 CI 상태 확인 중...');
  const summary = await github.summarizeCIFailures(repos);
  await msg.reply(summary);
}

/**
 * !notifications - GitHub 알림 확인
 */
export async function handleNotifications(msg: Message): Promise<void> {
  await msg.reply('🔍 GitHub 알림 확인 중...');
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
      await msg.reply('~/dev에서 Git 저장소를 찾을 수 없습니다.');
      return;
    }
    await msg.reply(`**~/dev 저장소 목록:**\n${repos.map(r => `- ${r}`).join('\n')}`);
    return;
  }

  // !dev <repo> "<task>" 파싱
  const repo = args[0];
  const taskMatch = msg.content.match(/!dev \S+ "(.+)"/s);
  const task = taskMatch?.[1];

  if (!repo || !task) {
    await msg.reply(
      '**사용법:** `!dev <repo> "<task>"`\n' +
      '**예시:** `!dev pykis "get_balance API 파라미터 확인해줘"`\n\n' +
      '`!dev list` - 알려진 저장소 목록\n' +
      '`!dev scan` - ~/dev 폴더 스캔'
    );
    return;
  }

  // 경로 확인
  const resolvedPath = dev.resolveRepoPath(repo);
  if (!resolvedPath) {
    await msg.reply(
      `❌ 저장소를 찾을 수 없습니다: \`${repo}\`\n\n` +
      '`!dev list`로 사용 가능한 저장소를 확인하세요.'
    );
    return;
  }

  // 작업 시작 알림
  await msg.reply(`🚀 **${repo}**에서 작업 시작...\n📁 \`${resolvedPath}\`\n📝 \`${task.slice(0, 100)}${task.length > 100 ? '...' : ''}\``);

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
              _lastProgressMsg = await msg.reply(`**[${repo}] 진행 중...**\n\`\`\`\n${combined}\n\`\`\``);
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
      const header = `${statusEmoji} **[${repo}] 완료** (exit: ${exitCode})`;

      // 결과가 짧으면 한 번에
      if (truncated.length <= MAX_LEN) {
        await msg.reply(`${header}\n\`\`\`\n${truncated || '(출력 없음)'}\n\`\`\``);
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
          await msg.reply(`...(출력이 너무 깁니다. 전체 ${chunks.length}개 청크 중 3개만 표시)`);
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
    .setTitle('📁 알려진 저장소')
    .setColor(0x00ae86)
    .setDescription('`!dev <별칭> "<작업>"` 형식으로 사용');

  const available = repos.filter(r => r.exists);
  const unavailable = repos.filter(r => !r.exists);

  if (available.length > 0) {
    embed.addFields({
      name: '✅ 사용 가능',
      value: available.map(r => `\`${r.alias}\` → ${r.path}`).join('\n'),
      inline: false,
    });
  }

  if (unavailable.length > 0) {
    embed.addFields({
      name: '❌ 경로 없음',
      value: unavailable.map(r => `\`${r.alias}\` → ${r.path}`).join('\n'),
      inline: false,
    });
  }

  embed.addFields({
    name: '💡 팁',
    value: '`!dev scan`으로 ~/dev 폴더 전체 스캔\n상대경로도 가능: `!dev tools/pykis "..."`',
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
    await msg.reply('실행 중인 dev 작업이 없습니다.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🔄 실행 중인 작업')
    .setColor(0xffaa00);

  for (const task of tasks) {
    const elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    embed.addFields({
      name: `${task.repo}`,
      value: `ID: \`${task.taskId}\`\n경로: ${task.path}\n요청자: ${task.requestedBy}\n경과: ${elapsed}초`,
      inline: false,
    });
  }

  embed.setFooter({ text: '!cancel <taskId>로 취소 가능' });

  await msg.reply({ embeds: [embed] });
}

/**
 * !cancel <taskId> - 작업 취소
 */
export async function handleCancel(msg: Message, taskId: string): Promise<void> {
  if (!taskId) {
    await msg.reply('사용법: `!cancel <taskId>`\n`!tasks`로 작업 ID 확인');
    return;
  }

  const success = dev.cancelTask(taskId);

  if (success) {
    await msg.reply(`⏹️ 작업 취소됨: \`${taskId}\``);
  } else {
    await msg.reply(`❌ 작업을 찾을 수 없습니다: \`${taskId}\``);
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
    .setTitle('📊 에이전트 일일 제한')
    .setColor(remaining > 3 ? 0x00ae86 : remaining > 0 ? 0xffaa00 : 0xff0000)
    .addFields(
      {
        name: 'Linear 이슈 생성',
        value: `${progressBar} ${used}/${total}\n남은 횟수: **${remaining}**개`,
        inline: false,
      }
    )
    .setFooter({ text: '매일 자정(UTC) 리셋' })
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
      .setTitle('📅 스케줄 목록')
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
      await msg.reply('사용법: `!schedule run <name>`');
      return;
    }

    const success = await scheduler.runNow(name);
    if (success) {
      await msg.reply(`▶️ **${name}** 스케줄 즉시 실행 시작`);
    } else {
      await msg.reply(`❌ 스케줄을 찾을 수 없습니다: \`${name}\``);
    }
    return;
  }

  // !schedule toggle <name> - 활성화/비활성화
  if (subCommand === 'toggle') {
    const name = args[1];
    if (!name) {
      await msg.reply('사용법: `!schedule toggle <name>`');
      return;
    }

    const job = await scheduler.toggleSchedule(name);
    if (job) {
      const status = job.enabled ? '🟢 활성화' : '⏸️ 비활성화';
      await msg.reply(`${status}: **${job.name}**`);
    } else {
      await msg.reply(`❌ 스케줄을 찾을 수 없습니다: \`${name}\``);
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
      await msg.reply(
        '**사용법:**\n`!schedule add <name> <project_path> <interval> "<prompt>"`\n\n' +
        '**예시:**\n`!schedule add myproject-check ~/dev/myproject 30m "테스트 실행하고 결과 보고해줘"`\n\n' +
        '**interval:** `30m`, `1h`, `2h`, `1d` 또는 cron 표현식'
      );
      return;
    }

    try {
      const job = await scheduler.addSchedule(name, projectPath, prompt, interval, msg.author.username);
      await msg.reply(`✅ 스케줄 추가됨: **${job.name}** (${job.schedule})`);
    } catch (err) {
      await msg.reply(`❌ 스케줄 추가 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // !schedule remove <name>
  if (subCommand === 'remove' || subCommand === 'delete') {
    const name = args[1];
    if (!name) {
      await msg.reply('사용법: `!schedule remove <name>`');
      return;
    }

    const success = await scheduler.removeSchedule(name);
    if (success) {
      await msg.reply(`🗑️ 스케줄 삭제됨: **${name}**`);
    } else {
      await msg.reply(`❌ 스케줄을 찾을 수 없습니다: \`${name}\``);
    }
    return;
  }

  // 알 수 없는 서브 명령
  await msg.reply(
    '**스케줄 명령어:**\n' +
    '`!schedule` - 스케줄 목록\n' +
    '`!schedule run <name>` - 즉시 실행\n' +
    '`!schedule toggle <name>` - 활성화/비활성화\n' +
    '`!schedule add <name> <path> <interval> "<prompt>"` - 추가\n' +
    '`!schedule remove <name>` - 삭제'
  );
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
      await msg.reply('📚 기록된 세션이 없습니다.\n`!codex save "<제목>"` 으로 현재 세션을 저장하세요.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📚 Codex - 최근 세션')
      .setDescription(recent.join('\n'))
      .setColor(0x9b59b6)
      .setFooter({ text: `경로: ${codex.getCodexPath()}` })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  // !codex save "<title>" [tags...] - 현재 세션 저장
  if (subCommand === 'save') {
    const titleMatch = msg.content.match(/!codex save "(.+?)"/);
    const title = titleMatch?.[1];

    if (!title) {
      await msg.reply('사용법: `!codex save "<제목>" [tags...]`\n예시: `!codex save "pykis CI 수정" ci fix`');
      return;
    }

    // 태그 추출 (제목 뒤의 단어들)
    const afterTitle = msg.content.slice(msg.content.indexOf('"', msg.content.indexOf('"') + 1) + 1).trim();
    const tags = afterTitle.split(/\s+/).filter(t => t.length > 0);

    // 세션 저장 요청 메시지
    await msg.reply(`📝 세션 저장 중...\n제목: **${title}**\n태그: ${tags.length > 0 ? tags.map(t => `\`${t}\``).join(' ') : '없음'}`);

    // 실제 저장은 Claude가 작업 완료 후 호출해야 함
    // 여기서는 빈 세션으로 저장 (나중에 업데이트 가능)
    try {
      const { summaryPath } = await codex.quickSave({
        title,
        tags,
        result: 'success',
      });

      await msg.reply(`✅ 세션 저장 완료!\n📄 \`${summaryPath}\``);
    } catch (err) {
      await msg.reply(`❌ 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // !codex path - 경로 확인
  if (subCommand === 'path') {
    await msg.reply(`📁 Codex 경로: \`${codex.getCodexPath()}\``);
    return;
  }

  // 알 수 없는 서브 명령
  await msg.reply(
    '**📚 Codex 명령어:**\n' +
    '`!codex` - 최근 세션 목록\n' +
    '`!codex save "<제목>" [tags]` - 세션 저장\n' +
    '`!codex path` - 저장 경로 확인'
  );
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
        .setTitle('🤖 자율 실행 상태')
        .setColor(stats.isRunning ? 0x00AE86 : 0x95A5A6)
        .addFields(
          { name: '상태', value: stats.isRunning ? '✅ 실행 중' : '⏹️ 중지', inline: true },
          { name: '완료/실패', value: `${stats.engineStats.totalCompleted}/${stats.engineStats.totalFailed}`, inline: true },
          { name: '승인 대기', value: stats.pendingApproval ? '⏳ 있음' : '없음', inline: true },
        )
        .setTimestamp();

      if (stats.lastHeartbeat > 0) {
        embed.addFields({
          name: '마지막 Heartbeat',
          value: new Date(stats.lastHeartbeat).toLocaleString('ko-KR'),
          inline: false,
        });
      }

      await msg.reply({ embeds: [embed] });
    } catch {
      await msg.reply('🤖 자율 실행이 초기화되지 않았습니다.\n`!auto start` 로 시작하세요.');
    }
    return;
  }

  // !auto start [schedule] [--pair] - 시작
  if (subCommand === 'start') {
    // --pair 옵션 체크
    const hasPairFlag = args.includes('--pair') || args.includes('pair');
    const scheduleArg = args.find(a => a !== 'start' && a !== '--pair' && a !== 'pair');
    const schedule = scheduleArg || '*/30 * * * *'; // 기본: 30분마다

    const modeStr = hasPairFlag ? '(Worker/Reviewer 페어 모드)' : '(단일 에이전트)';
    await msg.reply(`🚀 자율 실행 모드 시작 중... ${modeStr}\nSchedule: \`${schedule}\``);

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
        ? '✅ 자율 실행 모드 (페어)가 시작되었습니다.\nWorker가 작업하고 Reviewer가 검토합니다.'
        : '✅ 자율 실행 모드가 시작되었습니다.';
      await msg.reply(startMsg);
    } catch (err) {
      await msg.reply(`❌ 시작 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // !auto stop - 중지
  if (subCommand === 'stop') {
    autonomous.stopAutonomous();
    await msg.reply('⏹️ 자율 실행 모드가 중지되었습니다.');
    return;
  }

  // !auto run - 즉시 heartbeat 실행
  if (subCommand === 'run') {
    try {
      const runner = autonomous.getRunner();
      await msg.reply('🔄 Heartbeat 실행 중...');
      await runner.runNow();
    } catch {
      await msg.reply('❌ Runner가 시작되지 않았습니다. `!auto start` 먼저 실행하세요.');
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
  await msg.reply(
    '**🤖 자율 실행 명령어:**\n' +
    '`!auto` - 상태 확인\n' +
    '`!auto start [cron] [--pair]` - 시작 (기본: 30분마다)\n' +
    '  예: `!auto start */30 * * * * --pair` (페어 모드)\n' +
    '`!auto stop` - 중지\n' +
    '`!auto run` - 즉시 실행\n' +
    '`!approve` - 대기 중인 작업 승인\n' +
    '`!reject` - 대기 중인 작업 거부'
  );
}

/**
 * !approve - 대기 중인 작업 승인
 */
export async function handleApprove(msg: Message): Promise<void> {
  try {
    const runner = autonomous.getRunner();
    const approved = await runner.approve();

    if (approved) {
      await msg.reply('✅ 작업이 승인되어 실행됩니다.');
    } else {
      await msg.reply('⏳ 승인 대기 중인 작업이 없습니다.');
    }
  } catch {
    await msg.reply('❌ Runner가 시작되지 않았습니다.');
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
      await msg.reply('❌ 작업이 거부되었습니다.');
    } else {
      await msg.reply('⏳ 승인 대기 중인 작업이 없습니다.');
    }
  } catch {
    await msg.reply('❌ Runner가 시작되지 않았습니다.');
  }
}
