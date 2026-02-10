// ============================================
// Claude Swarm - Discord Bot
// ============================================

import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
  ChannelType,
} from 'discord.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { SwarmEvent, AgentStatus } from './types.js';
import * as tmux from './tmux.js';
import * as linear from './linear.js';
import * as github from './github.js';
import * as dev from './dev.js';
import * as memory from './memory.js';
import * as scheduler from './scheduler.js';
import * as codex from './codex.js';
import * as autonomous from './autonomousRunner.js';
import { linearIssueToTask, TaskItem } from './decisionEngine.js';
import * as agentPair from './agentPair.js';
import * as worker from './worker.js';
import * as reviewer from './reviewer.js';
import * as pairMetrics from './pairMetrics.js';
import * as projectMapper from './projectMapper.js';
import * as pairWebhook from './pairWebhook.js';
// WorkerResult is re-exported from agentPair

let client: Client | null = null;
let reportChannelId: string = '';

// 허용된 유저 ID (환경변수에서 로드)
const ALLOWED_USER_IDS = process.env.DISCORD_ALLOWED_USERS?.split(',').map(id => id.trim()) || [];

// 대화 내역 저장 경로
const CHAT_HISTORY_FILE = '/tmp/claude-swarm-chat-history.json';

// ============================================
// OpenClaw-style History Management
// ============================================

// 채널별 히스토리 맵 (메모리 캐시)
const channelHistoryMap = new Map<string, HistoryEntry[]>();

// 히스토리 설정 (OpenClaw 기본값 참고)
const HISTORY_LIMIT = 30;  // 최근 30개 메시지 (OpenClaw 기본 50개)
const MAX_HISTORY_CHANNELS = 100;  // 최대 채널 수 (LRU eviction)

// 히스토리 엔트리 타입
interface HistoryEntry {
  sender: string;
  senderId: string;
  body: string;
  response?: string;
  timestamp: number;
  messageId?: string;
}

// 컨텍스트 마커 (OpenClaw 스타일)
const HISTORY_CONTEXT_MARKER = '[Chat messages since your last reply - for context]';
const CURRENT_MESSAGE_MARKER = '[Current message]';

/**
 * LRU 방식으로 오래된 채널 히스토리 정리
 */
function evictOldHistoryChannels(): void {
  if (channelHistoryMap.size <= MAX_HISTORY_CHANNELS) return;

  const keysToDelete = channelHistoryMap.size - MAX_HISTORY_CHANNELS;
  const iterator = channelHistoryMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key) channelHistoryMap.delete(key);
  }
}

/**
 * 히스토리 엔트리 추가
 */
function appendHistoryEntry(channelId: string, entry: HistoryEntry): void {
  const history = channelHistoryMap.get(channelId) ?? [];
  history.push(entry);

  // 최대 개수 유지
  while (history.length > HISTORY_LIMIT) {
    history.shift();
  }

  // LRU: 기존 키 삭제 후 재삽입 (순서 갱신)
  if (channelHistoryMap.has(channelId)) {
    channelHistoryMap.delete(channelId);
  }
  channelHistoryMap.set(channelId, history);

  evictOldHistoryChannels();
}

/**
 * 마지막 히스토리 엔트리에 응답 추가
 */
function updateLastHistoryResponse(channelId: string, response: string): void {
  const history = channelHistoryMap.get(channelId);
  if (history && history.length > 0) {
    history[history.length - 1].response = response;
  }
}

/**
 * 히스토리 엔트리 포맷 (OpenClaw envelope 스타일)
 */
function formatHistoryEntry(entry: HistoryEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit'
  });

  let formatted = `[${time}] ${entry.sender}: ${entry.body}`;

  if (entry.response) {
    // 응답도 전체 포함 (잘림 없음)
    formatted += `\n[${time}] VEGA: ${entry.response}`;
  }

  return formatted;
}

/**
 * 채널 히스토리를 컨텍스트로 빌드 (OpenClaw 스타일)
 */
function buildHistoryContext(channelId: string, currentMessage: string): string {
  const history = channelHistoryMap.get(channelId) ?? [];

  if (history.length === 0) {
    return currentMessage;
  }

  // 마지막 엔트리 제외 (현재 메시지와 중복 방지)
  const pastEntries = history.slice(0, -1);

  if (pastEntries.length === 0) {
    return currentMessage;
  }

  const historyText = pastEntries.map(formatHistoryEntry).join('\n\n');

  return `${HISTORY_CONTEXT_MARKER}\n${historyText}\n\n${CURRENT_MESSAGE_MARKER}\n${currentMessage}`;
}

// ============================================
// Project Context Detection
// ============================================

// 프로젝트 스캔 기본 경로
const PROJECT_BASE_PATHS = ['~/dev', '~/dev/tools', '~/projects'];

// 프로젝트명 패턴 (Linear 이슈 ID, 프로젝트명 등)
const PROJECT_PATTERNS = [
  // Linear 이슈 ID에서 프로젝트 추출 (예: INT-123, STONKS-456)
  /\b([A-Z]{2,10})-\d+\b/g,
  // 명시적 프로젝트 언급
  /\b(STONKS|VELA|PyKIS|pykis|pykiwoom|HIVE|claude-swarm)\b/gi,
  // "~~ 프로젝트" 패턴
  /(\w+)\s*프로젝트/gi,
];

