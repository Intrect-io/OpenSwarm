import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AdapterName } from '../adapters/index.js';
import { getAdapter, getDefaultAdapterName, listBoundarySafeModels } from '../adapters/index.js';
// Single source for each provider's default model — see getDefaultChatModel.
import { CODEX_DEFAULT_MODEL } from '../adapters/codex.js';
import { DEFAULT_MODEL as CODEX_RESPONSES_DEFAULT_MODEL } from '../adapters/codexResponses.js';
import { DEFAULT_MODEL as GPT_DEFAULT_MODEL } from '../adapters/gpt.js';
import { DEFAULT_MODEL as LOCAL_DEFAULT_MODEL } from '../adapters/local.js';
import { DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL } from '../adapters/openrouter.js';
import { extractCursorFinalText } from '../adapters/cursor.js';
import { ATLASCLOUD_DEFAULT_MODEL } from '../adapters/atlascloud.js';
import { CLAUDE_DEFAULT_MODEL } from '../adapters/claude.js';
import {
  prepareCliProcessTreeSpawn,
  terminateCliProcessTree,
  trackCliProcessTree,
  untrackCliProcessTree,
} from '../adapters/processTree.js';
import { raceWithAbort } from '../adapters/abortRace.js';
import { buildWorkerEnv } from '../adapters/envPath.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

export interface ChatCompletionOptions {
  prompt: string;
  provider?: AdapterName;
  model?: string;
  cwd?: string;
  sessionId?: string;
  timeoutMs?: number;
  onText?: (text: string, isThinking: boolean) => void;
  /** Tool-execution log from the agentic loop (`🔧 name: args`) for the chat UI. */
  onLog?: (line: string) => void;
  /** Max agentic turns (default 25); raised for autonomous /goal pursuit. */
  maxTurns?: number;
  /** Abort the run (Esc/Ctrl+C). */
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  response: string;
  provider: AdapterName;
  model: string;
  sessionId?: string;
  cost?: number;
  tokens?: number;
}

export const CHAT_MODEL_ALIASES: Record<AdapterName, Record<string, string>> = {
  codex: {
    codex: 'gpt-5-codex',
    gpt5: 'gpt-5-codex',
    gpt5codex: 'gpt-5-codex',
  },
  'codex-responses': {
    // Codex backend tiers (see `openswarm auth models` for the live list).
    big: 'gpt-5.6-sol',
    medium: 'gpt-5.6-terra',
    small: 'gpt-5.6-luna',
    codex: 'gpt-5.3-codex',
  },
  gpt: {
    'gpt-4o': 'gpt-4o',
    'o3': 'o3',
    'o4-mini': 'o4-mini',
    'gpt-4.1': 'gpt-4.1',
  },
  local: {
    'gemma4': 'gemma3:4b',
    'gemma4-e4b': 'gemma3:4b',
    'gemma': 'gemma3:4b',
    'llama3': 'llama3.3:latest',
    'llama': 'llama3.3:latest',
    'mistral': 'mistral:latest',
    'codestral': 'codestral:latest',
    'qwen': 'qwen2.5-coder:7b',
    'qwen-coder': 'qwen2.5-coder:7b',
    'deepseek': 'deepseek-coder-v2:latest',
    'phi': 'phi4:latest',
    'starcoder': 'starcoder2:7b',
  },
  lmstudio: {
    local: process.env.LMSTUDIO_MODEL ?? 'local-model',
    lmstudio: process.env.LMSTUDIO_MODEL ?? 'local-model',
  },
  openrouter: {
    // Short aliases — full IDs (e.g. 'anthropic/claude-sonnet-4') pass through unchanged.
    sonnet: 'anthropic/claude-sonnet-4',
    opus: 'anthropic/claude-opus-4',
    haiku: 'anthropic/claude-haiku-4-5',
    'gpt-4o': 'openai/gpt-4o',
    'gpt-5': 'openai/gpt-5',
    'o4-mini': 'openai/o4-mini',
    gemini: 'google/gemini-2.5-pro',
    kimi: 'moonshotai/kimi-k2',
    glm: 'z-ai/glm-4.6',
  },
  atlascloud: {
    deepseek: 'deepseek-ai/deepseek-v4-pro',
    'deepseek-v4': 'deepseek-ai/deepseek-v4-pro',
    qwen: 'qwen/qwen3.5-flash',
    'qwen-flash': 'qwen/qwen3.5-flash',
  },
  claude: {
    // `claude -p --model <alias>` takes version-robust aliases directly.
    sonnet: 'sonnet',
    opus: 'opus',
    haiku: 'haiku',
  },
  'cc-router': {
    big: 'gpt-5.6-sol',
    medium: 'gpt-5.6-terra',
    small: 'gpt-5.6-luna',
  },
  cursor: {
    auto: 'auto',
  },
};

