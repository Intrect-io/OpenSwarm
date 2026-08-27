// ============================================
// OpenSwarm - Codex CLI Adapter
// Wraps `codex exec --json` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  CliCommandSpec,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { t } from '../locale/index.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { getCodexModelIds } from './codexModels.js';
import { codexMcpConfigArgs } from './memoryMcp.js';
import { codexUserMcpDisableArgs } from './codexUserMcp.js';
import { parseReviewerResult } from './resultParsing.js';

const execFileAsync = promisify(execFile);

// Codex shares the ChatGPT OAuth profile with the gpt adapter — the same token
// authorizes the Codex backend models endpoint.
const CODEX_PROFILE_KEY = 'openai-gpt:default';

export class CodexCliAdapter implements CliAdapter {
  readonly name = 'codex';

  constructor(
    private readonly inheritedMcpDisableArgs: typeof codexUserMcpDisableArgs = codexUserMcpDisableArgs,
  ) {}

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: true,
    supportedSkills: [],
    enforcesReadOnly: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['codex']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List the Codex models this account can use. Tries the live Codex OAuth
   * backend (when authenticated via `openswarm auth login --provider gpt`),
   * falling back to the local ~/.codex sources and a curated default list.
   */
  async listModels(): Promise<string[]> {
    let accessToken: string | undefined;
    try {
      const store = new AuthProfileStore();
      if (store.getProfile(CODEX_PROFILE_KEY)) {
        accessToken = await ensureValidToken(store, CODEX_PROFILE_KEY);
      }
    } catch {
      // No/expired auth — fall back to offline sources inside getCodexModelIds.
    }
    return getCodexModelIds(accessToken);
  }

  /** Default = the top model the account can use (live list), else the constant. */
  async getDefaultModel(): Promise<string> {
    const [first] = await this.listModels();
    return first ?? CODEX_DEFAULT_MODEL;
  }

  async buildCommand(options: CliRunOptions): Promise<CliCommandSpec> {
    const promptFile = options.prompt;
    const resolvedModel = options.model ? coerceCodexModel(options.model) : undefined;
    // `--full-auto` was deprecated in codex 0.137 (warns, still runs). Its documented
    // replacement is `--sandbox workspace-write`: same low-friction policy (writes
    // confined to the workspace, no approval prompts in non-interactive `exec`). (INT-1699)
    // Register OpenSwarm's memory MCP server unless the caller needs an isolated run.
    // A read-only run drops to codex's own `read-only` sandbox policy. Stronger
    // than a tool denylist: shell commands still run, but the filesystem is
    // read-only and the sandbox denies network, so a prompt-injected reviewer
    // has nothing to write to and nowhere to send what it read. (INT-3189)
    const sandbox = options.readOnly ? 'read-only' : 'workspace-write';
    const args = ['exec', '--json', '--sandbox', sandbox, '--skip-git-repo-check'];
    // codex has no `--strict-mcp-config`, so an OpenSwarm run would otherwise
    // inherit every MCP server in the operator's own config — one of which
    // blocking on an interactive OAuth prompt hangs `exec` until the adapter
    // timeout kills it, with no verdict and no reason. Switch them off. (AGT-3990)
    args.push(...await this.inheritedMcpDisableArgs(process.env, options.cwd, undefined, options.signal));
    if (resolvedModel) args.push('-m', resolvedModel);
    // See the claude adapter: the memory server exposes writes, and a read-only
    // review is exactly where injected content must not reach them.
    if (options.memoryTools !== false && !options.readOnly) {
      // A fixed name can collide with an inherited entry whose extra env/cwd
      // fields survive config merging. A per-run bare TOML key cannot be
      // preconfigured by the reviewed repository. (AGT-3990)
      const memoryServerName = `openswarm_memory_${randomUUID().replaceAll('-', '')}`;
      args.push(...codexMcpConfigArgs(memoryServerName));
    }
    return { command: 'codex', args, stdinFile: promptFile };
  }

  parseStreamingChunk(
    chunk: string,
    onLog: (line: string) => void,
    buffer: string = '',
  ): string {
    const combined = buffer + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      emitCodexStreamEvent(trimmed, onLog);
    }