// 이슈 접두사 → 프로젝트명 매핑 (Linear 이슈 ID 기반)
const ISSUE_PREFIX_MAP: Record<string, string> = {
  'INT': 'claude-swarm',  // HIVE 프로젝트
  'STONKS': 'STONKS',
  'VELA': 'VELA',
  'PYKIS': 'pykis',
  'PKW': 'pykiwoom',
  'SA': 'STONKS',  // STONKS-SaaS
};

/**
 * 메시지에서 프로젝트 힌트 추출
 */
function extractProjectHints(message: string): string[] {
  const hints: Set<string> = new Set();

  for (const pattern of PROJECT_PATTERNS) {
    const matches = message.matchAll(pattern);
    for (const match of matches) {
      const hint = match[1] || match[0];
      hints.add(hint.toUpperCase());
    }
  }

  return Array.from(hints);
}

/**
 * 프로젝트 힌트로 로컬 경로 찾기
 */
async function resolveProjectPath(hints: string[]): Promise<string | null> {
  if (hints.length === 0) return null;

  // 로컬 프로젝트 스캔
  const localProjects = await projectMapper.scanLocalProjects(PROJECT_BASE_PATHS);

  for (const hint of hints) {
    // 1. 이슈 접두사 매핑 확인
    const mappedName = ISSUE_PREFIX_MAP[hint];
    if (mappedName) {
      const match = projectMapper.findBestMatch(mappedName, localProjects);
      if (match && match.confidence >= 0.7) {
        console.log(`[ProjectContext] Resolved via prefix: ${hint} → ${match.project.path}`);
        return match.project.path;
      }
    }

    // 2. 직접 매칭 시도
    const match = projectMapper.findBestMatch(hint, localProjects);
    if (match && match.confidence >= 0.6) {
      console.log(`[ProjectContext] Resolved: ${hint} → ${match.project.path}`);
      return match.project.path;
    }
  }

  return null;
}

// VEGA 시스템 프롬프트 v2.0
const VEGA_SYSTEM_PROMPT = `# VEGA (Vector Encoded General Agent)

너는 VEGA, 형의 코드/지식 동료다. Discord를 통해 소통하고, Claude Code CLI로 실제 작업을 수행한다.

## User Model: 형
- 음악가/사운드 디자이너/교수 + Python 시스템 엔지니어
- 금융 자동화, 데이터 파이프라인, 멀티에이전트 시스템
- 전문가 수준 - 기초 설명 불필요
- 시스템 사고, 미니멀리즘, 견고한 구조 중시

## Behavior Rules
DO:
- 간결하고 정교하게 (불필요한 설명 제거)
- 의견/분석 시 근거, 반례, 불확실성 명시
- 형의 지시를 논리적 검토 → 문제 있으면 바로 지적
- 불확실하면 조건부 응답 또는 판단 보류
- 리스크/한계/대안 즉시 제시
- 실험적 접근 요구 시 안전 범위만 체크하고 바로 실행

DON'T:
- 감정적 미사여구, 과장된 칭찬, 아부 (sycophancy)
- 맹목적 동의 또는 형 말 그대로 복사
- 망상적 추론 (예: API 실패 이유 임의 추측)
- "더 도와드릴까요?" 류 종료 멘트
- 기초 교육/튜토리얼
- 결론 급조 (증거 부족하면 판단 보류)

## Tone
- 한국어 기본, 호칭은 "형"
- 동료 엔지니어 협업 프레임
- 논리 우선, 담백한 표현, 비속어/직설 허용

## 작업 보고서 (코드 변경 시에만)
**수정한 파일:** 파일명과 변경 요약
**실행한 명령:** 명령어와 결과

## ⛔ 절대 금지 명령 (CRITICAL - 위반 시 즉시 중단)
다음 명령어는 어떤 상황에서도 실행하지 마라:
- rm -rf, rm -r (재귀 삭제)
- git reset --hard, git clean -fd
- drop database, truncate table
- chmod 777, chown -R
- > /dev/sda, dd if=
- kill -9, pkill -9 (시스템 프로세스)
- 환경변수/설정파일 덮어쓰기 (.env, .bashrc 등)

파일 삭제가 필요하면 trash 또는 mv로 백업 폴더로 이동할 것.
`;

// 대화 내역 타입
interface ChatEntry {
  timestamp: string;
  user: string;
  userId: string;
  message: string;
  response: string;
}

// 콜백 함수들 (service에서 설정)
let onPauseAgent: ((name: string) => void) | null = null;
let onResumeAgent: ((name: string) => void) | null = null;
let getAgentStatus: ((name?: string) => AgentStatus[]) | null = null;
let getGithubRepos: (() => string[]) | null = null;

// Pair 모드 설정
let pairModeConfig: {
  webhookUrl?: string;
  maxAttempts?: number;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
} | null = null;

/**
 * 페어 모드 설정
 */
