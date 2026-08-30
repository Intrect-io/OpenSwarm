// ============================================
// OpenSwarm - Discord Bot Core
//
// Entry point, shared state, history, config,
// events, and message routing.

import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
} from 'discord.js';
import fs from 'node:fs/promises';
import { correlationIdFromHint } from '../coordination/answerHint.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SwarmEvent, AgentStatus } from '../core/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import * as memory from '../memory/index.js';
import { t, getPrompts, getDateLocale } from '../locale/index.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

// Handler module (for routing)
import { handlePair } from './discordPair.js';

export let client: Client | null = null;
export let reportChannelId: string = '';

// Allowed user IDs (loaded from environment variables)
const ALLOWED_USER_IDS = process.env.DISCORD_ALLOWED_USERS?.split(',').map(id => id.trim()) || [];

// OpenClaw-style History Management

// Per-channel history map (in-memory cache)
export const channelHistoryMap = new Map<string, HistoryEntry[]>();

// History settings (based on OpenClaw defaults)
const HISTORY_LIMIT = 30;  // Last 30 messages (OpenClaw default: 50)
const MAX_HISTORY_CHANNELS = 100;  // Max channel count (LRU eviction)

// History entry type
export interface HistoryEntry {
  sender: string;
  senderId: string;
  body: string;
  response?: string;
  timestamp: number;
  messageId?: string;
}

// Context markers (OpenClaw style)
const HISTORY_CONTEXT_MARKER = '[Chat messages since your last reply - for context]';
const CURRENT_MESSAGE_MARKER = '[Current message]';

/**
 * Evict old channel history entries using LRU
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
 * Append history entry
 */
export function appendHistoryEntry(channelId: string, entry: HistoryEntry): void {
  const history = channelHistoryMap.get(channelId) ?? [];
  history.push(entry);

  // Maintain max count
  while (history.length > HISTORY_LIMIT) {
    history.shift();
  }

  // LRU: delete existing key and re-insert (refresh order)
  if (channelHistoryMap.has(channelId)) {
    channelHistoryMap.delete(channelId);
  }
  channelHistoryMap.set(channelId, history);

  evictOldHistoryChannels();
}

/**
 * Attach a response to the history entry it answers.
 *
 * Matched by messageId, not by position. Two messages in one channel are
 * handled concurrently, and the model does not finish them in arrival order —
 * writing to the last entry meant whichever finished first overwrote the newer
 * message's entry, so the newer message's own reply was lost and the older one
 * showed an answer to a question nobody asked.
 *
 * The positional fallback covers entries recorded without a messageId, which is
 * the pre-existing behaviour for those and is safe when nothing else is in
 * flight.
 */
export function updateHistoryResponse(channelId: string, messageId: string | undefined, response: string): void {
  const history = channelHistoryMap.get(channelId);
  if (!history || history.length === 0) return;

  if (messageId) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].messageId === messageId) {
        history[i].response = response;
        return;
      }
    }
    // The entry aged out of the ring buffer while the model was running.
    // Writing to whatever is last now would attach it to an unrelated message.
    return;
  }

  history[history.length - 1].response = response;
}

/**
 * Format history entry (OpenClaw envelope style)
 */
function formatHistoryEntry(entry: HistoryEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString(getDateLocale(), {
    hour: '2-digit',
    minute: '2-digit'
  });

  let formatted = `[${time}] ${entry.sender}: ${entry.body}`;

  if (entry.response) {
    // Include full response (no truncation)
    formatted += `\n[${time}] OpenSwarm: ${entry.response}`;
  }

  return formatted;
}

/**
 * Build channel history as context (OpenClaw style)
 */