export function inferProviderFromModel(model?: string): AdapterName {
  if (!model) return getDefaultAdapterName();
  // The GPT-5.6 capability-tier slugs are served by the ChatGPT Codex backend
  // in this app. Keep an explicit --provider gpt escape hatch for public-API
  // callers, but do not silently route a bare tier slug to /v1/chat/completions.
  if (/^gpt-5\.6-(?:sol|terra|luna)$/i.test(model)) return 'codex-responses';
  if (model.includes('codex')) return 'codex';
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'gpt';
  if (model.includes('/')) return 'openrouter';
  // 로컬 모델 패턴: ollama 태그 형식 (name:tag) 또는 알려진 오픈소스 모델
  if (model.includes(':') || /^(gemma|llama|mistral|codestral|qwen|deepseek|phi|starcoder)/i.test(model)) return 'local';
  return getDefaultAdapterName();
}

/**
 * Chat-side default per provider.
 *
 * Reuses each adapter's own default constant rather than repeating the id here.
 * These used to be duplicated string literals and drifted apart the moment an
 * adapter default changed — the chat UI would silently open on a different model
 * than the one a task would run. This function stays synchronous (callers resolve
 * models without awaiting), so it reads the static default rather than
 * `getDefaultModel()`, which consults the live catalog.
 */
export function getDefaultChatModel(provider: AdapterName): string {
  if (provider === 'codex') return CODEX_DEFAULT_MODEL;
  if (provider === 'codex-responses') return CODEX_RESPONSES_DEFAULT_MODEL;
  if (provider === 'gpt') return GPT_DEFAULT_MODEL;
  if (provider === 'local') return LOCAL_DEFAULT_MODEL;
  if (provider === 'lmstudio') return process.env.LMSTUDIO_MODEL ?? 'local-model';
  if (provider === 'openrouter') return OPENROUTER_DEFAULT_MODEL;
  if (provider === 'atlascloud') return ATLASCLOUD_DEFAULT_MODEL;
  if (provider === 'claude') return CLAUDE_DEFAULT_MODEL;
  if (provider === 'cc-router') return process.env.CC_ROUTER_MODEL ?? 'gpt-5.6-terra';
  if (provider === 'cursor') return 'auto';
  return CODEX_DEFAULT_MODEL;
}

export function resolveChatModel(input: string | undefined, provider: AdapterName): string {
  if (!input) return getDefaultChatModel(provider);
  const alias = CHAT_MODEL_ALIASES[provider][input.toLowerCase()];
  return alias || input;
}

/** Curated model ids for a provider, derived from CHAT_MODEL_ALIASES. Pure. (INT-1961) */
export function curatedModels(provider: AdapterName): string[] {
  const fromAliases = Array.from(new Set(Object.values(CHAT_MODEL_ALIASES[provider] ?? {})));
  const def = getDefaultChatModel(provider);
  return Array.from(new Set([def, ...fromAliases]));
}

/**
 * Models offered by the /model switcher: the adapter's live catalog when it
 * exposes listModels(), else the curated list. Network failures fall back to
 * curated. (INT-1961)
 */
export async function listChatModels(provider: AdapterName): Promise<string[]> {
  try {
    const adapter = getAdapter(provider);
    if (typeof adapter.listModels === 'function') {
      const live = await listBoundarySafeModels(adapter);
      if (live?.length) return Array.from(new Set(live));
    }
  } catch {
    // fall through to curated
  }
  return curatedModels(provider);
}

export function shortenChatModel(model: string): string {
  // OpenRouter: "anthropic/claude-sonnet-4" → "claude-sonnet-4"
  if (model.includes('/')) return model.split('/').pop() ?? model;
  return model;
}

function chatAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Chat response cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * API-based adapters (gpt/openrouter/local/codex-responses) execute via run(),
 * not a shell — their buildCommand is a stub, so spawning it returns nothing
 * ("No response"). Route chat through run() as a plain, tool-free single turn.
 */

