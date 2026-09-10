// ============================================
// OpenSwarm - Agentic Tool Definitions & Executor
// Created: 2026-04-11
// Purpose: GPT/Local 어댑터가 Claude CLI와 동등한 도구 사용 능력을 갖도록
//          공통 도구 정의 + 실행기 제공
// ============================================

import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { webFetch, webSearch } from './webTools.js';
import { isMcpTool, callMcpTool } from '../mcp/mcpClient.js';
import { applyV4APatch } from './applyPatch.js';
import { atomicWriteFile } from '../support/atomicFile.js';
import { COORDINATION_TOOL_NAMES, executeCoordinationTool, type CoordinationToolContext } from '../coordination/coordinationTools.js';
import {
  humanSurfaceShellWriteReason,
  isHumanSurfaceReadOnlyEnabled,
  stripHumanSurfaceEnv,
} from '../mcp/humanSurfacePolicy.js';
import { SandboxOutcomeUnknownError, type SandboxExecutorSession } from '../sandboxExecutor/protocol.js';
import { linkedMainCheckoutOf } from '../security/gitWorktreeIdentity.js';

const execFileAsync = promisify(execFile);

/**
 * The daemon's launchd PATH is minimal (/usr/bin:/bin:/opt/homebrew/bin, no
 * ~/.cargo/bin or ~/.local/bin), and the `bash` tool runs non-login (`bash -c`),
 * so it never sources the user's shell profile. Result: `cargo`/`uv`/`pyenv`
 * shims are "command not found", the worker cannot build/test its Rust/Python
 * changes, and the validation gate + reviewer reject it → Max-iteration STUCK
 * (observed live on every WAVE Rust task: "cargo: command not found"). Prepend
 * the common user tool bins a login shell would have added. (INT-2485)
 */
export function buildBashToolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = homedir();
  const extra = [
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const current = (base.PATH ?? '').split(':').filter(Boolean);
  const merged = [...extra.filter((p) => !current.includes(p)), ...current];
  return stripHumanSurfaceEnv({ ...base, PATH: merged.join(':') });
}

// ============ 도구 정의 ============

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a file from the local filesystem. Use offset/limit for large files. Local-only assets may be read under /warehouse when provisioned.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path to read' },
          offset: { type: 'number', description: 'Start line (0-based). Default: 0' },
          limit: { type: 'number', description: 'Max lines to read. Default: 500' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents using ripgrep (regex). Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return stdout/stderr. Timeout: 30s. Destructive commands (rm -rf, git reset --hard) are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search this repository\'s accumulated knowledge from past tasks — successful approaches (patterns) and reviewer pitfalls (constraints) — by semantic query. Call this BEFORE implementing to reuse what worked here and avoid known mistakes. Scoped to the current repo automatically.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall, e.g. "how auth migrations were handled" or "logout button"' },
          limit: { type: 'number', description: 'Max results (1-10). Default: 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text (HTML stripped to text). Use when you already have a URL (docs, a page) and want its content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and return ranked results (title, url, snippet). Use to find documentation, API usage, library versions, or current facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file using SEARCH/REPLACE blocks. SEARCH must exactly match existing code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Text to replace (must match exactly)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch to a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          patch: { type: 'string', description: 'Unified diff patch content' },
        },
        required: ['path', 'patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnostics',
      description: 'Run TypeScript/Python diagnostics on changed files.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'string', description: 'Comma-separated file paths' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['paths', 'cwd'],
      },
    },
  },
];

// ============ 안전 가드 ============

const BLOCKED_COMMANDS = [
  /\brm\s+(-[rR]f?|--recursive)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  />\s*\/dev\/sd/,
  /\bdd\s+if=/,
  /\bpkill\s+-9\b/,
  /\bkill\s+-9\b/,
];

/**
 * Secondary-interpreter commands that can conceal destructive operations.
 * A blocklist covers known patterns that call interpreters where the real
 * command string is a shell word or argument, not a direct match.
 */
const SECONDARY_INTERPRETER_PATTERNS = [
  /\bsh\s+-c\s+/,
  /\bbash\s+-c\s+/,
  /\bzsh\s+-c\s+/,
  /\bksh\s+-c\s+/,
  /\bdash\s+-c\s+/,
  /\bfish\s+-c\s+/,
];

/**
 * Process substitution and command substitution patterns that can execute
 * code before the outer command sees it.
 */
