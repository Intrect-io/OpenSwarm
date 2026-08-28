// ============================================
// OpenSwarm — Isolate spawned codex runs from inherited MCP servers (AGT-3990)
// ============================================
//
// `codex exec` loads external MCP configuration from user, project, and system
// layers, while installed plugins contribute a second tool/MCP surface.
// OpenSwarm must disable both before adding only the servers it requested.
// Parsing config.toml ourselves is not equivalent: valid TOML inline tables and
// future config forms bypass a hand-written table-header regex.

import { spawn } from 'node:child_process';
import {
  prepareCliProcessTreeSpawn,
  terminateCliProcessTree,
  trackCliProcessTree,
  untrackCliProcessTree,
} from './processTree.js';

/** Set to any non-empty value to let spawned codex runs keep inherited MCP servers. */
const INHERIT_ENV = 'OPENSWARM_CODEX_INHERIT_MCP';

interface CodexMcpListEntry {
  name?: unknown;
}

export type CodexMcpListRunner = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<string>;

const MCP_LIST_TIMEOUT_MS = 5_000;
const MCP_LIST_MAX_BYTES = 2 * 1024 * 1024;

export function runCodexMcpListJson(
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs: number = MCP_LIST_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cliSpawn = prepareCliProcessTreeSpawn('codex', ['mcp', 'list', '--json'], env);
    const proc = spawn(cliSpawn.command, cliSpawn.args, {
      cwd,
      env: cliSpawn.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackCliProcessTree(proc);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      untrackCliProcessTree(proc);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateCliProcessTree(proc);
      reject(error);
    };
    const onAbort = (): void => {
      const reason = signal?.reason;
      fail(reason instanceof Error ? reason : new Error('Codex MCP enumeration aborted'));
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MCP_LIST_MAX_BYTES) {
        fail(new Error('Codex MCP enumeration exceeded the 2 MiB output limit'));
        return;
      }
      // Preserve raw bytes until the stream ends. Decoding each chunk on its
      // own corrupts a multibyte MCP name split at an arbitrary pipe boundary,
      // which can leave the real inherited server enabled under another key.
      if (target === 'stdout') stdoutChunks.push(chunk);
      else stderrChunks.push(chunk);
    };

    proc.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    proc.once('error', (error) => fail(new Error(`Codex MCP enumeration spawn failed: ${error.message}`)));
    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        reject(new Error(
          `codex mcp list exited with code ${code}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
        ));
      }
    });

    timer = setTimeout(() => {
      fail(new Error(`codex mcp list timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultListRunner: CodexMcpListRunner = (cwd, env, signal) =>
  runCodexMcpListJson(cwd, env, signal);

/** Quote a server name that is not a TOML bare key, so the `-c` path still parses. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Ask Codex for the effective server list instead of approximating its config
 * merger. This includes user/project/system settings and inline TOML. Failure is
 * fail-closed: launching `exec` without knowing what to disable recreates the
 * hang this guard exists to stop.
 */
export async function configuredCodexMcpServerNames(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  list: CodexMcpListRunner = defaultListRunner,
  signal?: AbortSignal,
): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await list(cwd, env, signal));
  } catch (error) {
    // Preserve the enclosing adapter deadline/cancellation. Wrapping it as an
    // MCP-enumeration failure hides the actual wall-clock contract from users.
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error('Codex MCP enumeration aborted');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to enumerate inherited Codex MCP servers: ${detail}. ` +
      `Upgrade Codex or set ${INHERIT_ENV}=1 to explicitly accept inherited MCP configuration.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to enumerate inherited Codex MCP servers: `codex mcp list --json` returned a non-array result.');
  }
  const names = new Set<string>();
  for (const entry of parsed as CodexMcpListEntry[]) {
    if (typeof entry?.name !== 'string') {
      throw new Error('Unable to enumerate inherited Codex MCP servers: a server entry has no string name.');
    }
    // Preserve the exact TOML key. Leading/trailing (or even all) whitespace is
    // valid and changes the server identity; trimming would leave it enabled.
    names.add(entry.name);
  }
  return [...names].sort();
}

/**
 * CLI overrides switching off every inherited MCP server. OpenSwarm may append
 * its own explicit server configuration afterward. The escape hatch is checked
 * before enumeration so older Codex versions remain usable only by deliberate
 * opt-in, never by silently weakening isolation.
 */
export async function codexUserMcpDisableArgs(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  list: CodexMcpListRunner = defaultListRunner,
  signal?: AbortSignal,
): Promise<string[]> {
  if (env[INHERIT_ENV]?.trim()) return [];
  const names = await configuredCodexMcpServerNames(cwd, env, list, signal);
  // Codex's dotted-path override parser does not interpret quoted path segments:
  // `mcp_servers."my.server".enabled=false` creates a different, invalid key.
  // One inline-table override preserves arbitrary TOML keys while merging each
  // enabled=false into the effective server definitions.
  const mcpArgs = names.length === 0
    ? []
    : ['-c', `mcp_servers={${names.map((name) => `${tomlKey(name)}={enabled=false}`).join(',')}}`];
  // Plugin MCP servers do not appear in `codex mcp list`, and per-plugin
  // `plugins.<id>.enabled=false` is not a runtime control. Use Codex's supported
  // feature flag to remove the entire inherited plugin surface for this run.
  return ['--disable', 'plugins', ...mcpArgs];
}
