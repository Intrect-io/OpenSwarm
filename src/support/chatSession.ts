// ============================================
// OpenSwarm - Chat session core (UI-agnostic)
// Extracted from chatTui.ts (EPIC INT-1813 S2 / INT-1935): session persistence,
// provider/model resolution, and the model-call wrapper — none of which touch
// blessed or ink. The Ink front-end (S4) and the existing blessed TUI both build
// on this. The session directory is injectable (PlanIO-style) so the logic is
// testable without writing to the real home directory.
// ============================================

import { homedir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { readProviderOverride } from '../core/providerOverride.js';
import { getDefaultAdapterName, isKnownAdapter, type AdapterName } from '../adapters/index.js';
import { getDefaultChatModel, runChatCompletion } from './chatBackend.js';
import { atomicWriteFileSync } from './atomicFile.js';

const sessionWriteQueues = new Map<string, Promise<void>>();

/**
 * On-disk location for persisted chat sessions. Read via OPENSWARM_CHAT_DIR when
 * set (lets tests redirect writes away from the real home dir). Evaluated per
 * call so the env override applies even after module load. (INT-2014)
 */
export function getChatDir(): string {
  return process.env.OPENSWARM_CHAT_DIR ?? resolve(homedir(), '.openswarm', 'chat');
}

/** Default chat-session dir at module-load time (back-compat for direct imports). */
export const CHAT_DIR = getChatDir();

export type Message = { role: 'user' | 'assistant'; content: string; cost?: number };

export type Session = {
  id: string;
  provider: AdapterName;
  model: string;
  messages: Message[];
  totalCost: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
  /** Session goal set via /goal; the agent pursues it autonomously. */
  goal?: string;
};

// Session persistence

export async function ensureChatDir(dir: string = getChatDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function saveSession(session: Session, dir: string = getChatDir()): Promise<void> {
  await ensureChatDir(dir);
  const path = resolveSessionPath(session.id, dir);
  const previous = sessionWriteQueues.get(path) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => {
    session.updatedAt = new Date().toISOString();
    atomicWriteFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
  });
  sessionWriteQueues.set(path, write);
  try {
    await write;
  } finally {
    if (sessionWriteQueues.get(path) === write) sessionWriteQueues.delete(path);
  }
}

export async function loadSession(id: string, dir: string = getChatDir()): Promise<Session | null> {
  const path = resolveSessionPath(id, dir, false);
  if (!path) return null;
  if (!existsSync(path)) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Validate the persisted provider — a stale/removed adapter (e.g. `claude`)
  // must not pass through, or downstream model lookups crash. If it's replaced,
  // its model no longer applies → use the provider's default.
  const provider = inferProvider(data.provider as AdapterName | undefined, data.model as string | undefined);
  const model = data.provider === provider && typeof data.model === 'string' ? data.model : getDefaultChatModel(provider);
  return {
    ...data,
    provider,
    model,
    // Older session files may predate the messages field — default to [] so
    // messagesToHistory never sees undefined. (INT-2014)
    messages: Array.isArray(data.messages) ? data.messages as Message[] : [],
    totalCost: typeof data.totalCost === 'number' ? data.totalCost : 0,
    totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : 0,
  } as Session;
}

function resolveSessionPath(id: string, dir: string): string;
function resolveSessionPath(id: string, dir: string, throwOnInvalid: true): string;
function resolveSessionPath(id: string, dir: string, throwOnInvalid: false): string | null;
function resolveSessionPath(id: string, dir: string, throwOnInvalid = true): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    if (throwOnInvalid) throw new Error('Invalid chat session id');
    return null;
  }

  const baseDir = resolve(dir);
  const filePath = resolve(baseDir, `${id}.json`);
  const rel = relative(baseDir, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    if (throwOnInvalid) throw new Error('Chat session path escapes chat directory');
    return null;
  }
  return filePath;
}

export function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export interface SessionMeta {
  id: string;
  mtimeMs: number;
}

/**
 * List persisted sessions, most-recently-modified first. Sorted by file mtime
 * rather than the id (generateSessionId is minute-granular, so ids collide and
 * sort poorly). Returns [] if the dir doesn't exist yet. (INT-2014)
 */
export async function listSessions(dir: string = getChatDir()): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = await stat(resolve(dir, f));
      metas.push({ id: f.slice(0, -'.json'.length), mtimeMs: s.mtimeMs });
    } catch {
      // unreadable / removed mid-scan — skip
    }
  }
  return metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Id of the most recently modified session, or null if there are none. (INT-2014) */
export async function latestSession(dir: string = getChatDir()): Promise<string | null> {
  const list = await listSessions(dir);
  return list.length > 0 ? list[0].id : null;
}

// Provider / model resolution

export function inferProvider(provider?: AdapterName, model?: string): AdapterName {
  if (provider && isKnownAdapter(provider)) return provider;
  if (model?.startsWith('gpt-') || model?.includes('codex')) return 'codex';
  return loadDefaultProvider();
}

/**
 * Chat default provider — same precedence as CLI/daemon without a live process:
 * provider-override.json → config.yaml → registry default. (INT-3284)
 */
export function loadDefaultProvider(): AdapterName {
  try {
    const override = readProviderOverride();
    if (override) return override;
    return loadConfig().adapter ?? getDefaultAdapterName();
  } catch {
    return getDefaultAdapterName();
  }
}

// Model call wrapper

export async function callChatModel(
  prompt: string,
  provider: AdapterName,
  model: string,
  onStream: (text: string, isThinking: boolean) => void,
  onToolLog?: (line: string) => void,
  maxTurns?: number,
  signal?: AbortSignal,
  // Working directory the agent's tools (file/bash/MCP) operate in, and the root
  // used to build the repo context block. Defaults to process.cwd() downstream
  // when omitted — but the chat TUI threads the launch cwd through so the agent
  // works in the repo `openswarm chat` was started from. (INT-2005)
  cwd?: string,
): Promise<{ response: string; sessionId: string; cost: number; tokens: number }> {
  const result = await runChatCompletion({
    prompt,
    provider,
    model,
    cwd,
    timeoutMs: 300000,
    onText: onStream,
    onLog: onToolLog,
    maxTurns,
    signal,
  });

  return {
    response: result.response,
    sessionId: result.sessionId ?? '',
    cost: result.cost ?? 0,
    tokens: result.tokens ?? 0,
  };
}