const PROCESS_SUBSTITUTION_PATTERNS = [
  /\$\(/,
  /`[^`]+`/,
];

/**
 * Tools a read-only run refuses to execute.
 *
 * Kept beside the loop's tool-list filter rather than inline, because the two
 * drifted apart once already: `diagnostics` was withheld from the list but
 * missing here, and the loop's own comment explains why that is not enough — a
 * model calls tools it was never shown. `diagnostics` matters as much as `bash`
 * does, since it runs a `tsc`/`ruff` binary found by walking up from the tree
 * under review, with the full environment. (INT-3189, INT-2961)
 */
const READ_ONLY_DENIED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'bash',
  'web_fetch',
  'web_search',
  'diagnostics',
]);

const FILESYSTEM_DENIED_TOOLS = new Set([
  ...TOOL_DEFINITIONS.map((tool) => tool.function.name),
  'apply_patch',
  'diagnostics',
]);


/** Did this spawn fail because the binary is not installed? */
function isMissingExecutable(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

/**
 * `git grep` stand-in for ripgrep.
 *
 * Deliberately not a full reimplementation: it covers the case that matters —
 * searching a repository — and says so plainly when it cannot, rather than
 * returning an error the agent reads as "no matches". Line numbers and the
 * 50-match cap match the ripgrep invocation so the output shape is the same.
 */
async function searchWithGitGrep(
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  callId: string,
  cwd: string,
): Promise<ToolResult> {
  const args = ['grep', '--no-color', '-n', '-I', '-E', '-e', pattern, '--'];
  args.push(glob ? `${searchPath}/${glob}` : searchPath);
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10000, maxBuffer: 1024 * 256 });
    const lines = stdout.split('\n').filter(Boolean).slice(0, 50);
    return { tool_call_id: callId, content: lines.length ? lines.join('\n') : '(no matches)', is_error: false };
  } catch (error) {
    // git grep also exits 1 for no matches.
    if (error && typeof error === 'object' && 'code' in error && (error as { code: number }).code === 1) {
      return { tool_call_id: callId, content: '(no matches)', is_error: false };
    }
    return {
      tool_call_id: callId,
      content:
        'search_files is unavailable: ripgrep is not installed and git grep failed. ' +
        'Install ripgrep, or run this inside a git repository. Do not treat this as "no matches".',
      is_error: true,
    };
  }
}

/**
 * Normalize a command string for guard matching: collapse whitespace, strip
 * leading/trailing whitespace, and fold common shell quoting so that
 * `rm  -rf  /` and `rm -rf /` match the same pattern.
 */
function normalizeForGuard(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

/**
 * Detect mid-word substitution patterns that can conceal destructive commands.
 * For example `rm$(echo)x` becomes `rmx` after shell expansion, but the
 * guard sees `rm$(echo)x` which does not match `/\brm\s+-r/`. This function
 * checks whether a substitution token appears inside a word that would
 * otherwise look like a blocked command after expansion.
 */
function hasMidWordSubstitution(command: string): boolean {
  // Check for $(...) or backtick substitution mid-word: e.g. r$(...)m, r`...`m
  // We look for a letter, then $( or `, then content, then ) or `, then letter
  return /[a-zA-Z]\$\([^)]+\)[a-zA-Z]/.test(command) ||
         /[a-zA-Z]`[^`]+`[a-zA-Z]/.test(command);
}

function isCommandBlocked(command: string): boolean {
  const normalized = normalizeForGuard(command);

  // Direct destructive command patterns
  if (BLOCKED_COMMANDS.some(pattern => pattern.test(normalized))) return true;

  // Mid-word substitution can bypass direct pattern matching
  if (hasMidWordSubstitution(normalized)) return true;

  // Secondary interpreters (sh -c, bash -c, etc.) — the real command
  // is a shell word, not directly matched by BLOCKED_COMMANDS.
  if (SECONDARY_INTERPRETER_PATTERNS.some(pattern => pattern.test(normalized))) return true;

  // Process substitution / command substitution — $(...) and backticks
  // can execute arbitrary code before the outer command runs.
  if (PROCESS_SUBSTITUTION_PATTERNS.some(pattern => pattern.test(normalized))) return true;

  return false;
}

// ============ 도구 실행기 ============

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
  fatal?: string;
}

interface ReadCache {
  data: Map<string, string>;
}

function createReadCache(): ReadCache {
  return { data: new Map() };
}

function cacheGet(cache: ReadCache, key: string): string | undefined {
  return cache.data.get(key);
}

