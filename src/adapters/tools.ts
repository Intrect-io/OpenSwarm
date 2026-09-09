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
 * so it never sources the user's shell rc files. This means tools like `cxt`
 * (installed via cargo) are not found unless we explicitly add common user paths.
 * We add them here so the agent can use the same tools the developer uses.
 */
const USER_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(homedir(), '.cargo/bin'),
  path.join(homedir(), '.local/bin'),
  path.join(homedir(), '.nix-profile/bin'),
  '/run/current-system/sw/bin',
];

export function buildBashToolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existingPath = base.PATH ?? '';
  const extra = USER_PATHS.filter((p) => !existingPath.includes(p));
  return {
    ...base,
    PATH: [...extra, existingPath].join(':'),
  };
}

// ============================================
// Tool Definitions
// ============================================

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
  id?: string;
};

export type ToolResult = {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
};

// ============================================
// Read Cache
// ============================================

export type ReadCache = Map<string, string>;

export function createReadCache(): ReadCache {
  return new Map();
}

export function cacheGet(cache: ReadCache, key: string): string | undefined {
  return cache.get(key);
}

export function cacheSet(cache: ReadCache, key: string, value: string): void {
  cache.set(key, value);
}

export function invalidateCache(cache: ReadCache | undefined, filePath: string): void {
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith(filePath)) cache.delete(key);
  }
}

// ============================================
// Tool Execution
// ============================================

export type ToolExecOptions = {
  cwd: string;
  readOnly?: boolean;
  protectedFiles?: string[];
  sandboxSession?: SandboxExecutorSession;
  coordinationContext?: CoordinationToolContext;
};

const READ_ONLY_DENIED_TOOLS = new Set([
  'write_file', 'edit_file', 'bash', 'execute_command',
]);

const MAX_READ_FILE_LIMIT = 2000;
const MAX_READ_FILE_OFFSET = 1_000_000;

/** Validate and clamp read_file offset/limit to prevent resource exhaustion. */
function normalizeReadFileOffset(offset: unknown): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset > MAX_READ_FILE_OFFSET) {
    return 0;
  }
  return Math.trunc(offset);
}

function normalizeReadFileLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return 500;
  }
  return Math.min(Math.trunc(limit), MAX_READ_FILE_LIMIT);
}

