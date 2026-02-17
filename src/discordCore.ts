// ============================================
// Claude Swarm - Discord Bot Core
//
// Entry point, shared state, history, config,
// events, and message routing.
// ============================================

import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
} from 'discord.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { SwarmEvent, AgentStatus } from './types.js';
import * as memory from './memory.js';

// 핸들러 모듈 (라우팅용)
import { handlePair } from './discordPair.js';

export let client: Client | null = null;
export let reportChannelId: string = '';

// 허용된 유저 ID (환경변수에서 로드)
const ALLOWED_USER_IDS = process.env.DISCORD_ALLOWED_USERS?.split(',').map(id => id.trim()) || [];

// ============================================
// OpenClaw-style History Management
// ============================================

// 채널별 히스토리 맵 (메모리 캐시)
export const channelHistoryMap = new Map<string, HistoryEntry[]>();

// 히스토리 설정 (OpenClaw 기본값 참고)
const HISTORY_LIMIT = 30;  // 최근 30개 메시지 (OpenClaw 기본 50개)
const MAX_HISTORY_CHANNELS = 100;  // 최대 채널 수 (LRU eviction)

// 히스토리 엔트리 타입
export interface HistoryEntry {
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
export function appendHistoryEntry(channelId: string, entry: HistoryEntry): void {
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
export function updateLastHistoryResponse(channelId: string, response: string): void {
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
export function buildHistoryContext(channelId: string, currentMessage: string): string {
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

import * as projectMapper from './projectMapper.js';

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
export function extractProjectHints(message: string): string[] {
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
export async function resolveProjectPath(hints: string[]): Promise<string | null> {
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
export const VEGA_SYSTEM_PROMPT = `# VEGA (Vector Encoded General Agent)

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
export interface ChatEntry {
  timestamp: string;
  user: string;
  userId: string;
  message: string;
  response: string;
}

// 콜백 함수들 (service에서 설정)
export let onPauseAgent: ((name: string) => void) | null = null;
export let onResumeAgent: ((name: string) => void) | null = null;
export let getAgentStatus: ((name?: string) => AgentStatus[]) | null = null;
export let getGithubRepos: (() => string[]) | null = null;

// Pair 모드 설정
export let pairModeConfig: {
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

// 핸들러 함수들 import (지연 로드 방지를 위해 함수 내에서 사용)
import {
  handleStatus,
  handleList,
  handleRun,
  handlePause,
  handleResume,
  handleIssues,
  handleLog,
  handleCI,
  handleNotifications,
  handleDev,
  handleRepos,
  handleTasks,
  handleCancel,
  handleLimits,
  handleSchedule,
  handleCodex,
  handleAuto,
  handleApprove,
  handleReject,
} from './discordHandlers.js';

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
export function formatTimeAgo(timestamp: number): string {
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

/**
 * Discord 기본 채널에 메시지 전송 (외부에서 호출용)
 */
export async function sendToChannel(content: string | { embeds: EmbedBuilder[] }): Promise<void> {
  if (!client || !reportChannelId) return;

  try {
    const channel = await client.channels.fetch(reportChannelId) as TextChannel;
    if (!channel) return;

    // 문자열이면 Discord 4000자 제한 준수 (분할 전송)
    if (typeof content === 'string' && content.length > 3900) {
      const chunks = splitForDiscord(content, 3900);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } else {
      await channel.send(content);
    }
  } catch (err) {
    console.error('[Discord] Send to channel failed:', err);
  }
}

function splitForDiscord(text: string, maxLen: number): string[] {
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

// ============================================
// VEGA 대화 기능
// ============================================

// 대화 내역 저장 경로
const CHAT_HISTORY_FILE = '/tmp/claude-swarm-chat-history.json';

/**
 * 일반 대화 처리 (OpenClaw-style history management)
 */
export async function handleChat(msg: Message): Promise<void> {
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

    // 1. 채널 히스토리 컨텍스트 구성
    const currentMessageFormatted = `[${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}] ${msg.author.username}: ${content}`;
    const historyContext = buildHistoryContext(channelId, currentMessageFormatted);

    // 2. 시맨틱 검색 (장기 기억)
    const memories = await memory.searchMemory(content, {
      limit: 5,
      minSimilarity: 0.4,
      minTrust: 0.5,
    });
    const memoryContext = memory.formatMemoryContext(memories);

    // 3. 프롬프트 구성
    let prompt = VEGA_SYSTEM_PROMPT;

    if (projectPath) {
      prompt += `\n\n## 프로젝트 컨텍스트\n- **작업 디렉토리**: ${projectPath}\n- 이 프로젝트의 코드베이스에서 작업 중입니다.`;
    }

    prompt += `\n\n## 대화 컨텍스트\n${historyContext}`;

    if (memoryContext) {
      prompt += `\n\n${memoryContext}`;
    }

    console.log(`[VEGA] History context: ${channelHistoryMap.get(channelId)?.length ?? 0} messages`);

    // Claude CLI 실행
    const { result: response, toolCalls } = await runClaude(prompt, { cwd: projectPath || undefined });

    if (typingInterval) clearInterval(typingInterval);

    updateLastHistoryResponse(channelId, response);

    if (toolCalls.length > 0) {
      const toolSummary = toolCalls.slice(0, 10).map(t => `• ${t}`).join('\n');
      const toolMsg = `🔧 **도구 호출 (${toolCalls.length}개)**\n${toolSummary}${toolCalls.length > 10 ? `\n... +${toolCalls.length - 10}개 더` : ''}`;
      await msg.reply(toolMsg);
    }

    const chunks = splitMessage(response, 2000);
    for (const chunk of chunks) {
      await msg.reply(chunk);
    }

    await saveChatHistory({
      timestamp: new Date().toISOString(),
      user: msg.author.username,
      userId: msg.author.id,
      message: content,
      response: response,
    });

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
 * Claude CLI 실행
 */
async function runClaude(
  prompt: string,
  options?: { cwd?: string }
): Promise<{ result: string; toolCalls: string[] }> {
  if (currentVegaProcess) {
    console.log('[Claude CLI] Killing previous process...');
    currentVegaProcess.kill('SIGKILL');
    currentVegaProcess = null;
  }

  const promptFile = '/tmp/vega-prompt.txt';
  await fs.writeFile(promptFile, prompt);

  const workingDir = options?.cwd || process.cwd();

  return new Promise((resolve, reject) => {
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
 * Claude JSON 출력 파싱
 */
function parseClaudeJson(output: string): { result: string; toolCalls: string[] } {
  const toolCalls: string[] = [];

  try {
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) return { result: output.trim() || '(응답 없음)', toolCalls };

    const arr = JSON.parse(match[0]);
    let result = '(응답 없음)';

    for (const item of arr) {
      if (item.type === 'tool_use') {
        const toolName = item.name || 'unknown';
        let toolSummary = toolName;

        if (toolName === 'Bash' && item.input?.command) {
          const cmd = item.input.command.slice(0, 80);
          toolSummary = `Bash: \`${cmd}${item.input.command.length > 80 ? '...' : ''}\``;

          for (const pattern of DESTRUCTIVE_PATTERNS) {
            if (pattern.test(item.input.command)) {
              toolSummary = `⛔ BLOCKED: ${cmd}`;
              console.warn(`[VEGA] Destructive command detected: ${item.input.command}`);
              break;
            }
          }
        } else if (['Read', 'Write', 'Edit'].includes(toolName) && item.input?.file_path) {
          const path = item.input.file_path.split('/').slice(-2).join('/');
          toolSummary = `${toolName}: \`${path}\``;
        } else if (toolName === 'Grep' && item.input?.pattern) {
          toolSummary = `Grep: \`${item.input.pattern}\``;
        }

        toolCalls.push(toolSummary);
      }

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

