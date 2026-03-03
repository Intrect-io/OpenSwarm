// ============================================
// OpenSwarm - Discord Bot Core
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
import type { SwarmEvent, AgentStatus } from '../core/types.js';
import { extractCostFromJson, formatCost } from '../support/costTracker.js';
import * as memory from '../memory/index.js';
import { t, getPrompts, getDateLocale } from '../locale/index.js';

// Handler module (for routing)
import { handlePair } from './discordPair.js';

export let client: Client | null = null;
export let reportChannelId: string = '';

// Allowed user IDs (loaded from environment variables)
const ALLOWED_USER_IDS = process.env.DISCORD_ALLOWED_USERS?.split(',').map(id => id.trim()) || [];

// ============================================
// OpenClaw-style History Management
// ============================================

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
 * Add response to the last history entry
 */
export function updateLastHistoryResponse(channelId: string, response: string): void {
  const history = channelHistoryMap.get(channelId);
  if (history && history.length > 0) {
    history[history.length - 1].response = response;
  }
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

// ============================================
// Project Context Detection
// ============================================

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
 * Message handler
 */
async function handleMessage(msg: Message): Promise<void> {
  if (msg.author.bot) return;

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
    pr_conflict_detected: '⚡',
    pr_conflict_resolving: '🔄',
    pr_conflict_resolved: '✅',
    pr_conflict_failed: '💥',
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
 * Send message to default Discord channel (for external callers)
 */
export async function sendToChannel(content: string | { embeds: EmbedBuilder[] }): Promise<void> {
  if (!client || !reportChannelId) return;

  try {
    const channel = await client.channels.fetch(reportChannelId) as TextChannel;
    if (!channel) return;

    // If string, respect Discord 4000 char limit (split send)
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
 * Send message to Discord thread (for external callers)
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
// OpenSwarm Chat Feature
// ============================================

// Chat history storage path
const CHAT_HISTORY_FILE = '/tmp/openswarm-chat-history.json';

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
    channel.sendTyping();
    typingInterval = setInterval(() => channel.sendTyping(), 8000);
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

    // Run Claude CLI
    const { result: response, toolCalls } = await runClaude(prompt, { cwd: projectPath || undefined });

    if (typingInterval) clearInterval(typingInterval);

    updateLastHistoryResponse(channelId, response);

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

// Currently running OpenSwarm Claude process
let currentClaudeProcess: ReturnType<typeof spawn> | null = null;

/**
 * Run Claude CLI
 */
async function runClaude(
  prompt: string,
  options?: { cwd?: string }
): Promise<{ result: string; toolCalls: string[] }> {
  if (currentClaudeProcess) {
    console.log('[Claude CLI] Killing previous process...');
    currentClaudeProcess.kill('SIGKILL');
    currentClaudeProcess = null;
  }

  const workingDir = options?.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    console.log(`[Claude CLI] Starting in ${workingDir}...`);
    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
    ], {
      shell: false,
      cwd: workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    currentClaudeProcess = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      currentClaudeProcess = null;
      if (code !== 0 && code !== null) {
        console.error('[Claude CLI] Error:', stderr.slice(0, 200));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(parseClaudeJson(stdout));
    });

    proc.on('error', (err) => {
      currentClaudeProcess = null;
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });
  });
}

// Destructive command patterns
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[rf]+\s+)*.*(-[rf]+|--recursive|--force)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[fd])/i,
  /\b(drop|truncate)\s+(database|table)/i,
  /\bchmod\s+777/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
];

/**
 * Parse Claude JSON output
 */
function parseClaudeJson(output: string): { result: string; toolCalls: string[] } {
  const toolCalls: string[] = [];

  // Extract cost
  const costInfo = extractCostFromJson(output);
  if (costInfo) {
    console.log(`[Discord] Claude cost: ${formatCost(costInfo)}`);
  }

  try {
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) return { result: output.trim() || t('common.fallback.noResponse'), toolCalls };

    const arr = JSON.parse(match[0]);
    let result = t('common.fallback.noResponse');

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
              console.warn(`[OpenSwarm] Destructive command detected: ${item.input.command}`);
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
    return { result: output.trim() || t('common.fallback.noResponse'), toolCalls };
  }
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
async function saveChatHistory(entry: ChatEntry): Promise<void> {
  try {
    let history: ChatEntry[] = [];
    try {
      const data = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
      history = JSON.parse(data);
    } catch {
      // Empty array if file doesn't exist
    }

    history.push(entry);

    if (history.length > 100) {
      history = history.slice(-100);
    }

    await fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[OpenSwarm] Failed to save chat history:', err);
  }
}

/**
 * Get chat history (for web API)
 */
export async function getChatHistory(): Promise<ChatEntry[]> {
  try {
    const data = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