    return remainder;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const resultText = extractCodexMessageText(raw.stdout);
    const result = extractWorkerResultJson(resultText) || extractWorkerFromText(resultText);
    // Ground-truth commands: codex emits an `item.completed`/`command_execution`
    // event for every shell it actually ran. Self-reported `commands` in the
    // model's JSON block are frequently empty (the model skips the report), which
    // made the validation-evidence gate bounce and reviewers reject on
    // "report the verification command" criteria even though the worker DID run
    // checks. Merge the real executions so `commands` reflects what happened.
    const executed = extractCodexExecutedCommands(raw.stdout);
    if (executed.length > 0) {
      result.commands = [...new Set([...result.commands, ...executed])].slice(0, 20);
    }
    return result;
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    // Event extraction is Codex-specific; reviewer parsing and the empty-output
    // contract belong to the shared parser used by every in-process adapter.
    const { messages, sawStructuredEvent } = extractCodexMessages(raw.stdout);
    if (messages.length === 0) return parseReviewerResult(sawStructuredEvent ? '' : raw.stdout);

    // Scan backwards rather than reading only the final message. The verdict is
    // normally last, but a model that signs off after it ("Let me know if you
    // want me to dig further") would otherwise bury a conclusion it did reach —
    // and since the parser now refuses to invent a verdict, that would be a hard
    // failure instead of the old fabricated REVISE.
    //
    // Earlier messages are held to the stricter JSON-only bar. Prose mid-stream
    // ("my decision: approve, pending one more check") satisfies the verdict
    // regex, and accepting it on a truncated turn would turn this merge gate
    // into a silent pass — a worse failure than the noisy REVISE being fixed
    // here. The first error kept is the LAST message's, the one to report.
    // (INT-3914)
    let lastMessageError: unknown;
    for (let i = messages.length - 1; i >= 0; i--) {
      try {
        return parseReviewerResult(messages[i], { jsonOnly: i !== messages.length - 1 });
      } catch (error) {
        if (lastMessageError === undefined) lastMessageError = error;
      }
    }
    throw lastMessageError;
  }
}

/**
 * Codex (ChatGPT account mode) only accepts OpenAI-family models. When a
 * pipeline role was configured with a Claude model and the operator later
 * switched the global adapter to `codex`, the CLI returns:
 *   400 invalid_request_error: The 'claude-...' model is not supported when
 *   using Codex with a ChatGPT account.
 *
 * Rather than letting the request fail, transparently substitute the Codex
 * default and log a warning so the operator can see what happened and either
 * fix their config or accept the substitution.
 */
export const CODEX_DEFAULT_MODEL = 'gpt-5-codex';
const warnedAboutModel = new Set<string>();

export function coerceCodexModel(requested: string): string {
  if (!isClaudeModel(requested)) return requested;
  if (!warnedAboutModel.has(requested)) {
    warnedAboutModel.add(requested);
    console.warn(
      `[CodexAdapter] '${requested}' is a Claude model and is not accepted by codex with a ChatGPT account. ` +
        `Substituting '${CODEX_DEFAULT_MODEL}'. Set worker/reviewer model explicitly in config.yaml to silence this.`,
    );
  }
  return CODEX_DEFAULT_MODEL;
}

function isClaudeModel(name: string): boolean {
  return /^claude[-_]/i.test(name);
}

/**
 * Extract the shell commands codex actually executed from its `--json` event
 * stream. Each run emits `item.completed` with `item.type === 'command_execution'`
 * and `item.command` (codex wraps it as `/bin/zsh -lc '<cmd>'` — unwrap to the
 * inner command). Ground truth, independent of the model's self-report.
 */
