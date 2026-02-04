// ============================================
// Claude Swarm - Discord Bot
// ============================================

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
  EmbedBuilder,
} from 'discord.js';
import type { SwarmEvent, AgentStatus, LinearIssueInfo } from './types.js';
import * as tmux from './tmux.js';
import * as linear from './linear.js';
import * as github from './github.js';
import * as dev from './dev.js';

let client: Client | null = null;
let reportChannelId: string = '';

// 콜백 함수들 (service에서 설정)
let onPauseAgent: ((name: string) => void) | null = null;
let onResumeAgent: ((name: string) => void) | null = null;
let getAgentStatus: ((name?: string) => AgentStatus[]) | null = null;
let getGithubRepos: (() => string[]) | null = null;

/**
 * 콜백 함수 설정
 */
export function setCallbacks(callbacks: {
  onPause: (name: string) => void;
  onResume: (name: string) => void;
  getStatus: (name?: string) => AgentStatus[];
  getRepos: () => string[];
}): void {
  onPauseAgent = callbacks.onPause;
  onResumeAgent = callbacks.onResume;
  getAgentStatus = callbacks.getStatus;
  getGithubRepos = callbacks.getRepos;
}

/**
 * Discord 봇 초기화 및 시작
 */
export async function initDiscord(token: string, channelId: string): Promise<void> {
  reportChannelId = channelId;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('ready', () => {
    console.log(`Discord bot logged in as ${client?.user?.tag}`);
  });

  client.on('messageCreate', handleMessage);

  await client.login(token);
}

/**
 * 메시지 핸들러
 */
async function handleMessage(msg: Message): Promise<void> {
  if (msg.author.bot) return;
  if (!msg.content.startsWith('!')) return;

  const [command, ...args] = msg.content.slice(1).split(' ');

  try {
    switch (command) {
      case 'status':
        await handleStatus(msg, args[0]);
        break;

      case 'list':
        await handleList(msg);
        break;

      case 'run':
        await handleRun(msg, args);
        break;

      case 'pause':
        await handlePause(msg, args[0]);
        break;

      case 'resume':
        await handleResume(msg, args[0]);
        break;

      case 'issues':
        await handleIssues(msg, args[0]);
        break;

      case 'log':
        await handleLog(msg, args[0], parseInt(args[1]) || 30);
        break;

      case 'ci':
        await handleCI(msg);
        break;

      case 'notifications':
      case 'notif':
        await handleNotifications(msg);
        break;

      case 'dev':
        await handleDev(msg, args);
        break;

      case 'repos':
        await handleRepos(msg);
        break;

      case 'tasks':
        await handleTasks(msg);
        break;

      case 'cancel':
        await handleCancel(msg, args[0]);
        break;

      case 'limits':
        await handleLimits(msg);
        break;

      case 'help':
        await handleHelp(msg);
        break;

      default:
        await msg.reply(`알 수 없는 명령어: ${command}. !help로 도움말 확인`);
    }
  } catch (err) {
    console.error('Command error:', err);
    await msg.reply(`오류 발생: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * !status [session] - 상태 확인
 */
async function handleStatus(msg: Message, sessionName?: string): Promise<void> {
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
async function handleList(msg: Message): Promise<void> {
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
async function handleRun(msg: Message, args: string[]): Promise<void> {
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
async function handlePause(msg: Message, sessionName: string): Promise<void> {
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
async function handleResume(msg: Message, sessionName: string): Promise<void> {
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
async function handleIssues(msg: Message, sessionName?: string): Promise<void> {
  // TODO: Linear 이슈 조회 구현
  await msg.reply('Linear 이슈 조회 기능 구현 예정');
}

/**
 * !log <session> [lines] - 최근 출력 확인
 */
async function handleLog(msg: Message, sessionName: string, lines: number): Promise<void> {
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
async function handleCI(msg: Message): Promise<void> {
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
async function handleNotifications(msg: Message): Promise<void> {
  await msg.reply('🔍 GitHub 알림 확인 중...');
  const summary = await github.summarizeNotifications();
  await msg.reply(summary);
}

/**
 * !dev <repo> "<task>" - 특정 저장소에서 개발 작업 실행
 */
async function handleDev(msg: Message, args: string[]): Promise<void> {
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
  let lastProgressMsg: Message | null = null;
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
              lastProgressMsg = await msg.reply(`**[${repo}] 진행 중...**\n\`\`\`\n${combined}\n\`\`\``);
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
async function handleRepos(msg: Message): Promise<void> {
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
async function handleTasks(msg: Message): Promise<void> {
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
async function handleCancel(msg: Message, taskId: string): Promise<void> {
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
async function handleLimits(msg: Message): Promise<void> {
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
 * !help - 도움말
 */
async function handleHelp(msg: Message): Promise<void> {
  const help = `
**🤖 Claude Swarm 명령어**

**🔧 개발 작업** (Claude 파견)
\`!dev <repo> "<task>"\` - 저장소에서 개발 작업 실행
\`!dev list\` - 알려진 저장소 목록
\`!dev scan\` - ~/dev 폴더 스캔
\`!repos\` - 저장소 목록 상세
\`!tasks\` - 실행 중인 작업 목록
\`!cancel <taskId>\` - 작업 취소

**에이전트 관리**
\`!status [session]\` - 에이전트 상태 확인
\`!list\` - 활성 tmux 세션 목록
\`!run <session> "<task>"\` - 특정 작업 실행
\`!pause <session>\` - 자율 작업 일시 중지
\`!resume <session>\` - 자율 작업 재개
\`!log <session> [lines]\` - 최근 출력 확인

**Linear**
\`!issues [session]\` - Linear 이슈 목록
\`!limits\` - 에이전트 일일 제한 현황

**GitHub**
\`!ci\` - CI 실패 상태 확인
\`!notif\` - GitHub 알림 확인

\`!help\` - 이 도움말

---
**예시:**
\`!dev pykis "get_balance 함수 파라미터 확인해줘"\`
\`!dev tools/pykiwoom "실시간 구독 로직 분석"\`
`;

  await msg.reply(help);
}

/**
 * 이벤트를 Discord로 보고
 */
export async function reportEvent(event: SwarmEvent): Promise<void> {
  if (!client) return;

  const channel = await client.channels.fetch(reportChannelId);
  if (!channel || !(channel instanceof TextChannel)) return;

  const emoji = {
    issue_started: '🚀',
    issue_completed: '✅',
    issue_blocked: '⚠️',
    build_failed: '❌',
    test_failed: '❌',
    ci_failed: '🔴',
    github_notification: '📬',
    commit: '📝',
    error: '🔥',
  }[event.type] ?? '📢';

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} [${event.session}] ${event.type.replace(/_/g, ' ')}`)
    .setDescription(event.message)
    .setColor(event.type.includes('failed') || event.type === 'error' ? 0xff0000 : 0x00ae86)
    .setTimestamp(event.timestamp);

  if (event.issueId) {
    embed.addFields({ name: 'Issue', value: event.issueId });
  }

  if (event.url) {
    embed.setURL(event.url);
  }

  await channel.send({ embeds: [embed] });
}

/**
 * 시간 포맷팅 (상대 시간)
 */
function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}시간 전`;
  if (minutes > 0) return `${minutes}분 전`;
  return '방금 전';
}

/**
 * Discord 봇 종료
 */
export async function stopDiscord(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
  }
}