// Project-rules files read into the repo context block, in preference order
// (first found wins — AGENTS.md is the OpenSwarm convention, CLAUDE.md the fallback).
const REPO_RULES_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
// Cap injected rules so a long file doesn't dominate the prompt budget.
const REPO_RULES_MAX_CHARS = 2000;

export const BASE_CHAT_SYSTEM_PROMPT =
  'You are a capable coding assistant operating in the user\'s current working directory, with tools to ' +
  'read/search/edit/create files, run shell commands, and call configured MCP server tools (named `server__tool`). ' +
  'Work like a thoughtful pair programmer who thinks out loud. Before each tool call, write one short sentence ' +
  'saying what you are about to do and why (e.g. "To find where X is defined, I\'ll search the source."). After a ' +
  'tool returns, briefly note what you found and your next step, then continue. Actually use the tools to perform ' +
  'the task — never just describe it. Keep narration to a sentence or two between actions, not essays. ' +
  'For a trivial question with no task, just answer directly without tools.';

/**
 * Build a repo-context block injected into the chat agent's system prompt so it
 * knows which repository it is in, the active branch, and the project's own
 * rules (AGENTS.md / CLAUDE.md). This is what lets `openswarm chat`/`/plan`/
 * `/goal` operate in the cwd the CLI was launched from rather than guessing.
 * Returns '' when `cwd` doesn't exist (caller then uses the base prompt alone).
 * Best-effort: a missing git/rules file is silently skipped. (INT-2005)
 */
export function buildRepoContext(cwd: string): string {
  if (!cwd || !existsSync(cwd)) return '';
  const repo = basename(cwd.replace(/[/\\]+$/, '')) || cwd;
  const lines = ['## Repository context', `repo: ${repo}  (${cwd})`];

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (branch) lines.push(`branch: ${branch}`);
  } catch {
    // not a git repo — omit the branch
  }

  for (const name of REPO_RULES_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      let body = readFileSync(path, 'utf8').trim();
      if (!body) continue;
      if (body.length > REPO_RULES_MAX_CHARS) {
        body = `${body.slice(0, REPO_RULES_MAX_CHARS)}\n… (truncated — read ${name} for the rest)`;
      }
      lines.push('', `## Project rules (${name})`, body);
      break; // first match wins
    } catch {
      // unreadable — skip
    }
  }

  return lines.join('\n');
}

async function runChatViaAdapter(
  adapter: ReturnType<typeof getAdapter>,
  provider: AdapterName,
  model: string,
  cwd: string,
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const timeoutMs = options.timeoutMs ?? 300000;
  const lifecycleController = new AbortController();
  const timeoutError = new Error('Chat response timeout');
  let deadlineTimer: NodeJS.Timeout | null = null;
  const relayCallerAbort = () => lifecycleController.abort(chatAbortError(options.signal));
  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => lifecycleController.abort(timeoutError), timeoutMs);
  }
  options.signal?.addEventListener('abort', relayCallerAbort, { once: true });
  if (options.signal?.aborted) relayCallerAbort();
  const runSignal = lifecycleController.signal;

  try {
  // run() adapters take the prompt as TEXT (it becomes the agentic-loop user
  // message) — unlike the codex CLI path, which treats options.prompt as a file
  // path to `cat`. Pass the message text directly.
  //
  // chat runs as a tool-using coding agent: file/bash/web tools enabled, multi-turn,
  // so it can actually read/edit/run in the working directory. Tokens stream via
  // onToken; tool executions surface through onLog.
  // Expose any MCP servers configured in ~/.openswarm/mcp.json as tools (cached).
  const { resolveMcpTools } = await import('../mcp/mcpClient.js');
  const mcpTools = await raceWithAbort(
    resolveMcpTools(),
    runSignal,
    'Chat response cancelled',
  );

  // Tell the agent which repo/branch it's in and surface the project's own rules
  // so chat/plan/goal work in the launch cwd, not a guessed one. (INT-2005)
  const repoContext = buildRepoContext(cwd);

  let streamed = false;
  const raw = await raceWithAbort(
    adapter.run!({
      prompt: options.prompt,
      cwd,
      model,
      systemPrompt: repoContext
        ? `${BASE_CHAT_SYSTEM_PROMPT}\n\n${repoContext}`
        : BASE_CHAT_SYSTEM_PROMPT,
      enableTools: true,
      webTools: true,
      // The native loop performs strict companion attestation and withholds
      // bash itself when the socket/contract is absent. Keep the request on so
      // strict chat and autonomous workers share the same fail-closed path.
      shellTools: true,
      diagnosticsTool: false,
      mcpTools,
      // A high safety ceiling, not a task limit — normal work ends when the model
      // stops calling tools; the progress-based stop catches stuck loops earlier.
      maxTurns: options.maxTurns ?? 80,
      timeoutMs,
      // Stream tokens live when the adapter supports it (codex-responses / chat
      // completions); the chat TUI renders each delta as it arrives.
      onToken: options.onText
        ? (delta) => {
            if (runSignal.aborted) return;
            streamed = true;
            options.onText!(delta, false);
          }
        : undefined,
      // Tool executions (🔧 …) surface to the chat UI.
      onLog: options.onLog
        ? (line) => {
            if (!runSignal.aborted) options.onLog!(line);
          }
        : undefined,
      signal: runSignal,
    }),
    runSignal,
    'Chat response cancelled',
  );
  if (raw.exitCode !== 0 && !raw.stdout.trim()) {
    throw new Error(raw.stderr.trim() || `${provider} exited with code ${raw.exitCode}`);
  }
  const text = raw.stdout.trim();
  // Non-streaming adapters emit nothing via onToken — flush the full reply once.
  if (!streamed) options.onText?.(text, false);
  return { response: text || '[No response]', provider, model };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', relayCallerAbort);
  }
}