export async function executeTool(
  call: ToolCall,
  options: ToolExecOptions,
  cache?: ReadCache,
): Promise<ToolResult> {
  const { cwd, readOnly, protectedFiles, sandboxSession, coordinationContext } = options;
  const name = call.name;
  const args = call.input as Record<string, unknown>;
  const callId = call.id ?? `${name}_${Date.now()}`;

  // Read-only guard
  if (readOnly && READ_ONLY_DENIED_TOOLS.has(name)) {
    return {
      tool_call_id: callId,
      content: `READ_ONLY: ${name} is disabled for this run. Use read_file/search_files/search_memory only.`,
      is_error: true,
    };
  }

  switch (name) {
    case 'read_file': {
      // Reads may follow a symlink into this worktree's main checkout, so an
      // agent can reach local-only material the repo links in (AGT-4061).
      // Withheld in readOnly: there `bash` is denied, so this sandbox is the
      // run's real outbound boundary (INT-3189).
      const filePath = validatePath(args.path, cwd, {
        allowMainCheckoutRead: !execOptions?.readOnly,
        allowWarehouseRead: true,
      });
      const offset = normalizeReadFileOffset(args.offset);
      const limit = normalizeReadFileLimit(args.limit);
      const cacheKey = `${filePath}#${offset}:${limit}`;

      // 같은 루프에서 이미 같은 범위를 읽었으면 디스크 재접근 없이 캐시 반환.
      // 모델에게 "변경 없음"을 알려 추가 확인 read를 유도하지 않는다.
      const cached = cache ? cacheGet(cache, cacheKey) : undefined;
      if (cached !== undefined) {
        // Re-read of the same range: return a STUB, not the full content. Re-
        // injecting the content every time is what bloats a read-heavy worker's
        // context (measured: 37 identical reads → 575k tokens). The content is
        // already earlier in the conversation; point the model back to it instead
        // of duplicating it. (Use a different offset to see other parts.)
        return {
          tool_call_id: callId,
          content: `(already read ${args.path} [lines ${offset + 1}-${offset + limit}] earlier this turn-loop — UNCHANGED. Content omitted to save context; use what you already read above. To see other parts, read with a different offset. Otherwise stop reading and act.)`,
          is_error: false,
        };
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
      const truncated = lines.length > offset + limit
        ? `\n... (${lines.length - offset - limit} more lines)`
        : '';
      const result = numbered + truncated;
      if (cache) cacheSet(cache, cacheKey, result);
      return { tool_call_id: callId, content: result, is_error: false };
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

      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteFile(filePath, String(args.content ?? ''), 0o644);
      if (cache) invalidateCache(cache, filePath);
      return {
        tool_call_id: callId,
        content: `Written: ${filePath}`,
        is_error: false,
      };
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

      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      if (!oldString) {
        return { tool_call_id: callId, content: 'old_string is required', is_error: true };
      }
      const original = await fs.readFile(filePath, 'utf-8');
      const occurrences = original.split(args.old_string).length - 1;
      if (occurrences > 1) {
        return { tool_call_id: callId, content: `old_string found ${occurrences} times — must be unique. Provide more context.`, is_error: true };
      }
      // Resolve the exact span to replace. Exact match first; on a miss, fall back
      // to line-normalized fuzzy matching (trailing whitespace / smart quotes /
      // dashes) — but only when it's unique, so we never edit the wrong place. (INT-2011)
      let editStart: number;
      let editEnd: number;
      const exactIdx = original.indexOf(oldString);
      if (exactIdx !== -1) {
        editStart = exactIdx;
        editEnd = exactIdx + oldString.length;
      } else {
        const fuzzy = findFuzzyEditSpan(original, oldString);
        if (!fuzzy) {
          return {
            tool_call_id: callId,
            content: `old_string not found in ${args.path}. Check for exact match including whitespace.`,
            is_error: true,
          };
        }
        editStart = fuzzy.start;
        editEnd = fuzzy.end;
      }

      const result = original.slice(0, editStart) + newString + original.slice(editEnd);
      await atomicWriteFile(filePath, result, 0o644);
      if (cache) invalidateCache(cache, filePath);
      return { tool_call_id: callId, content: `Edited: ${filePath}`, is_error: false };
    }

    case 'bash': {
      const command = String(args.command ?? '');
      const timeout = (args.timeout as number) ?? 30_000;
      const description = String(args.description ?? '');

      // Guard: block dangerous commands
      if (isCommandBlocked(command)) {
        return {
          tool_call_id: callId,
          content: `BLOCKED: Command "${command}" is not allowed.`,
          is_error: true,
        };
      }

      // If a sandbox session is active, delegate to it
      if (sandboxSession) {
        try {
          const result = await sandboxSession.execute(command, { timeout, description });
          return {
            tool_call_id: callId,
            content: result.stdout + (result.stderr ? `\nSTDERR:\n${result.stderr}` : ''),
            is_error: result.exitCode !== 0,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { tool_call_id: callId, content: `Sandbox error: ${msg}`, is_error: true };
        }
      }

      // Fallback: local exec
      try {
        const env = buildBashToolEnv();
        const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: stripHumanSurfaceEnv(env),
        });
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
        return { tool_call_id: callId, content: output, is_error: false };
      } catch (err: any) {
        if (err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return { tool_call_id: callId, content: `Command timed out after ${timeout}ms`, is_error: true };
        }
        return {
          tool_call_id: callId,
          content: `Exit code ${err.code ?? 'unknown'}: ${err.stderr ?? err.message ?? String(err)}`,
          is_error: true,
        };
      }
    }

    case 'search_files': {
      const pattern = String(args.pattern ?? '');
      const searchPath = args.path ? String(args.path) : cwd;
      const glob = args.glob ? String(args.glob) : undefined;

      if (!pattern) {
        return { tool_call_id: callId, content: 'pattern is required', is_error: true };
      }

      try {
        const { execSync } = await import('node:child_process');
        const globArg = glob ? ` -g "${glob.replace(/"/g, '\\"')}"` : '';
        const result = execSync(
          `rg -n ${pattern.includes(' ') ? '"' + pattern.replace(/"/g, '\\"') + '"' : pattern} "${searchPath.replace(/"/g, '\\"')}"${globArg} 2>/dev/null || true`,
          { cwd, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
        );
        const output = result.trim() || 'No matches found.';
        return { tool_call_id: callId, content: output, is_error: false };
      } catch {
        return { tool_call_id: callId, content: 'No matches found.', is_error: false };
      }
    }

    case 'search_memory': {
      // Delegate to the memory search tool
      const query = String(args.query ?? '');
      const limit = Number(args.limit) || 5;
      if (!query) {
        return { tool_call_id: callId, content: 'query is required', is_error: true };
      }
      try {
        const { searchMemory } = await import('./tools.js');
        const results = await searchMemory(query, limit);
        return { tool_call_id: callId, content: JSON.stringify(results, null, 2), is_error: false };
      } catch (err) {
        return { tool_call_id: callId, content: `search_memory error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    case 'web_fetch': {
      const url = String(args.url ?? '');
      if (!url) {
        return { tool_call_id: callId, content: 'url is required', is_error: true };
      }
      try {
        const text = await webFetch(url);
        return { tool_call_id: callId, content: text, is_error: false };
      } catch (err) {
        return { tool_call_id: callId, content: `web_fetch error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    case 'web_search': {
      const query = String(args.query ?? '');
      if (!query) {
        return { tool_call_id: callId, content: 'query is required', is_error: true };
      }
      try {
        const results = await webSearch(query);
        return { tool_call_id: callId, content: JSON.stringify(results, null, 2), is_error: false };
      } catch (err) {
        return { tool_call_id: callId, content: `web_search error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }

    default: {
      // Coordination tools
      if (COORDINATION_TOOL_NAMES.has(name) && coordinationContext) {
        return executeCoordinationTool(name, args, coordinationContext);
      }

      // MCP tools
      if (isMcpTool(name)) {
        try {
          const result = await callMcpTool(name, args);
          return { tool_call_id: callId, content: JSON.stringify(result, null, 2), is_error: false };
        } catch (err) {
          return { tool_call_id: callId, content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
        }
      }

      return { tool_call_id: callId, content: `Unknown tool: ${name}`, is_error: true };
    }
  }
}

// ============================================
// Path Validation
// ============================================

export interface ValidatePathOptions {
  /**
   * Allow reads that resolve to the linked main checkout of this worktree.
   *
   * A worktree's `.venv`, `.env`, and other local-only assets are symlinked
   * from the main checkout. Without this flag, validatePath rejects them as
   * outside the worktree root, which breaks the agent's ability to read them.
   *
   * This is intentionally NOT allowed for write operations — only reads. The
   * write path (write_file / edit_file) always rejects paths outside the
   * worktree, preserving worktree isolation — the exact failure
   * `link-local-assets.sh` documents for `.venv`, where a guard test kept
   * passing because the import resolved through the main tree instead of the
   * worktree under test.
   *
   * Callers must additionally withhold this for `readOnly` runs. An ordinary
   * worker can already reach the main checkout through the unvalidated `bash`
   * tool, so there this is a usability fix, not a widening. A read-only
   * reviewer has `bash` denied (READ_ONLY_DENIED_TOOLS), which makes this
   * sandbox its real outbound boundary — INT-3189 — and it stays untouched.
   */
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
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  if (inside(projectRoot)) return canonical;

  // Allow reads that resolve to the linked main checkout
  if (options.allowMainCheckoutRead) {
    try {
      const mainCheckout = linkedMainCheckoutOf(projectRoot);
      if (mainCheckout && inside(mainCheckout)) return canonical;
    } catch {
      // Not a worktree or no main checkout — fall through to reject
    }
  }

  // Allow reads from the warehouse root
  if (options.allowWarehouseRead) {
    const warehouseRoot = '/warehouse';
    if (inside(warehouseRoot)) return canonical;
  }

  throw new Error(`Path "${filePath}" resolves outside the project root (${projectRoot})`);
}

function canonicalizePath(p: string): string {
  // Resolve symlinks for existing paths, but don't fail on non-existent
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isProtectedPath(filePath: string, protectedFiles?: string[]): boolean {
  if (!protectedFiles || protectedFiles.length === 0) return false;
  return protectedFiles.some((p) => filePath === path.resolve(p));
}

// ============================================
// Command Guard
// ============================================

function normalizeForGuard(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function hasMidWordSubstitution(command: string): boolean {
  // Detect patterns like `rm${something}rf` or `cur${x} -f`
  return /\$\{[^}]+\}/.test(command);
}

function isCommandBlocked(command: string): boolean {
  const normalized = normalizeForGuard(command);
  const lower = normalized.toLowerCase();

  // Block destructive commands
  const destructive = [
    /^rm\s+-rf\s+\//, /^rm\s+--recursive/, /^rm\s+-r\s+\//,
    /^git\s+reset\s+--hard/, /^git\s+checkout\s+--\s*\./,
    /^drop\s+database/, /^truncate\s+table/,
    /^chmod\s+777/, /^chmod\s+777\s/,
  ];
  for (const pattern of destructive) {
    if (pattern.test(lower)) return true;
  }

  // Block mid-word substitution (obfuscation attempt)
  if (hasMidWordSubstitution(command)) return true;

  return false;
}

// ============================================
// Fuzzy Edit Span
// ============================================

function normalizeEditLine(line: string): string {
  return line
    .replace(/\s+$/, '')           // trailing whitespace
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/[\u201c\u201d]/g, '"') // smart double quotes
    .replace(/[\u2013\u2014]/g, '--') // en/em dashes
    .replace(/\t/g, '  ');          // tabs to spaces
}

/**
 * Find the start/end character offsets of a fuzzy match of oldString within
 * original. Uses line-normalized comparison (trailing whitespace, smart quotes,
 * dashes) rather than editing the wrong place. The span is line-bounded, so the offsets are
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
      if (normFile[i + j] !== normOld[j]) { ok = false; break; }
    }
    if (ok) {
      matchIndex = i;
      count++;
    }
  }
  if (matchIndex === -1 || count !== 1) return null;

  // Convert line index to character offset
  let start = 0;
  for (let i = 0; i < matchIndex; i++) {
    start += fileLines[i].length + 1; // +1 for newline
  }
  let end = start;
  for (let i = 0; i < oldLines.length; i++) {
    end += fileLines[matchIndex + i].length + 1;
  }
  return { start, end };
}

// ============================================
// Memory Search (placeholder)
// ============================================

async function searchMemory(query: string, limit: number): Promise<unknown[]> {
  // Placeholder — actual implementation would query the memory store
  return [{ query, limit, note: 'memory search not yet implemented in tools.ts' }];
}