function cacheSet(cache: ReadCache, key: string, value: string): void {
  cache.data.set(key, value);
}

function invalidateCache(cache: ReadCache | undefined, filePath: string): void {
  if (cache) cache.data.delete(filePath);
}

export interface ToolExecOptions {
  allowedToolNames?: Set<string>;
  filesystemTools?: boolean;
  bashTimeoutMs?: number;
  protectedFiles?: Set<string>;
  sandboxExecutorSession?: SandboxExecutorSession;
  coordinationContext?: CoordinationToolContext;
  /** Accept the configured main checkout root for read/search tools only. */
  allowMainCheckoutRead?: boolean;
  /** Accept the configured warehouse root for read/search tools only. */
  allowWarehouseRead?: boolean;
}

/** 프로젝트 경로 내로 접근을 제한하는 경로 검증 */
export function validatePath(filePath: string, cwd: string, options: ValidatePathOptions = {}): string {
  const requestedRoot = path.resolve(cwd);
  const projectRoot = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  const resolved = path.resolve(projectRoot, filePath);
  const canonical = canonicalizePath(resolved);
  const inside = (root: string): boolean => {
    const requested = path.resolve(root);
    const canonicalRoot = existsSync(requested) ? realpathSync(requested) : requested;
    const rel = path.relative(canonicalRoot, canonical);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  };
  const mainCheckout = options.allowMainCheckoutRead ? linkedMainCheckoutOf(projectRoot) : null;
  const warehouseRoot = options.allowWarehouseRead
    ? (process.env.OPENSWARM_WAREHOUSE_ROOT?.trim() || '/warehouse')
    : null;
  // cwd 하위이거나, /tmp 하위만 허용. 문자열 prefix 비교는 상대 cwd를
  // 전부 거부하고 `/repo-evil` 같은 sibling을 `/repo` 내부로 오인한다.
  if (
    !inside(projectRoot)
    && !inside('/tmp')
    && !(mainCheckout && inside(mainCheckout))
    && !(warehouseRoot && inside(warehouseRoot))
  ) {
    // 모델이 자가수정하도록 안내 — 그냥 거부만 하면 같은 실수를 반복한다.
    throw new Error(
      `Path "${filePath}" is outside the project root (${projectRoot}). ` +
      `Use a path relative to the project root instead, e.g. "." for the whole project or "src/...". ` +
      `Do not use "/" or absolute paths outside ${projectRoot}.`,
    );
  }
  return canonical;
}