export function buildHistoryContext(channelId: string, currentMessage: string): string {
  const history = channelHistoryMap.get(channelId) ?? [];

  if (history.length === 0) {
    return currentMessage;
  }

  // Exclude last entry (prevent duplication with current message)
  const pastEntries = history.slice(0, -1);

  if (pastEntries.length === 0) {
    return currentMessage;
  }

  const historyText = pastEntries.map(formatHistoryEntry).join('\n\n');

  return `${HISTORY_CONTEXT_MARKER}\n${historyText}\n\n${CURRENT_MESSAGE_MARKER}\n${currentMessage}`;
}

// Project Context Detection

import * as projectMapper from '../support/projectMapper.js';

// Default project scan paths
const PROJECT_BASE_PATHS = ['~/dev', '~/dev/tools', '~/projects'];

// Project name patterns (Linear issue IDs, project names, etc.)
const PROJECT_PATTERNS = [
  // Extract project from Linear issue ID (e.g., INT-123, STONKS-456)
  /\b([A-Z]{2,10})-\d+\b/g,
  // Explicit project mentions
  /\b(STONKS|VELA|PyKIS|pykis|pykiwoom|HIVE|OpenSwarm)\b/gi,
  // "~~ project" pattern (Korean)
  /(\w+)\s*프로젝트/gi,
];

// Issue prefix → project name mapping (based on Linear issue IDs)
const ISSUE_PREFIX_MAP: Record<string, string> = {
  'INT': 'OpenSwarm',  // HIVE project
  'STONKS': 'STONKS',
  'VELA': 'VELA',
  'PYKIS': 'pykis',
  'PKW': 'pykiwoom',
  'SA': 'STONKS',  // STONKS-SaaS
};

/**
 * Extract project hints from message
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
 * Resolve local path from project hints
 */
export async function resolveProjectPath(hints: string[]): Promise<string | null> {
  if (hints.length === 0) return null;

  // Scan local projects
  const localProjects = await projectMapper.scanLocalProjects(PROJECT_BASE_PATHS);

  for (const hint of hints) {
    // 1. Check issue prefix mapping
    const mappedName = ISSUE_PREFIX_MAP[hint];
    if (mappedName) {
      const match = projectMapper.findBestMatch(mappedName, localProjects);
      if (match && match.confidence >= 0.7) {
        console.log(`[ProjectContext] Resolved via prefix: ${hint} → ${match.project.path}`);
        return match.project.path;
      }
    }

    // 2. Try direct matching
    const match = projectMapper.findBestMatch(hint, localProjects);
    if (match && match.confidence >= 0.6) {
      console.log(`[ProjectContext] Resolved: ${hint} → ${match.project.path}`);
      return match.project.path;
    }
  }

  return null;
}

// OpenSwarm system prompt - loaded from locale
export function getSystemPrompt(): string {
  return getPrompts().systemPrompt;
}

// Chat history type
export interface ChatEntry {
  timestamp: string;
  user: string;
  userId: string;
  message: string;
  response: string;
}

// Callback functions (set from service)
export let onPauseAgent: ((name: string) => void) | null = null;
export let onResumeAgent: ((name: string) => void) | null = null;
export let getAgentStatus: ((name?: string) => AgentStatus[]) | null = null;
export let getGithubRepos: (() => string[]) | null = null;

// Pair mode configuration
export let pairModeConfig: {
  webhookUrl?: string;
  maxAttempts?: number;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
} | null = null;

/**
 * Set pair mode configuration
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
 * Set callback functions
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
 * Initialize and start Discord bot
 */
export async function initDiscord(token: string, channelId: string): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) {
    await stopDiscord();
    reportChannelId = '';
    return;
  }
  reportChannelId = channelId;

  // Reconfiguration/restart must not leave the old websocket client alive.
  if (client) {
    await client.destroy();
    client = null;
  }

  const nextClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  nextClient.once(Events.ClientReady, () => {
    console.log(`Discord bot logged in as ${nextClient.user?.tag}`);
  });

  nextClient.on('messageCreate', handleMessage);

  try {
    await nextClient.login(token);
    client = nextClient;
  } catch (error) {
    await nextClient.destroy().catch(() => {});
    throw error;
  }
}