export async function runChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  if (options.signal?.aborted) throw chatAbortError(options.signal);

  const provider = options.provider ?? inferProviderFromModel(options.model);
  const model = resolveChatModel(options.model, provider);
  const adapter = getAdapter(provider);
  const cwd = options.cwd ?? process.cwd();

  if (typeof adapter.run === 'function') {
    if (
      isHumanSurfaceReadOnlyEnabled()
      && adapter.capabilities.enforcesHumanSurfaceReadOnly !== true
    ) {
      throw new Error(
        `HUMAN_SURFACE_READ_ONLY: Chat adapter '${adapter.name}' does not declare enforcement of the strict `
        + 'human-surface boundary; use a native OpenSwarm-loop provider.',
      );
    }
    return runChatViaAdapter(adapter, provider, model, cwd, options);
  }

  if (isHumanSurfaceReadOnlyEnabled()) {
    throw new Error(
      `HUMAN_SURFACE_READ_ONLY: Chat adapter '${adapter.name}' delegates to an external CLI with its own tool loop; `
      + 'use a native OpenSwarm-loop provider while humanSurfaceReadOnly.enabled is true.',
    );
  }

  // CLI command construction can itself perform I/O (Codex enumerates the
  // effective MCP list). The chat timeout is a wall-clock deadline for that
  // work and the spawned process together, not a second timer that begins only
  // after command construction has already consumed several seconds.
  const timeoutMs = options.timeoutMs ?? 300000;
  const lifecycleController = new AbortController();
  const timeoutError = new Error('Chat response timeout');
  let deadlineTimer: NodeJS.Timeout | null = null;
  const relayCallerAbort = () => lifecycleController.abort(chatAbortError(options.signal));
  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => lifecycleController.abort(timeoutError), timeoutMs);
  }
  options.signal?.addEventListener('abort', relayCallerAbort, { once: true });
  if (options.signal?.aborted) relayCallerAbort();
  const runSignal = lifecycleController.signal;
  const cleanupDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', relayCallerAbort);
  };

  // CLI adapters consume a prompt path. Use a private, unpredictable directory
  // and owner-only file instead of exposing prompt contents in a predictable
  // world-readable /tmp filename.
  let promptDir: string | undefined;
  let promptFile: string | undefined;

  try {
    promptDir = await mkdtemp(join(tmpdir(), 'openswarm-chat-'));
    promptFile = join(promptDir, 'prompt.txt');
    if (runSignal.aborted) throw chatAbortError(runSignal);
    await writeFile(promptFile, options.prompt, { mode: 0o600 });
    const { command, args, stdinFile } = await raceWithAbort(
      adapter.buildCommand({
        prompt: promptFile,
        cwd,
        model,
        timeoutMs,
        signal: runSignal,
      }),
      runSignal,
      'Chat response cancelled',
    );
    if (runSignal.aborted) throw chatAbortError(runSignal);
    // Some CLIs (cursor-agent) take the prompt on stdin rather than as a path
    // argument; ignoring stdinFile leaves them waiting for input that never
    // arrives. spawnCli() in base.ts already honours this on the daemon path.
    const stdin = stdinFile ? await readFile(stdinFile) : undefined;
    if (runSignal.aborted) throw chatAbortError(runSignal);

    return await new Promise<ChatCompletionResult>((resolve, reject) => {
      const cliSpawn = prepareCliProcessTreeSpawn(command, args, buildWorkerEnv(process.env));
      const proc = spawn(cliSpawn.command, cliSpawn.args, {
        shell: false,
        detached: process.platform !== 'win32',
        cwd,
        env: cliSpawn.env,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      trackCliProcessTree(proc);
      if (stdin) {
        proc.stdin?.on('error', () => { /* the child may exit before the write drains */ });
        proc.stdin?.end(stdin);
      }

      let stdout = '';
      let stderr = '';
      let buffer = '';
      let capturedSessionId = options.sessionId || '';
      let startedStreaming = false;
      let thinkingTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanupProcessHooks = () => {
        if (thinkingTimer) clearTimeout(thinkingTimer);
        runSignal.removeEventListener('abort', onAbort);
        untrackCliProcessTree(proc);
      };

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanupProcessHooks();
        action();
      };

      const onAbort = () => {
        terminateCliProcessTree(proc);
        settle(() => reject(chatAbortError(runSignal)));
      };

      if (runSignal.aborted) {
        onAbort();
        return;
      }
      runSignal.addEventListener('abort', onAbort, { once: true });

      const resetThinkingTimer = () => {
        if (!options.onText) return;
        if (thinkingTimer) clearTimeout(thinkingTimer);
        thinkingTimer = setTimeout(() => {
          if (startedStreaming) options.onText?.('', true);
        }, 2000);
      };

      const flushLines = (force = false) => {
        const lines = buffer.split('\n');
        buffer = force ? '' : (lines.pop() ?? '');
        for (const raw of force ? lines.concat(buffer ? [buffer] : []) : lines) {
          const line = raw.trim();
          if (!line) continue;
          // Each CLI streams its own event shape; parsing every provider as
          // Codex NDJSON left non-Codex chat turns with no live output at all,
          // only a final answer once the process exited.
          if (adapter.name === 'cursor') {
            const text = extractCursorFinalText(line);
            if (text && text !== line) {
              startedStreaming = true;
              options.onText?.(text, false);
              resetThinkingTimer();
            }
            continue;
          }
          try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
              startedStreaming = true;
              options.onText?.(event.item.text, false);
              resetThinkingTimer();
            }
            if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
              options.onText?.('', true);
            }
          } catch {
            // Ignore malformed lines.
          }
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        buffer += text;
        flushLines(false);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (settled) return;
        // A wrapper can exit cleanly after launching a detached-stdio child.
        // `close` then arrives immediately even though that child still lives
        // in the wrapper's private POSIX process group. Always reap the group
        // before resolving the chat request.
        terminateCliProcessTree(proc);
        flushLines(true);

        if (runSignal.aborted) {
          settle(() => reject(chatAbortError(runSignal)));
          return;
        }

        if (code !== 0 && !stdout.trim()) {
          settle(() => reject(new Error(stderr.trim() || `${provider} exited with code ${code}`)));
          return;
        }

        const response = extractChatResponse(adapter.name, stdout);
        const cost = undefined;
        const tokens = undefined;

        settle(() => resolve({
          response: response || '[No response]',
          provider,
          model,
          sessionId: capturedSessionId || undefined,
          cost,
          tokens,
        }));
      });

      proc.on('error', (error) => {
        settle(() => reject(runSignal.aborted ? chatAbortError(runSignal) : error));
      });
    });
  } finally {
    cleanupDeadline();
    try {
      if (promptFile) await unlink(promptFile);
    } catch {
      // Ignore temp cleanup errors.
    }
    try {
      if (promptDir) await rmdir(promptDir);
    } catch {
      // Ignore temp cleanup errors.
    }
  }
}

/**
 * Pull the assistant's final message out of a CLI's streamed output.
 *
 * Each CLI streams its own event shape, so the extractor is chosen by adapter
 * rather than assumed to be Codex NDJSON — running Cursor through the Codex
 * parser yields an empty response for every turn.
 */
export function extractChatResponse(adapterName: string, stdout: string): string {
  if (adapterName === 'cursor') return extractCursorFinalText(stdout);
  return extractCodexChatResponse(stdout);
}

function extractCodexChatResponse(stdout: string): string {
  let lastMessage = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        lastMessage = event.item.text.trim();
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return lastMessage;
}