// Normalize a single line for fuzzy edit matching: strip trailing whitespace and
// fold common typographic variants (smart quotes, en/em dashes) plus NFKC. Lets a
// near-miss old_string (a model re-typed a quote or trailing space) still locate
// its line, instead of failing edit_file outright. (INT-2011)
function normalizeEditLine(line: string): string {
  return line
    .replace(/[ \t]+$/, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .normalize('NFKC');
}

/**
 * Fuzzy fallback for edit_file: when `oldString` is not an exact substring, match
 * it line-by-line under {@link normalizeEditLine}. Returns the EXACT original span
 * only when the match is unique — 0 or >1 matches return null so the caller refuses
 * rather than editing the wrong place. The span is line-bounded, so the offsets are
 * exact (no ratio approximation). (INT-2011)
 */
function findFuzzyEditSpan(original: string, oldString: string): { start: number; end: number } | null {
  const fileLines = original.split('\n');
  const oldLines = oldString.split('\n');
  if (oldLines.length === 0 || oldLines.length > fileLines.length) return null;
  const normFile = fileLines.map(normalizeEditLine);
  const normOld = oldLines.map(normalizeEditLine);

  let matchIndex = -1;
  let count = 0;
  for (let i = 0; i <= normFile.length - normOld.length; i++) {
    let ok = true;
    for (let j = 0; j < normOld.length; j++) {
      if (normFile[i + j] !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      matchIndex = i;
      if (count > 1) return null; // ambiguous → refuse
    }
  }
  if (count !== 1) return null; // not found → refuse

  const start = fileLines.slice(0, matchIndex).join('\n').length + (matchIndex > 0 ? 1 : 0);
  const matched = fileLines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
  return { start, end: start + matched.length };
}

/**
 * 단일 도구 호출 실행
 */
export async function executeTool(
  toolCall: ToolCall,
  cwd: string,
  cache?: ReadCache,
  execOptions?: ToolExecOptions,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;
  const callId = toolCall.id;

  try {
    if (execOptions?.allowedToolNames && !execOptions.allowedToolNames.has(name)) {
      return {
        tool_call_id: callId,
        content: `TOOL_NOT_ALLOWED: ${name} was not granted for this run.`,
        is_error: true,
      };
    }
    const args = JSON.parse(argsJson);
    if (execOptions?.filesystemTools === false && FILESYSTEM_DENIED_TOOLS.has(name)) {
      return {
        tool_call_id: callId,
        content: `FILESYSTEM_DISABLED: ${name} is disabled for this coordination-only run.`,
        is_error: true,
      };
    }
    // `web_fetch`/`web_search` are withheld from the tool list in readOnly, but
    // the denial lives here too: a model can emit a call for a tool it was never
    // shown, and an outbound request is the exfiltration path the mode exists to
    // close. Withholding is the hint; this is the enforcement. (INT-3189)
    // MCP tools are denied by predicate, not by name: their names are whatever
    // the servers declare, so no fixed list can cover them. Skipping discovery
    // in the adapter is not enough on its own — a long-lived daemon that
    // restarts the agent loop without re-discovering MCP tools would still have
    // stale names in the tool list. (INT-3189)
    if (execOptions?.sandboxExecutorSession && !isMcpTool(name)) {
      if (READ_ONLY_DENIED_TOOLS.has(name)) {
        return {
          tool_call_id: callId,
          content: `READ_ONLY: ${name} is disabled for this run. Use read_file/search_files/search_memory only.`,
          is_error: true,
        };
      }
    }

    switch (name) {
      case 'read_file': {
        const filePath = validatePath(args.path, cwd, {
          allowMainCheckoutRead: execOptions?.allowMainCheckoutRead,
          allowWarehouseRead: execOptions?.allowWarehouseRead,
        });
        const offset = Number(args.offset) || 0;
        const limit = Math.min(Number(args.limit) || 500, 2000);
        const content = await fs.readFile(filePath, 'utf8');
        // Bound source reads by bytes as well as lines — prevent memory
        // exhaustion from oversized binary/text files.
        const MAX_READ_BYTES = 512 * 1024;
        if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
          return {
            tool_call_id: callId,
            content: `File too large: ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes, max ${MAX_READ_BYTES}). Use offset/limit to read portions.`,
            is_error: true,
          };
        }
        const lines = content.split('\n');
        const selected = lines.slice(offset, offset + limit);
        const result = selected.join('\n');
        // Bound rendered output by bytes too
        const MAX_OUTPUT_BYTES = 256 * 1024;
        if (Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES) {
          const truncated = Buffer.from(result, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
          return {
            tool_call_id: callId,
            content: `${truncated}\n... (truncated, ${Buffer.byteLength(result, 'utf8')} bytes total, max ${MAX_OUTPUT_BYTES})`,
            is_error: false,
          };
        }
        return { tool_call_id: callId, content: result || '(empty file)', is_error: false };
      }

      case 'search_files': {
        const searchPath = validatePath(args.path, cwd, {
          allowMainCheckoutRead: execOptions?.allowMainCheckoutRead,
          allowWarehouseRead: execOptions?.allowWarehouseRead,
        });
        const pattern = args.pattern;
        const glob = args.glob;
        try {
          const { execa } = await import('execa');
          const rgArgs = ['--no-heading', '--line-number', '--color', 'never', '-E', '-e', pattern, searchPath];
          if (glob) rgArgs.push('--glob', glob);
          const { stdout } = await execa('rg', rgArgs, { timeout: 15000, maxBuffer: 1024 * 256 });
          const lines = stdout.split('\n').filter(Boolean).slice(0, 50);
          return { tool_call_id: callId, content: lines.length ? lines.join('\n') : '(no matches)', is_error: false };
        } catch {
          // ripgrep not installed → fall back to git grep
          return searchWithGitGrep(pattern, searchPath, glob, callId, cwd);
        }
      }

      case 'search_memory': {
        const query = args.query;
        const limit = Math.min(Number(args.limit) || 5, 10);
        try {
          const { searchMemory } = await import('../knowledge/store.js');
          const results = await searchMemory(query, limit);
          return { tool_call_id: callId, content: results || '(no results)', is_error: false };
        } catch (err) {
          return {
            tool_call_id: callId,
            content: `search_memory unavailable: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }

      case 'bash': {
        const command: string = args.command;
        if (isHumanSurfaceReadOnlyEnabled()) {
          if (!execOptions?.sandboxExecutorSession) {
            return {
              tool_call_id: callId,
              content: 'HUMAN_SURFACE_READ_ONLY: attested sandbox executor is unavailable',
              is_error: true,
            };
          }
          if (isCommandBlocked(command)) {
            return { tool_call_id: callId, content: `BLOCKED: destructive command not allowed: ${command}`, is_error: true };
          }
          const limit = execOptions.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
          try {
            const result = await execOptions.sandboxExecutorSession.execute(command, limit);
            const output = result.output.length > 8000
              ? `...[sandbox output tail]\n${result.output.slice(-8000)}`
              : result.output;
            if (result.outputLimitExceeded) {
              return {
                tool_call_id: callId,
                content: `OUTCOME_UNKNOWN_DO_NOT_RETRY: command hit the output ceiling after it may have modified the workspace\n${output}`,
                is_error: true,
                fatal: 'execution_outcome_unknown',
              };
            }
            if (result.timedOut) {
              return {
                tool_call_id: callId,
                content: `OUTCOME_UNKNOWN_DO_NOT_RETRY: command timed out after it may have modified the workspace\n${output}`,
                is_error: true,
                fatal: 'execution_outcome_unknown',
              };
            }
            return { tool_call_id: callId, content: output || '(no output, exit 0)', is_error: false };
          } catch (err) {
            if (err instanceof SandboxOutcomeUnknownError) {
              return {
                tool_call_id: callId,
                content: `OUTCOME_UNKNOWN_DO_NOT_RETRY: ${err.message}`,
                is_error: true,
                fatal: 'execution_outcome_unknown',
              };
            }
            throw err;
          }
        }

        if (isCommandBlocked(command)) {
          return { tool_call_id: callId, content: `BLOCKED: destructive command not allowed: ${command}`, is_error: true };
        }

        try {
          const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
            cwd,
            timeout: execOptions?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
            maxBuffer: 1024 * 512,
            env: buildBashToolEnv(),
          });
          const output = stdout + (stderr ? `\n[stderr] ${stderr}` : '');
          // 출력이 너무 길면 잘라냄
          return {
            tool_call_id: callId,
            content: output.length > 8000 ? output.slice(0, 8000) + '\n... (truncated)' : output || '(no output, exit 0)',
            is_error: false,
          };
        } catch (err) {
          if (isMissingExecutable(err)) {
            return {
              tool_call_id: callId,
              content: 'bash is not installed or not available in PATH. Install bash or use a different approach.',
              is_error: true,
            };
          }
          const execErr = err as { code?: number; stderr?: string; stdout?: string; killed?: boolean };
          const exitCode = execErr.code ?? 1;
          const stderrText = execErr.stderr ?? '';
          const stdoutText = execErr.stdout ?? '';
          const combined = [stdoutText, stderrText].filter(Boolean).join('\n').slice(0, 4000);
          const killed = execErr.killed ? ' (timed out)' : '';
          return {
            tool_call_id: callId,
            content: `Command exited with code ${exitCode}${killed}:\n${combined || '(no output)'}`,
            is_error: true,
          };
        }
      }

      case 'write_file': {
        const filePath = validatePath(args.path, cwd);
        if (isProtectedPath(filePath, execOptions?.protectedFiles)) {
          return {
            tool_call_id: callId,
            content: `PROTECTED: ${args.path} is part of the verification harness and must not be modified. ` +
              `If tests fail, the cause is in the SOURCE code (or your fix) — debug from the test output instead.`,
            is_error: true,
          };
        }
        await atomicWriteFile(filePath, args.content);
        invalidateCache(cache, filePath);
        return { tool_call_id: callId, content: `Written: ${filePath}`, is_error: false };
      }

      case 'edit_file': {
        const filePath = validatePath(args.path, cwd);
        if (isProtectedPath(filePath, execOptions?.protectedFiles)) {
          return {
            tool_call_id: callId,
            content: `PROTECTED: ${args.path} is part of the verification harness and must not be modified. ` +
              `If tests fail, the cause is in the SOURCE code (or your fix) — debug from the test output instead.`,
            is_error: true,
          };
        }
        const original = await fs.readFile(filePath, 'utf8');
        const oldString = args.old_string;
        const newString = args.new_string;

        // Try exact match first
        const idx = original.indexOf(oldString);
        if (idx !== -1) {
          const result = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
          await atomicWriteFile(filePath, result);
          invalidateCache(cache, filePath);
          return { tool_call_id: callId, content: `Edited: ${filePath}`, is_error: false };
        }

        // Fuzzy fallback
        const span = findFuzzyEditSpan(original, oldString);
        if (span) {
          const result = original.slice(0, span.start) + newString + original.slice(span.end);
          await atomicWriteFile(filePath, result);
          invalidateCache(cache, filePath);
          return { tool_call_id: callId, content: `Edited: ${filePath} (fuzzy match)`, is_error: false };
        }

        return {
          tool_call_id: callId,
          content: `EDIT_FAILED: old_string not found in ${filePath}. ` +
            `The old_string must match the file content exactly. ` +
            `Use read_file to check the current content and retry with an exact match.`,
          is_error: true,
        };
      }

      case 'apply_patch': {
        const filePath = validatePath(args.path, cwd);
        if (isProtectedPath(filePath, execOptions?.protectedFiles)) {
          return {
            tool_call_id: callId,
            content: `PROTECTED: ${args.path} is part of the verification harness and must not be modified. ` +
              `If tests fail, the cause is in the SOURCE code (or your fix) — debug from the test output instead.`,
            is_error: true,
          };
        }
        const original = await fs.readFile(filePath, 'utf8');
        const patched = applyV4APatch(original, args.patch);
        if (patched === null) {
          return {
            tool_call_id: callId,
            content: 'PATCH_FAILED: Could not apply patch. The patch may be malformed or not match the file content.',
            is_error: true,
          };
        }
        await atomicWriteFile(filePath, patched);
        invalidateCache(cache, filePath);
        return { tool_call_id: callId, content: `Patched: ${filePath}`, is_error: false };
      }

      case 'web_fetch': {
        const url = args.url;
        const result = await webFetch(url);
        return { tool_call_id: callId, content: result, is_error: false };
      }

      case 'web_search': {
        const query = args.query;
        const maxResults = args.max_results;
        const result = await webSearch(query, maxResults);
        return { tool_call_id: callId, content: result, is_error: false };
      }

      case 'diagnostics': {
        const { runDiagnosticsTool } = await import('./diagnosticsTool.js');
        const result = await runDiagnosticsTool(args.paths, cwd);
        return { tool_call_id: callId, content: result, is_error: false };
      }

      default:
        if (isMcpTool(name)) {
          const result = await callMcpTool(name, args);
          return { tool_call_id: callId, content: result.content ?? '', is_error: result.isError ?? false };
        }
        return {
          tool_call_id: callId,
          content: `UNKNOWN_TOOL: ${name} is not a recognized tool. Available tools: ${TOOL_DEFINITIONS.map(t => t.function.name).join(', ')}`,
          is_error: true,
        };
    }
  } catch (err) {
    return {
      tool_call_id: callId,
      content: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/**
 * Check if a file path is protected (part of the verification harness).
 */
function isProtectedPath(filePath: string, protectedFiles?: Set<string>): boolean {
  if (!protectedFiles) return false;
  return protectedFiles.has(filePath);
}

/**
 * Canonicalize a path: resolve symlinks if the path exists, otherwise
 * resolve the longest existing prefix and append the remainder.
 */
function canonicalizePath(resolved: string): string {
  try {
    return realpathSync(resolved);
  } catch {
    // Walk up until we find an existing ancestor
    const parts = resolved.split(path.sep);
    for (let i = parts.length; i > 0; i--) {
      const candidate = parts.slice(0, i).join(path.sep) || '/';
      try {
        const real = realpathSync(candidate);
        return path.join(real, ...parts.slice(i));
      } catch {
        continue;
      }
    }
    return resolved;
  }
}

interface ValidatePathOptions {
  allowMainCheckoutRead?: boolean;
  allowWarehouseRead?: boolean;
}

/**
 * Execute multiple tool calls concurrently.
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  cwd: string,
  execOptions?: ToolExecOptions,
): Promise<ToolResult[]> {
  const cache = createReadCache();
  const readOnlyTools = new Set(['read_file', 'search_files', 'search_memory', 'web_fetch', 'web_search']);
  const results = await Promise.all(
    toolCalls.map((tc) => {
      // read-only tools share a cache; write tools invalidate it
      if (readOnlyTools.has(tc.function.name)) {
        return executeTool(tc, cwd, cache, execOptions);
      }
      return executeTool(tc, cwd, undefined, execOptions);
    }),
  );
  return results;
}