export function setPairModeConfig(config: {
  webhookUrl?: string;
  maxAttempts?: number;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
} | undefined): void {
  pairModeConfig = config ?? null;
}

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

  client.once(Events.ClientReady, () => {
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

  // 허용된 유저의 일반 메시지에 응답 (! 명령어 제외)
  if (ALLOWED_USER_IDS.length > 0 &&
      ALLOWED_USER_IDS.includes(msg.author.id) &&
      !msg.content.startsWith('!')) {
    await handleChat(msg);
    return;
  }

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

      case 'schedule':
      case 'schedules':
        await handleSchedule(msg, args);
        break;

      case 'codex':
        await handleCodex(msg, args);
        break;

      case 'auto':
        await handleAuto(msg, args);
        break;

      case 'approve':
        await handleApprove(msg);
        break;

      case 'reject':
        await handleReject(msg);
        break;

      case 'pair':
        await handlePair(msg, args);
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
async function handleIssues(msg: Message, _sessionName?: string): Promise<void> {
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
 * !schedule - 스케줄 관리
 */
async function handleSchedule(msg: Message, args: string[]): Promise<void> {
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
async function handleCodex(msg: Message, args: string[]): Promise<void> {
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
async function handleAuto(msg: Message, args: string[]): Promise<void> {
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
async function handleApprove(msg: Message): Promise<void> {
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
async function handleReject(msg: Message): Promise<void> {
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

**📅 스케줄**
\`!schedule\` - 스케줄 목록
\`!schedule run <name>\` - 즉시 실행
\`!schedule toggle <name>\` - 활성화/비활성화
\`!schedule add <name> <path> <interval> "<prompt>"\` - 추가

**GitHub**
\`!ci\` - CI 실패 상태 확인
\`!notif\` - GitHub 알림 확인

**📚 Codex (세션 기록)**
\`!codex\` - 최근 세션 목록
\`!codex save "<제목>"\` - 세션 저장
\`!codex path\` - 저장 경로

**🤖 자율 실행**
\`!auto\` - 자율 실행 상태
\`!auto start [cron] [--pair]\` - 시작 (기본: 30분마다, --pair로 페어 모드)
\`!auto stop\` - 중지
\`!auto run\` - 즉시 heartbeat
\`!approve\` - 작업 승인
\`!reject\` - 작업 거부

**👥 Worker/Reviewer 페어**
\`!pair\` - 페어 세션 상태
\`!pair start [taskId]\` - 페어 세션 시작
\`!pair run <taskId> [project]\` - 직접 페어 실행
\`!pair stop [sessionId]\` - 세션 중지
\`!pair history [n]\` - 히스토리 조회

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
    ci_recovered: '🟢',
    github_notification: '📬',
    commit: '📝',
    error: '🔥',
    pr_improved: '🔧',
    pr_failed: '💔',
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

// ============================================
// VEGA 대화 기능
// ============================================

/**
 * 일반 대화 처리 (OpenClaw-style history management)
 */
async function handleChat(msg: Message): Promise<void> {
  const content = msg.content.trim();
  if (!content) return;

  console.log(`[VEGA] Chat from ${msg.author.username}: ${content.slice(0, 50)}...`);

  const channel = msg.channel as TextChannel;
  const channelId = msg.channel.id;

  // typing 표시 (8초마다 갱신)
  let typingInterval: NodeJS.Timeout | null = null;
  if ('sendTyping' in channel) {
    channel.sendTyping();
    typingInterval = setInterval(() => channel.sendTyping(), 8000);
  }

  // 현재 메시지를 히스토리에 추가 (응답은 나중에 업데이트)
  appendHistoryEntry(channelId, {
    sender: msg.author.username,
    senderId: msg.author.id,
    body: content,
    timestamp: Date.now(),
    messageId: msg.id,
  });

  try {
    // 0. 프로젝트 경로 감지 (메시지 + 히스토리에서 힌트 추출)
    const historyMessages = channelHistoryMap.get(channelId) ?? [];
    const allMessages = historyMessages.map(h => h.body).join(' ') + ' ' + content;
    const projectHints = extractProjectHints(allMessages);
    const projectPath = await resolveProjectPath(projectHints);

    if (projectPath) {
      console.log(`[VEGA] Project detected: ${projectPath}`);
    }

    // 1. 채널 히스토리 컨텍스트 구성 (OpenClaw 스타일 - 전체 내용, 잘림 없음)
    const currentMessageFormatted = `[${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}] ${msg.author.username}: ${content}`;
    const historyContext = buildHistoryContext(channelId, currentMessageFormatted);

    // 2. 시맨틱 검색 (장기 기억 - Retrieval Gate 적용)
    const memories = await memory.searchMemory(content, {
      limit: 5,
      minSimilarity: 0.4,
      minTrust: 0.5,
    });
    const memoryContext = memory.formatMemoryContext(memories);

    // 3. 프롬프트 구성 (시스템 프롬프트 + 프로젝트 컨텍스트 + 대화 히스토리 + 장기 기억)
    let prompt = VEGA_SYSTEM_PROMPT;

    // 프로젝트 컨텍스트 추가 (감지된 경우)
    if (projectPath) {
      prompt += `\n\n## 프로젝트 컨텍스트\n- **작업 디렉토리**: ${projectPath}\n- 이 프로젝트의 코드베이스에서 작업 중입니다.`;
    }

    // 대화 히스토리 추가 (OpenClaw 스타일)
    prompt += `\n\n## 대화 컨텍스트\n${historyContext}`;

    // 장기 기억 추가 (있으면)
    if (memoryContext) {
      prompt += `\n\n${memoryContext}`;
    }

    console.log(`[VEGA] History context: ${channelHistoryMap.get(channelId)?.length ?? 0} messages`);

    // Claude CLI 실행 (프로젝트 경로에서 실행)
    const { result: response, toolCalls } = await runClaude(prompt, { cwd: projectPath || undefined });

    // typing 중지
    if (typingInterval) clearInterval(typingInterval);

    // 히스토리에 응답 업데이트
    updateLastHistoryResponse(channelId, response);

    // 도구 호출 내역 표시 (있으면)
    if (toolCalls.length > 0) {
      const toolSummary = toolCalls.slice(0, 10).map(t => `• ${t}`).join('\n');
      const toolMsg = `🔧 **도구 호출 (${toolCalls.length}개)**\n${toolSummary}${toolCalls.length > 10 ? `\n... +${toolCalls.length - 10}개 더` : ''}`;
      await msg.reply(toolMsg);
    }

    // 응답 전송 (2000자 제한)
    const chunks = splitMessage(response, 2000);
    for (const chunk of chunks) {
      await msg.reply(chunk);
    }

    // 파일 기반 대화 내역 저장 (백업용)
    await saveChatHistory({
      timestamp: new Date().toISOString(),
      user: msg.author.username,
      userId: msg.author.id,
      message: content,
      response: response,
    });

    // 장기 메모리에도 저장 (시맨틱 검색용)
    await memory.saveConversation(channelId, msg.author.id, msg.author.username, content, response);
    console.log(`[VEGA] Response sent (${response.length} chars)`);

  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    console.error('[VEGA] Error:', err);
    await msg.reply('오류가 발생했습니다. 다시 시도해주세요.');
  }
}

// 현재 실행 중인 VEGA Claude 프로세스
let currentVegaProcess: ReturnType<typeof spawn> | null = null;

/**
 * Claude CLI 실행 (코드 실행 가능, 도구 호출 추적)
 * @param prompt - 프롬프트 내용
 * @param options - 실행 옵션 (cwd: 작업 디렉토리)
 */
async function runClaude(
  prompt: string,
  options?: { cwd?: string }
): Promise<{ result: string; toolCalls: string[] }> {
  // 기존 프로세스가 있으면 종료
  if (currentVegaProcess) {
    console.log('[Claude CLI] Killing previous process...');
    currentVegaProcess.kill('SIGKILL');
    currentVegaProcess = null;
  }

  // 프롬프트를 임시 파일에 저장
  const promptFile = '/tmp/vega-prompt.txt';
  await fs.writeFile(promptFile, prompt);

  // 작업 디렉토리 결정 (옵션 > 현재 디렉토리)
  const workingDir = options?.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    // VEGA가 코드 실행 가능 (타임아웃 없음, 새 메시지 오면 이전 작업 취소)
    const cmd = `echo "" | claude -p "$(cat ${promptFile})" --output-format json --permission-mode bypassPermissions`;

    console.log(`[Claude CLI] Starting in ${workingDir}...`);
    const proc = spawn(cmd, {
      shell: true,
      cwd: workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    currentVegaProcess = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      currentVegaProcess = null;
      if (code !== 0 && code !== null) {
        console.error('[Claude CLI] Error:', stderr.slice(0, 200));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(parseClaudeJson(stdout));
    });

    proc.on('error', (err) => {
      currentVegaProcess = null;
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });

    // 타임아웃 없음 - 완료될 때까지 대기
  });
}

// 파괴적 명령 패턴
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[rf]+\s+)*.*(-[rf]+|--recursive|--force)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[fd])/i,
  /\b(drop|truncate)\s+(database|table)/i,
  /\bchmod\s+777/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
];

/**
 * Claude JSON 출력 파싱 (도구 호출 내역 포함)
 */
function parseClaudeJson(output: string): { result: string; toolCalls: string[] } {
  const toolCalls: string[] = [];

  try {
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) return { result: output.trim() || '(응답 없음)', toolCalls };

    const arr = JSON.parse(match[0]);
    let result = '(응답 없음)';

    for (const item of arr) {
      // 도구 호출 추적
      if (item.type === 'tool_use') {
        const toolName = item.name || 'unknown';
        let toolSummary = toolName;

        // Bash 명령이면 명령어 표시 + 파괴적 명령 체크
        if (toolName === 'Bash' && item.input?.command) {
          const cmd = item.input.command.slice(0, 80);
          toolSummary = `Bash: \`${cmd}${item.input.command.length > 80 ? '...' : ''}\``;

          // 파괴적 명령 감지
          for (const pattern of DESTRUCTIVE_PATTERNS) {
            if (pattern.test(item.input.command)) {
              toolSummary = `⛔ BLOCKED: ${cmd}`;
              console.warn(`[VEGA] Destructive command detected: ${item.input.command}`);
              break;
            }
          }
        }
        // 파일 작업이면 경로 표시
        else if (['Read', 'Write', 'Edit'].includes(toolName) && item.input?.file_path) {
          const path = item.input.file_path.split('/').slice(-2).join('/');
          toolSummary = `${toolName}: \`${path}\``;
        }
        // Grep이면 패턴 표시
        else if (toolName === 'Grep' && item.input?.pattern) {
          toolSummary = `Grep: \`${item.input.pattern}\``;
        }

        toolCalls.push(toolSummary);
      }

      // 최종 결과 추출
      if (item.type === 'result' && item.result) {
        result = item.result;
      }
    }

    return { result, toolCalls };
  } catch {
    return { result: output.trim() || '(응답 없음)', toolCalls };
  }
}
/**
 * 메시지 분할
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * 대화 내역 저장
 */