// Handler function imports (used within functions to prevent lazy load issues)
import {
  handleStatus,
  handleList,
  handleRun,
  handlePause,
  handleResume,
  handleIssues,
  handleIssue,
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
 * The correlation id a posted question carries, or undefined if this is not one
 * of our question messages.
 *
 * The link between a reply and the question it answers lives in the message
 * Discord already stores — the `!answer <id>` line we posted — rather than in a
 * map this process keeps. That matters because a parked question routinely
 * outlives the daemon: it is asked twice, parked, and answered hours later,
 * possibly after a restart, and an in-memory map would have lost it.
 *
 * Only OUR OWN messages are read for this. Otherwise an operator could reply to
 * any message that happens to contain the text `!answer <id>` — including one
 * they wrote themselves — and answer a question through a route that never
 * passed the allowed-user check on the question itself.
 */
export function questionCorrelationIdFrom(
  referenced: { author?: { id?: string } | null; content?: string } | null,
  botUserId: string | undefined,
): string | undefined {
  if (!referenced || !botUserId) return undefined;
  if (referenced.author?.id !== botUserId) return undefined;
  return correlationIdFromHint(referenced.content ?? undefined);
}

/** Returns true when the reply was handled as an answer — handled including
 * "we told the operator why it was not accepted", since falling through to the
 * chat handler after that would answer their reply twice. */
async function tryAnswerByReply(msg: Message): Promise<boolean> {
  if (!msg.reference?.messageId) return false;
  const referenced = await msg.fetchReference().catch(() => null);
  const correlationId = questionCorrelationIdFrom(referenced, client?.user?.id);
  if (!correlationId) return false;

  const answer = msg.content.trim();
  if (!answer) return false;
  const { answerHumanQuestion } = await import('../coordination/humanQuestions.js');
  const result = await answerHumanQuestion(correlationId, answer, `discord:${msg.author.id}`);
  await msg.reply(result.accepted
    ? `Answer accepted for ${correlationId}.`
    : `Answer not accepted: ${result.reason}`);
  return true;
}

/**
 * Message handler
 */
async function handleMessage(msg: Message): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) return;
  if (msg.author.bot) return;

  // A reply to a question we posted answers that question.
  //
  // Replying is the obvious gesture, and until now it silently was not an
  // answer: the message did not start with `!`, so it fell through to
  // handleChat and the asking agent never saw it. Operators were expected to
  // copy a correlation id by hand into `!answer <id> <text>`, and 28 runs sat
  // parked on questions that had in fact been replied to. (AGT-4070)
  if (ALLOWED_USER_IDS.length > 0
      && ALLOWED_USER_IDS.includes(msg.author.id)
      && !msg.content.startsWith('!')
      && await tryAnswerByReply(msg)) {
    return;
  }

  // Respond to regular messages from allowed users (excluding ! commands)
  if (ALLOWED_USER_IDS.length > 0 &&
      ALLOWED_USER_IDS.includes(msg.author.id) &&
      !msg.content.startsWith('!')) {
    await handleChat(msg);
    return;
  }

  if (!msg.content.startsWith('!')) return;

  // Access control: fail-closed (deny if no allowed users configured)
  if (ALLOWED_USER_IDS.length === 0) {
    await msg.reply('⛔ Access denied: DISCORD_ALLOWED_USERS not configured.');
    return;
  }
  if (!ALLOWED_USER_IDS.includes(msg.author.id)) {
    await msg.reply('⛔ Access denied: unauthorized user.');
    return;
  }

  const [command, ...args] = msg.content.slice(1).split(' ');

  try {
    switch (command) {
      case 'answer': {
        const correlationId = args.shift();
        const answer = args.join(' ').trim();
        if (!correlationId || !answer) {
          await msg.reply('Usage: !answer <correlation-id> <answer>');
          break;
        }
        const { answerHumanQuestion } = await import('../coordination/humanQuestions.js');
        const result = await answerHumanQuestion(correlationId, answer, `discord:${msg.author.id}`);
        await msg.reply(result.accepted ? `Answer accepted for ${correlationId}.` : `Answer not accepted: ${result.reason}`);
        break;
      }
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

      case 'issue':
        await handleIssue(msg, args[0]);
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
        await msg.reply(t('discord.errors.unknownCommand', { command }));
    }
  } catch (err) {
    console.error('Command error:', err);
    await msg.reply(t('discord.errors.commandError', { error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * !help - Show help
 */
async function handleHelp(msg: Message): Promise<void> {
  await msg.reply(t('discord.help'));
}

/**
 * Report event to Discord
 */
export async function reportEvent(event: SwarmEvent): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) return;
  if (!client) return;

  let channel: TextChannel | null = null;
  try {
    const fetched = await client.channels.fetch(reportChannelId);
    if (!fetched || !(fetched instanceof TextChannel)) return;
    channel = fetched;
  } catch (err) {
    console.error('[Discord] Report event channel fetch failed:', err);
    return;
  }

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
    pr_conflict_detected: '⚡',
    pr_conflict_resolving: '🔄',
    pr_conflict_resolved: '✅',
    pr_conflict_failed: '💥',
  }[event.type] ?? '📢';

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} [${event.session}] ${event.type.replace(/_/g, ' ')}`)
    .setDescription(clampDiscordText(event.message, 4096))
    .setColor(event.type.includes('failed') || event.type === 'error' ? 0xff0000 : 0x00ae86)
    .setTimestamp(event.timestamp);

  if (event.issueId) {
    embed.addFields({ name: 'Issue', value: event.issueId });
  }

  if (event.url) {
    embed.setURL(event.url);
  }

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Discord] Report event send failed:', err);
  }
}

/**
 * Format time (relative)
 */
export function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return t('common.timeAgo.hoursAgo', { n: hours });
  if (minutes > 0) return t('common.timeAgo.minutesAgo', { n: minutes });
  return t('common.timeAgo.justNow');
}

export function clampDiscordText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return '…'.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

export function startTypingIndicator(
  channel: { sendTyping: () => Promise<unknown> },
  intervalMs = 8_000,
): NodeJS.Timeout {
  if (isHumanSurfaceReadOnlyEnabled()) {
    const timer = setTimeout(() => {}, 0);
    timer.unref?.();
    return timer;
  }
  const send = () => {
    void channel.sendTyping().catch((error) => {
      console.warn('[Discord] Typing indicator failed:', error instanceof Error ? error.message : String(error));
    });
  };
  send();
  const timer = setInterval(send, intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Stop Discord bot
 */
export async function stopDiscord(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
  }
}

/**
 * Whether an outbound Discord channel is actually available.
 *
 * `sendToChannel` returns silently when Discord is unconfigured, so callers that
 * must report delivery honestly — an agent asking the operator a blocking
 * question, for one — check here first rather than assuming the send landed.
 */
export function hasDiscordChannel(): boolean {
  return !isHumanSurfaceReadOnlyEnabled() && Boolean(client && reportChannelId);
}

/**
 * Send message to default Discord channel (for external callers)
 */
export async function sendToChannel(content: string | { embeds: EmbedBuilder[] }): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) return;
  if (!client || !reportChannelId) return;

  try {
    const channel = await client.channels.fetch(reportChannelId) as TextChannel;
    if (!channel) return;

    if (typeof content === 'string' && content.length > DISCORD_MESSAGE_CHUNK) {
      for (const chunk of chunkForDiscord(content, DISCORD_MESSAGE_CHUNK)) {
        await channel.send(chunk);
      }
    } else {
      await channel.send(content);
    }
  } catch (err) {
    console.error('[Discord] Send to channel failed:', err);
  }
}

/**
 * Chunk size for Discord message content.
 *
 * Discord's hard limit on message content is 2000 characters. 4096 is the
 * embed *description* limit and does not apply here — conflating the two is how
 * sendToChannel came to split at 3900, which produced chunks the API rejected
 * outright, so every long report failed to send rather than arriving in pieces.
 * Anything between 2001 and 3900 was not split at all and failed the same way.
 * The margin below 2000 leaves room for the code fences callers wrap around
 * chunks.
 */
const DISCORD_MESSAGE_CHUNK = 1900;

/**
 * splitForDiscord at the chunk size production actually uses.
 *
 * Exported for tests so they assert the deployed pairing of splitter and limit
 * rather than re-stating the number, which is what let the 3900 mismatch sit
 * unnoticed.
 */
/**
 * Split a long message for Discord, keeping any answer hint on every chunk.
 *
 * The hint is appended last, so plain splitting leaves it on the final chunk
 * only — and an operator replying to the chunk that actually shows the QUESTION
 * would be replying to a message carrying no correlation id, which silently
 * does not answer it. Repeating it costs a line per chunk and makes every piece
 * of the question a valid thing to reply to. (Caught by the commit-gate review.)
 *
 * Messages that carry no hint are split exactly as before.
 */
export function chunkForDiscord(content: string, maxLen: number): string[] {
  const lines = content.split('\n');
  const hint = correlationIdFromHint(lines[lines.length - 1]) ? lines[lines.length - 1] : undefined;
  if (hint === undefined) return splitForDiscord(content, maxLen);
  const body = lines.slice(0, -1).join('\n').trimEnd();
  const chunks = splitForDiscord(body, Math.max(1, maxLen - hint.length - 2));
  return chunks.map((chunk) => `${chunk}\n\n${hint}`);
}

export function splitForDiscordForTest(text: string): string[] {
  return splitForDiscord(text, DISCORD_MESSAGE_CHUNK);
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
 * Send message to Discord thread (for external callers)
 */
export async function sendToThread(threadId: string, content: string | EmbedBuilder): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) return;
  if (!client) return;

  try {
    const thread = await client.channels.fetch(threadId) as ThreadChannel;
    if (!thread || !thread.isThread()) return;

    if (typeof content === 'string') {
      const chunks = content.length > DISCORD_MESSAGE_CHUNK ? splitForDiscord(content, DISCORD_MESSAGE_CHUNK) : [content];
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    } else {
      await thread.send({ embeds: [content] });
    }
  } catch (err) {
    console.error('[Discord] Send to thread failed:', err);
  }
}

// OpenSwarm Chat Feature

// Chat history storage path
export function getChatHistoryFile(): string {
  return process.env.OPENSWARM_CHAT_HISTORY_FILE ?? join(homedir(), '.openswarm', 'chat-history.json');
}
let chatHistoryWriteQueue: Promise<void> = Promise.resolve();

/**
 * Handle general chat (OpenClaw-style history management)
 */
export async function handleChat(msg: Message): Promise<void> {
  const content = msg.content.trim();
  if (!content) return;

  console.log(`[OpenSwarm] Chat from ${msg.author.username}: ${content.slice(0, 50)}...`);

  const channel = msg.channel as TextChannel;
  const channelId = msg.channel.id;

  // Show typing indicator (refresh every 8 seconds)
  let typingInterval: NodeJS.Timeout | null = null;
  if ('sendTyping' in channel) {
    typingInterval = startTypingIndicator(channel);
  }

  // Add current message to history (response updated later)
  appendHistoryEntry(channelId, {
    sender: msg.author.username,
    senderId: msg.author.id,
    body: content,
    timestamp: Date.now(),
    messageId: msg.id,
  });

  try {
    // 0. Detect project path (extract hints from message + history)
    const historyMessages = channelHistoryMap.get(channelId) ?? [];
    const allMessages = historyMessages.map(h => h.body).join(' ') + ' ' + content;
    const projectHints = extractProjectHints(allMessages);
    const projectPath = await resolveProjectPath(projectHints);

    if (projectPath) {
      console.log(`[OpenSwarm] Project detected: ${projectPath}`);
    }

    // 1. Build channel history context
    const currentMessageFormatted = `[${new Date().toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' })}] ${msg.author.username}: ${content}`;
    const historyContext = buildHistoryContext(channelId, currentMessageFormatted);

    // 2. Semantic search (long-term memory)
    const memories = await memory.searchMemory(content, {
      limit: 5,
      minSimilarity: 0.4,
      minTrust: 0.5,
    });
    const memoryContext = memory.formatMemoryContext(memories);

    // 3. Build prompt
    let prompt = getSystemPrompt();

    if (projectPath) {
      prompt += `\n\n## ${t('discord.chatContext')}\n- **${t('discord.projectContext', { path: projectPath })}**`;
    }

    prompt += `\n\n## Chat Context\n${historyContext}`;

    if (memoryContext) {
      prompt += `\n\n${memoryContext}`;
    }

    console.log(`[OpenSwarm] History context: ${channelHistoryMap.get(channelId)?.length ?? 0} messages`);

    // Run via adapter
    const { result: response, toolCalls } = await runWithAdapter(prompt, { cwd: projectPath || undefined });

    if (typingInterval) clearInterval(typingInterval);

    updateHistoryResponse(channelId, msg.id, response);

    if (toolCalls.length > 0) {
      const toolSummary = toolCalls.slice(0, 10).map(tc => `• ${tc}`).join('\n');
      const toolMsg = `🔧 **${t('discord.toolCalls', { n: toolCalls.length })}**\n${toolSummary}${toolCalls.length > 10 ? `\n... ${t('common.moreItems', { n: toolCalls.length - 10 })}` : ''}`;
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
    console.log(`[OpenSwarm] Response sent (${response.length} chars)`);

  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    console.error('[OpenSwarm] Error:', err);
    await msg.reply(t('discord.chatError'));
  }
}

/**
 * Run via the default adapter (codex / openrouter / lmstudio / local)
 */
async function runWithAdapter(
  prompt: string,
  options?: { cwd?: string },
): Promise<{ result: string; toolCalls: string[] }> {
  const adapter = getAdapter();
  const cwd = options?.cwd ?? process.cwd();
  console.log(`[Adapter:${adapter.name}] Starting in ${cwd}...`);

  const raw = await spawnCli(adapter, {
    prompt,
    cwd,
    timeoutMs: 120_000,
    maxTurns: 10,
  });

  const workerResult = adapter.parseWorkerOutput(raw);
  const toolCalls = workerResult.commands ?? [];
  return { result: workerResult.summary ?? raw.stdout.trim(), toolCalls };
}




/**
 * Split message
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
 * Save chat history
 */
export async function saveChatHistory(entry: ChatEntry): Promise<void> {
  const write = chatHistoryWriteQueue.catch(() => undefined).then(async () => {
    let history: ChatEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(getChatHistoryFile(), 'utf-8'));
      if (Array.isArray(parsed)) history = parsed as ChatEntry[];
    } catch {
      // Missing or corrupt history starts a new valid snapshot.
    }
    history.push(entry);
    atomicWriteFileSync(getChatHistoryFile(), `${JSON.stringify(history.slice(-100), null, 2)}\n`);
  });
  chatHistoryWriteQueue = write;
  try {
    await write;
  } catch (err) {
    console.error('[OpenSwarm] Failed to save chat history:', err);
  }
}

/**
 * Get chat history (for web API)
 */
export async function getChatHistory(): Promise<ChatEntry[]> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(getChatHistoryFile(), 'utf-8'));
    return Array.isArray(data) ? data as ChatEntry[] : [];
  } catch {
    return [];
  }
}