function extractCodexExecutedCommands(output: string): string[] {
  const commands: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'command_execution' &&
        typeof event.item.command === 'string'
      ) {
        const rawCmd: string = event.item.command;
        const unwrapped = rawCmd.match(/^\/(?:usr\/)?bin\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'\s*$/);
        const cmd = (unwrapped ? unwrapped[1] : rawCmd).trim();
        if (cmd && !commands.includes(cmd)) commands.push(cmd);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return commands;
}

/** Every agent_message in order, and whether stdout was a Codex event stream at all. */
function extractCodexMessages(output: string): { messages: string[]; sawStructuredEvent: boolean } {
  const messages: string[] = [];
  let sawStructuredEvent = false;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (typeof event?.type === 'string') sawStructuredEvent = true;
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        messages.push(event.item.text);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return { messages, sawStructuredEvent };
}

function extractCodexMessageText(output: string): string {
  const { messages, sawStructuredEvent } = extractCodexMessages(output);
  // Keep the legacy plain-text fallback only when stdout was not a Codex event
  // stream. Returning reasoning/tool NDJSON as if it were the final message makes
  // a reasoning-only run look non-empty and fabricates a reviewer verdict. (INT-2879)
  return messages.at(-1) || (sawStructuredEvent ? '' : output);
}

function emitCodexStreamEvent(line: string, onLog: (line: string) => void): void {
  try {
    const event = JSON.parse(line);
    const eventType = typeof event.type === 'string' ? event.type : '';

    if (eventType === 'turn.started') {
      onLog('───');
      onLog('Codex turn started');
      return;
    }

    if (eventType === 'turn.completed') {
      onLog('Codex turn completed');
      return;
    }

    if (
      eventType === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      emitCodexText(event.item.text, onLog);
      return;
    }

    if (eventType === 'item.completed' && event.item?.type === 'reasoning') {
      const summary = summarizeCodexReasoning(event.item);
      if (summary) onLog(`▸ ${summary}`);
      return;
    }

    if (eventType === 'error' && typeof event.message === 'string') {
      onLog(`ERROR: ${truncate(event.message, 300)}`);
    }
  } catch {
    // Ignore malformed or partial non-JSON lines.
  }
}

function emitCodexText(text: string, onLog: (line: string) => void): void {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let prevWasEmpty = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      onLog(inCodeBlock ? '┌─ code ─' : '└────────');
      prevWasEmpty = false;
      continue;
    }

    if (!trimmed) {
      if (!prevWasEmpty) {
        onLog('');
        prevWasEmpty = true;
      }
      continue;
    }
    prevWasEmpty = false;

    if (inCodeBlock) {
      onLog('│ ' + truncate(raw, 300));
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      onLog('');
      onLog('■ ' + headerMatch[2]);
      continue;
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      onLog('  ' + truncate(trimmed, 300));
      continue;
    }

    onLog(truncate(trimmed, 300));
  }
}

function summarizeCodexReasoning(item: Record<string, unknown>): string | null {
  if (typeof item.text === 'string' && item.text.trim()) {
    return truncate(item.text.trim(), 200);
  }

  if (typeof item.summary === 'string' && item.summary.trim()) {
    return truncate(item.summary.trim(), 200);
  }

  if (Array.isArray(item.summary)) {
    const text = item.summary
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');

    return text ? truncate(text, 200) : null;
  }

  return null;
}

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    const objMatch = text.match(/\{\s*"success"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx));
      return {
        success: Boolean(parsed.success),
        summary: parsed.summary || t('common.fallback.noSummary'),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
        confidencePercent: typeof parsed.confidencePercent === 'number'
          ? parsed.confidencePercent : undefined,
        haltReason: parsed.haltReason || undefined,
        noChangesReason: typeof parsed.noChangesReason === 'string' ? parsed.noChangesReason : undefined,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
      noChangesReason: typeof parsed.noChangesReason === 'string' ? parsed.noChangesReason : undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  // Only an explicit failure phrase marks the run as failed. Loose "error"/"fail"
  // words appear in normal coding prose; git-diff promotion in worker.ts is the
  // real success signal.
  const failed = isExplicitFailure(text);

  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint|ruff|codex)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: !failed,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: failed ? extractErrorMessage(text) : undefined,
  };
}

// Detect a real failure declaration, not incidental "error"/"fail" prose (see gpt.ts).
function isExplicitFailure(text: string): boolean {
  if (/"success"\s*:\s*false/i.test(text)) return true;
  return /\b(failed to|unable to|could not|couldn['’]t|cannot (?:complete|finish|proceed|continue)|giving up|abort(?:ed|ing))\b/i.test(text);
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) {
    return errorMatch[1].slice(0, 200);
  }
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) {
    return lines[0].slice(0, 200);
  }
  return 'Unknown error';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