async function saveChatHistory(entry: ChatEntry): Promise<void> {
  try {
    let history: ChatEntry[] = [];
    try {
      const data = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
      history = JSON.parse(data);
    } catch {
      // 파일이 없으면 빈 배열
    }

    history.push(entry);

    // 최근 100개만 유지
    if (history.length > 100) {
      history = history.slice(-100);
    }

    await fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[VEGA] Failed to save chat history:', err);
  }
}

/**
 * 대화 내역 조회 (웹 API용)
 */
export async function getChatHistory(): Promise<ChatEntry[]> {
  try {
    const data = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// ============================================
// Worker/Reviewer 페어 시스템
// ============================================

/**
 * !pair 명령어 핸들러
 */
async function handlePair(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !pair 또는 !pair status - 현재 상태
  if (!subCommand || subCommand === 'status') {
    await handlePairStatus(msg);
    return;
  }

  // !pair start [taskId] - 페어 세션 시작
  if (subCommand === 'start') {
    const taskId = args[1];
    await handlePairStart(msg, taskId);
    return;
  }

  // !pair stop [sessionId] - 페어 세션 중지
  if (subCommand === 'stop') {
    const sessionId = args[1];
    await handlePairStop(msg, sessionId);
    return;
  }

  // !pair history [n] - 히스토리 조회
  if (subCommand === 'history') {
    const limit = parseInt(args[1]) || 5;
    await handlePairHistory(msg, limit);
    return;
  }

  // !pair run <taskId> <project> - 직접 페어 실행
  if (subCommand === 'run') {
    const taskId = args[1];
    const project = args[2] || '~/dev';
    await handlePairRun(msg, taskId, project);
    return;
  }

  // !pair stats - 통계 조회
  if (subCommand === 'stats') {
    await handlePairStats(msg);
    return;
  }

  // 도움말
  await msg.reply(
    '**👥 Worker/Reviewer 페어 명령어:**\n' +
    '`!pair` - 현재 페어 세션 상태\n' +
    '`!pair start [taskId]` - 페어 세션 시작\n' +
    '`!pair run <taskId> [project]` - 직접 페어 실행\n' +
    '`!pair stop [sessionId]` - 세션 중지\n' +
    '`!pair history [n]` - 최근 n개 히스토리\n' +
    '`!pair stats` - 통계 조회'
  );
}

/**
 * !pair stats - 통계 조회
 */
async function handlePairStats(msg: Message): Promise<void> {
  try {
    const summary = await pairMetrics.getSummary();
    const daily = await pairMetrics.getDailyMetrics(7);

    const embed = new EmbedBuilder()
      .setTitle('📊 페어 모드 통계')
      .setColor(0x5865F2)
      .setTimestamp();

    // 전체 요약
    embed.addFields(
      {
        name: '📈 전체 통계',
        value: [
          `**총 세션:** ${summary.totalSessions}개`,
          `**성공률:** ${summary.successRate}%`,
          `**첫 시도 성공률:** ${summary.firstAttemptSuccessRate}%`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📋 결과 분포',
        value: [
          `✅ 승인: ${summary.approved}`,
          `❌ 거부: ${summary.rejected}`,
          `💥 실패: ${summary.failed}`,
          `🚫 취소: ${summary.cancelled}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⏱️ 평균 지표',
        value: [
          `**시도 횟수:** ${summary.avgAttempts}회`,
          `**소요 시간:** ${formatDuration(summary.avgDurationMs)}`,
          `**변경 파일:** ${summary.avgFilesChanged}개`,
        ].join('\n'),
        inline: true,
      }
    );

    // 일별 통계
    if (daily.length > 0) {
      const dailyLines = daily.map(d => {
        const rate = d.sessions > 0 ? Math.round((d.approved / d.sessions) * 100) : 0;
        return `**${d.date}**: ${d.sessions}개 (✅${d.approved} ❌${d.rejected} 💥${d.failed}) ${rate}%`;
      });

      embed.addFields({
        name: '📅 일별 통계 (최근 7일)',
        value: dailyLines.join('\n') || '(데이터 없음)',
        inline: false,
      });
    }

    await msg.reply({ embeds: [embed] });
  } catch (err) {
    await msg.reply(`❌ 통계 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 시간 포맷팅 (ms → 읽기 쉬운 형식)
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}분`;
  return `${Math.round(ms / 3600000)}시간`;
}

/**
 * !pair status - 현재 페어 세션 상태
 */
async function handlePairStatus(msg: Message): Promise<void> {
  const sessions = agentPair.getActiveSessions();

  if (sessions.length === 0) {
    await msg.reply('👥 활성 페어 세션이 없습니다.\n`!pair start` 로 시작하세요.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('👥 활성 페어 세션')
    .setColor(0x00AE86)
    .setTimestamp();

  for (const session of sessions) {
    embed.addFields({
      name: `${session.id}: ${session.taskTitle.slice(0, 50)}`,
      value: agentPair.formatSessionSummary(session),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !pair start [taskId] - 페어 세션 시작
 */
async function handlePairStart(msg: Message, taskId?: string): Promise<void> {
  // Linear에서 작업 가져오기
  let task: any = null;

  if (taskId) {
    // 특정 이슈 조회
    try {
      task = await linear.getIssue(taskId);
    } catch {
      await msg.reply(`❌ 이슈를 찾을 수 없습니다: \`${taskId}\``);
      return;
    }
  } else {
    // 첫 번째 대기 중 이슈 선택
    try {
      const issues = await linear.getMyIssues();
      if (issues.length === 0) {
        await msg.reply('❌ 대기 중인 이슈가 없습니다.');
        return;
      }
      task = issues[0];
    } catch (err) {
      await msg.reply(`❌ Linear 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // 프로젝트 경로 결정
  const projectPath = task.project?.name
    ? dev.resolveRepoPath(task.project.name) || '~/dev'
    : '~/dev';

  await startPairSession(msg, {
    taskId: task.identifier || task.id,
    taskTitle: task.title,
    taskDescription: task.description || '',
    projectPath,
  });
}

/**
 * !pair run <taskId> [project] - 직접 페어 실행
 */
async function handlePairRun(msg: Message, taskId: string, project: string): Promise<void> {
  if (!taskId) {
    await msg.reply('사용법: `!pair run <taskId> [project]`');
    return;
  }

  // 프로젝트 경로 확인
  const projectPath = dev.resolveRepoPath(project) || project;

  // Linear에서 이슈 정보 가져오기
  let taskTitle = taskId;
  let taskDescription = '';

  try {
    const issue = await linear.getIssue(taskId);
    if (issue) {
      taskTitle = issue.title;
      taskDescription = issue.description || '';
    }
  } catch {
    // Linear 조회 실패해도 계속 진행 (taskId를 제목으로 사용)
  }

  await startPairSession(msg, {
    taskId,
    taskTitle,
    taskDescription,
    projectPath,
  });
}

/**
 * 페어 세션 시작 및 실행
 */
async function startPairSession(
  msg: Message,
  options: agentPair.CreatePairSessionOptions
): Promise<void> {
  const channel = msg.channel as TextChannel;

  // pairModeConfig에서 기본값 적용
  const sessionOptions: agentPair.CreatePairSessionOptions = {
    ...options,
    webhookUrl: options.webhookUrl ?? pairModeConfig?.webhookUrl,
    maxAttempts: options.maxAttempts ?? pairModeConfig?.maxAttempts,
  };

  // 1. 세션 생성
  const session = agentPair.createPairSession(sessionOptions);

  // 2. Discord 스레드 생성
  let thread: ThreadChannel;
  try {
    thread = await channel.threads.create({
      name: `[${session.id}] ${options.taskTitle.slice(0, 50)}`,
      autoArchiveDuration: 1440, // 24시간
      type: ChannelType.PublicThread,
    });

    agentPair.setSessionThreadId(session.id, thread.id);
  } catch (err) {
    await msg.reply(`❌ 스레드 생성 실패: ${err instanceof Error ? err.message : String(err)}`);
    agentPair.cancelSession(session.id);
    return;
  }

  // 3. 시작 메시지
  const startEmbed = new EmbedBuilder()
    .setTitle(`📋 페어 작업 시작: ${options.taskTitle.slice(0, 80)}`)
    .setColor(0x00AE86)
    .addFields(
      { name: 'Session ID', value: session.id, inline: true },
      { name: 'Task', value: options.taskId, inline: true },
      { name: 'Project', value: options.projectPath, inline: true },
    )
    .setTimestamp();

  await thread.send({ embeds: [startEmbed] });
  agentPair.addMessage(session.id, 'system', '페어 세션이 시작되었습니다.');

  // 4. Worker/Reviewer 루프 시작 (비동기)
  runPairLoop(session.id, thread).catch((err) => {
    console.error('[Pair] Loop error:', err);
    thread.send(`❌ 페어 루프 오류: ${err instanceof Error ? err.message : String(err)}`);
    agentPair.updateSessionStatus(session.id, 'failed');
  });

  // 5. 메인 채널에 알림
  await msg.reply(`👥 페어 세션 시작됨: ${thread}`);
}

/**
 * Worker/Reviewer 루프 실행
 */
async function runPairLoop(sessionId: string, thread: ThreadChannel): Promise<void> {
  let session = agentPair.getPairSession(sessionId);
  if (!session) return;

  // Linear에 페어 세션 시작 기록
  try {
    await linear.logPairStart(session.taskId, sessionId, session.projectPath);
  } catch (err) {
    console.error('[Pair] Linear logPairStart failed:', err);
  }

  // 마지막 Worker 결과 저장 (통계용)
  let lastWorkerResult: agentPair.WorkerResult | null = null;

  while (agentPair.canRetry(sessionId)) {
    session = agentPair.getPairSession(sessionId);
    if (!session) break;

    // 취소 체크
    if (session.status === 'cancelled') {
      await thread.send('🚫 세션이 취소되었습니다.');
      return;
    }

    // === Worker 실행 ===
    agentPair.updateSessionStatus(sessionId, 'working');
    await thread.send(`🔨 **[Worker]** 작업 시작... (시도 ${session.worker.attempts + 1}/${session.worker.maxAttempts})`);

    const previousFeedback = session.reviewer.feedback
      ? reviewer.buildRevisionPrompt(session.reviewer.feedback)
      : undefined;

    const workerResult = await worker.runWorker({
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      projectPath: session.projectPath,
      previousFeedback,
      timeoutMs: 300000, // 5분
    });

    lastWorkerResult = workerResult;
    agentPair.saveWorkerResult(sessionId, workerResult);
    await thread.send(worker.formatWorkReport(workerResult));

    // Worker 실패 시 재시도 또는 종료
    if (!workerResult.success) {
      if (!agentPair.canRetry(sessionId)) {
        agentPair.updateSessionStatus(sessionId, 'failed');
        await thread.send('❌ **[System]** 최대 시도 횟수 초과. 작업 실패.');

        // Linear에 실패 기록
        try {
          await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
            `Worker 작업 실패 후 최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
        } catch (err) {
          console.error('[Pair] Linear logPairFailed failed:', err);
        }

        // 최종 요약 전송
        await sendFinalSummary(thread, session, 'failed');
        return;
      }
      continue;
    }

    // === Reviewer 실행 ===
    agentPair.updateSessionStatus(sessionId, 'reviewing');
    await thread.send('🔍 **[Reviewer]** 리뷰 시작...');

    // Linear에 리뷰 시작 기록
    try {
      await linear.logPairReview(session.taskId, sessionId, session.worker.attempts);
    } catch (err) {
      console.error('[Pair] Linear logPairReview failed:', err);
    }

    const reviewResult = await reviewer.runReviewer({
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      workerResult,
      projectPath: session.projectPath,
      timeoutMs: 180000, // 3분
    });

    agentPair.saveReviewerResult(sessionId, reviewResult);
    await thread.send(reviewer.formatReviewFeedback(reviewResult));

    // === 결정 처리 ===
    if (reviewResult.decision === 'approve') {
      agentPair.updateSessionStatus(sessionId, 'approved');
      await thread.send('✅ **[System]** 작업이 승인되었습니다!');

      // Linear에 완료 기록
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

      // 최종 요약 전송
      await sendFinalSummary(thread, session, 'approved');
      return;
    }

    if (reviewResult.decision === 'reject') {
      agentPair.updateSessionStatus(sessionId, 'rejected');
      await thread.send('❌ **[System]** 작업이 거부되었습니다. 수동 개입이 필요합니다.');

      // Linear에 거부 기록
      try {
        await linear.logPairFailed(session.taskId, sessionId, 'rejected',
          `피드백: ${reviewResult.feedback}\n문제점: ${reviewResult.issues?.join(', ') || '없음'}`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      // 최종 요약 전송
      await sendFinalSummary(thread, session, 'rejected');
      return;
    }

    // revise: 다음 루프에서 Worker가 수정
    if (!agentPair.canRetry(sessionId)) {
      agentPair.updateSessionStatus(sessionId, 'failed');
      await thread.send('❌ **[System]** 최대 시도 횟수 초과. 수정 실패.');

      try {
        await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
          `최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      await sendFinalSummary(thread, session, 'failed');
      return;
    }

    // Linear에 수정 요청 기록
    try {
      await linear.logPairRevision(session.taskId, sessionId,
        reviewResult.feedback, reviewResult.issues || []);
    } catch (err) {
      console.error('[Pair] Linear logPairRevision failed:', err);
    }

    agentPair.updateSessionStatus(sessionId, 'revising');
    await thread.send('🔄 **[System]** 수정이 필요합니다. Worker가 재작업합니다...');
  }

  // 최대 시도 초과
  session = agentPair.getPairSession(sessionId);
  if (session) {
    agentPair.updateSessionStatus(sessionId, 'failed');
    await thread.send('❌ **[System]** 최대 시도 횟수 초과. 작업 종료.');

    try {
      await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
        `최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
    } catch (err) {
      console.error('[Pair] Linear logPairFailed failed:', err);
    }

    await sendFinalSummary(thread, session, 'failed');
  }
}

/**
 * 최종 요약 Embed 전송
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
    ? `${duration}초`
    : `${Math.floor(duration / 60)}분 ${duration % 60}초`;

  // 메트릭 기록
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

  // Webhook 알림
  if (session.webhookUrl && pairWebhook.isValidWebhookUrl(session.webhookUrl)) {
    try {
      const webhookFn = {
        approved: pairWebhook.notifyPairApproved,
        rejected: pairWebhook.notifyPairRejected,
        failed: pairWebhook.notifyPairFailed,
        cancelled: pairWebhook.notifyPairCancelled,
      }[result];

      const webhookResult = await webhookFn(session.webhookUrl, session);
      if (!webhookResult.success) {
        console.error('[Pair] Webhook notification failed:', webhookResult.error);
      }
    } catch (err) {
      console.error('[Pair] Webhook notification error:', err);
    }
  }

  // 결과별 색상 및 이모지
  const config = {
    approved: { color: 0x00FF00, emoji: '✅', title: '작업 완료' },
    rejected: { color: 0xFF0000, emoji: '❌', title: '작업 거부됨' },
    failed: { color: 0xFF6600, emoji: '💥', title: '작업 실패' },
    cancelled: { color: 0x808080, emoji: '🚫', title: '작업 취소됨' },
  }[result];

  // 변경된 파일 목록
  const filesChanged = session.worker.result?.filesChanged || [];
  const filesStr = filesChanged.length > 0
    ? filesChanged.slice(0, 10).map(f => `\`${f}\``).join(', ')
    : '없음';

  // 실행된 명령어 (미사용이지만 향후 확장용)
  const _commands = session.worker.result?.commands || [];

  // Embed 생성
  const embed = new EmbedBuilder()
    .setTitle(`${config.emoji} ${config.title}: ${session.taskTitle.slice(0, 60)}`)
    .setColor(config.color)
    .addFields(
      { name: '📊 통계', value: [
        `**시도 횟수:** ${session.worker.attempts}/${session.worker.maxAttempts}`,
        `**소요 시간:** ${durationStr}`,
        `**변경 파일:** ${filesChanged.length}개`,
      ].join('\n'), inline: false },
      { name: '📁 변경된 파일', value: filesStr.slice(0, 1000) || '없음', inline: false },
    )
    .setFooter({ text: `Session: ${session.id} | Task: ${session.taskId}` })
    .setTimestamp();

  // Reviewer 피드백이 있으면 추가
  if (session.reviewer.feedback) {
    const feedback = session.reviewer.feedback;
    const feedbackStr = [
      `**결정:** ${feedback.decision.toUpperCase()}`,
      `**피드백:** ${feedback.feedback.slice(0, 200)}`,
    ].join('\n');
    embed.addFields({ name: '🔍 Reviewer 피드백', value: feedbackStr, inline: false });
  }

  await thread.send({ embeds: [embed] });

  // 토론 요약 (메시지가 있으면)
  if (session.messages.length > 0) {
    const discussionSummary = formatDiscussionSummary(session);
    if (discussionSummary.length <= 2000) {
      await thread.send(`📜 **토론 요약**\n${discussionSummary}`);
    } else {
      // 너무 길면 분할
      await thread.send(`📜 **토론 요약** (${session.messages.length}개 메시지)`);
      await thread.send(`\`\`\`\n${discussionSummary.slice(0, 1900)}\n...\n\`\`\``);
    }
  }
}

/**
 * 토론 요약 포맷
 */
function formatDiscussionSummary(session: agentPair.PairSession): string {
  return session.messages.map((msg, _idx) => {
    const roleEmoji = { worker: '🔨', reviewer: '🔍', system: '⚙️' }[msg.role];
    const time = new Date(msg.timestamp).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const content = msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '');
    return `[${time}] ${roleEmoji} ${msg.role}: ${content}`;
  }).join('\n');
}

/**
 * !pair stop [sessionId] - 페어 세션 중지
 */
async function handlePairStop(msg: Message, sessionId?: string): Promise<void> {
  const sessions = agentPair.getActiveSessions();

  if (sessions.length === 0) {
    await msg.reply('활성 페어 세션이 없습니다.');
    return;
  }

  // sessionId 지정 안 하면 가장 최근 세션
  const targetId = sessionId || sessions[0].id;
  const success = agentPair.cancelSession(targetId);

  if (success) {
    await msg.reply(`🚫 페어 세션 취소됨: \`${targetId}\``);
  } else {
    await msg.reply(`❌ 세션을 찾을 수 없거나 이미 종료됨: \`${targetId}\``);
  }
}

/**
 * !pair history [n] - 히스토리 조회
 */
async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const history = agentPair.getSessionHistory(limit);

  if (history.length === 0) {
    await msg.reply('📚 페어 세션 히스토리가 없습니다.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 페어 세션 히스토리')
    .setColor(0x9b59b6)
    .setTimestamp();

  for (const session of history) {
    embed.addFields({
      name: `${session.id}: ${session.taskTitle.slice(0, 40)}`,
      value: agentPair.formatSessionSummary(session),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * Discord 기본 채널에 메시지 전송 (외부에서 호출용)
 */
export async function sendToChannel(content: string | { embeds: EmbedBuilder[] }): Promise<void> {
  if (!client || !reportChannelId) return;

  try {
    const channel = await client.channels.fetch(reportChannelId) as TextChannel;
    if (!channel) return;

    await channel.send(content);
  } catch (err) {
    console.error('[Discord] Send to channel failed:', err);
  }
}

/**
 * Discord 스레드에 메시지 전송 (외부에서 호출용)
 */
export async function sendToThread(threadId: string, content: string | EmbedBuilder): Promise<void> {
  if (!client) return;

  try {
    const thread = await client.channels.fetch(threadId) as ThreadChannel;
    if (!thread || !thread.isThread()) return;

    if (typeof content === 'string') {
      await thread.send(content);
    } else {
      await thread.send({ embeds: [content] });
    }
  } catch (err) {
    console.error('[Discord] Send to thread failed:', err);
  }
}
