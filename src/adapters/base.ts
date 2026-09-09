// ============================================
// OpenSwarm - CLI Adapter Base
// Shared spawn logic for all CLI adapters
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliAdapter, CliRunOptions, CliRunResult } from './types.js';
import { parseCliStreamChunk } from '../agents/cliStreamParser.js';
import { registerProcess } from './processRegistry.js';
import { buildWorkerEnv } from './envPath.js';
import { detectRateLimit } from './rateLimitError.js';
import { codexMcpAuthHint } from './errorClassification.js';
import { safeConsole as console } from '../support/safeLog.js';
import {
  prepareCliProcessTreeSpawn,
  terminateCliProcessTree,
  trackCliProcessTree,
  untrackCliProcessTree,
} from './processTree.js';
import { raceWithAbort } from './abortRace.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';
import { assertAdapterCanRunUnderHumanSurfaceBoundary } from './humanSurfaceBoundary.js';

export { terminateCliProcessTree } from './processTree.js';

/**
 * Spawn a CLI process using the given adapter and options.
 * Handles: temp file write, argv-safe spawn, timeout/SIGKILL,
 * stdout/stderr buffering, stream parsing via onLog, cleanup.
 */
export async function spawnCli(
  adapter: CliAdapter,
  requestedOptions: CliRunOptions & { timeoutMs?: number; maxBuffer?: number },
): Promise<CliRunResult> {
  const strictHumanSurfaceBoundary = isHumanSurfaceReadOnlyEnabled();
  assertAdapterCanRunUnderHumanSurfaceBoundary(adapter);
  const options: CliRunOptions = strictHumanSurfaceBoundary
    ? { ...requestedOptions, diagnosticsTool: false }
    : requestedOptions;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  const timeout = options.timeoutMs ?? 30000; // 30 seconds default
  // Fail closed before anything runs. `readOnly` is asked for when the input is
  // untrusted, so an adapter that ignores it would hand a full toolset to an
  // agent reading attacker-authored files. Refusing is loud; ignoring is not.
  // (INT-3189)
  if (options.readOnly && !adapter.capabilities.enforcesReadOnly) {
    throw new Error(
      `Adapter '${adapter.name}' cannot enforce read-only mode; refusing to run with full tool access. ` +
        `Use an adapter that declares enforcesReadOnly, or drop the read-only requirement.`,
    );
  }
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    throw reason instanceof Error ? reason : new Error(`${adapter.name} aborted`);
  }

  // The caller's timeout is a wall-clock bound on the entire operation,
  // including asynchronous command construction (Codex enumerates the
  // effective MCP configuration here). Starting it only after buildCommand()
  // let a nominal 1 ms review area spend another 5 seconds in MCP discovery.
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 300000;
  const lifecycleController = new AbortController();
  const timeoutError = new Error(`${adapter.name} timeout after ${timeoutMs}ms`);
  let deadlineTimer: NodeJS.Timeout | null = null;
  const relayCallerAbort = (): void => {
    const reason = options.signal?.reason;
    lifecycleController.abort(reason instanceof Error ? reason : new Error(`${adapter.name} aborted`));
  };
  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => lifecycleController.abort(timeoutError), timeoutMs);
  }
  options.signal?.addEventListener('abort', relayCallerAbort, { once: true });
  if (options.signal?.aborted) relayCallerAbort();
  const runOptions: CliRunOptions = { ...options, signal: lifecycleController.signal };
  const cleanupDeadline = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', relayCallerAbort);
  };

  // 어댑터가 직접 실행을 지원하면 shell spawn 대신 사용
  if (adapter.run) {
    try {
      return await raceWithAbort(
        adapter.run(runOptions),
        lifecycleController.signal,
        `${adapter.name} aborted`,
      );
    } finally {
      cleanupDeadline();
    }
  }

  // Build the command spec (temp file, args, etc.)
  // The temp directory is created inside the try so that a failure partway
  // through — a full filesystem, say — still gets cleaned up. One directory
  // at once: a unique 0700 directory, created atomically by the OS.
  let promptDir: string | undefined;
  let cleanupPaths: string[] = [];

  try {
    promptDir = await fs.mkdtemp(join(tmpdir(), 'openswarm-prompt-'));
    const promptFile = join(promptDir, 'prompt.txt');
    if (lifecycleController.signal.aborted) {
      const reason = lifecycleController.signal.reason;
      throw reason instanceof Error ? reason : new Error(`${adapter.name} aborted`);
    }
    // Inside the try, so a write that fails partway — a full temp filesystem,
    // say — still gets the directory removed rather than leaving a fragment of
    // the prompt behind.
    await fs.writeFile(promptFile, options.prompt, { mode: 0o600 });

    const commandSpec = await raceWithAbort(
      adapter.buildCommand({
        ...runOptions,
        // Pass the temp file path as the prompt so buildCommand can reference it
        prompt: promptFile,
      }),
      lifecycleController.signal,
      `${adapter.name} aborted`,
    );
    if (lifecycleController.signal.aborted) {
      const reason = lifecycleController.signal.reason;
      throw reason instanceof Error ? reason : new Error(`${adapter.name} aborted`);
    }
    const { command, args, stdinFile } = commandSpec;
    cleanupPaths = commandSpec.cleanupPaths ?? [];

    const stdin = stdinFile ? await fs.readFile(stdinFile) : undefined;
    if (lifecycleController.signal.aborted) {
      const reason = lifecycleController.signal.reason;
      throw reason instanceof Error ? reason : new Error(`${adapter.name} aborted`);
    }
    return await new Promise<CliRunResult>((resolve, reject) => {
      const cliSpawn = prepareCliProcessTreeSpawn(command, args, buildWorkerEnv(process.env));
      const proc = spawn(cliSpawn.command, cliSpawn.args, {
        shell: false,
        detached: process.platform !== 'win32',
        cwd: runOptions.cwd,
        // Inject OpenSwarm's bundled node_modules/.bin (gives workers access
        // to `cxt` and other shipped CLIs) without touching the user's shell
        // PATH or ~/.claude/ config.
        env: cliSpawn.env,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer,
      });
      trackCliProcessTree(proc);

      // The stdin 'error' listener is not optional, for the same reason it is
      // not optional in github.ts: if the CLI exits before draining the pipe —
      // a rejected flag, an auth failure, or our own SIGKILL on timeout — the
      // pending write emits EPIPE on the stream, and an 'error' event with no
      // listener is rethrown by Node as an uncaught exception. It arrives
      // asynchronously, so neither the promise nor the caller's try/catch sees
      // it, and `proc.on('error')` below is a different emitter. Every adapter
      // that feeds a prompt file through stdin passes here, so without this one
      // oversized prompt to a CLI that exits early kills the daemon. Reporting
      // is left to 'close', which has the real exit code; this only has to keep
      // the process alive. (INT-2440)
      if (stdin) {
        const stdinStream = proc.stdin;
        if (stdinStream) {
          stdinStream.write(stdin, (writeErr) => {
            if (writeErr && (writeErr as NodeJS.ErrnoException).code !== 'EPIPE') {
              console.error(`[${adapter.name}] stdin write error:`, writeErr);
            }
            stdinStream.end();
          });
          stdinStream.on('error', () => {
            /* EPIPE is expected on early exit — swallow */
          });
        }
      }

      // ---- Output retention with bounded buffer ----
      // Retain stdout/stderr for stream-result parsing and error diagnostics.
      // When maxBuffer is reached, truncation is tracked so parseCliStreamChunk
      // can still extract structured results from the retained prefix.
      const MAX_OUTPUT_BYTES = maxBuffer;
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (!stdoutTruncated) {
          if (stdout.length + text.length > MAX_OUTPUT_BYTES) {
            stdout += text.slice(0, MAX_OUTPUT_BYTES - stdout.length);
            stdoutTruncated = true;
          } else {
            stdout += text;
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (!stderrTruncated) {
          if (stderr.length + text.length > MAX_OUTPUT_BYTES) {
            stderr += text.slice(0, MAX_OUTPUT_BYTES - stderr.length);
            stderrTruncated = true;
          } else {
            stderr += text;
          }
        }
      });

      let exitDrainTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const cleanupLifecycle = (): void => {
        if (exitDrainTimer) clearTimeout(exitDrainTimer);
        lifecycleController.signal.removeEventListener('abort', onAbort);
        untrackCliProcessTree(proc);
      };

      const settle = (result: CliRunResult): void => {
        if (settled) return;
        settled = true;
        cleanupLifecycle();
        resolve(result);
      };

      const onAbort = (): void => {
        if (settled) return;
        // lifecycleController was aborted — terminate the process tree
        terminateCliProcessTree(proc);
        // Drain remaining output for up to 2s so stream parsing can capture
        // any final structured result before settling.
        exitDrainTimer = setTimeout(() => {
          const durationMs = Date.now() - startTime;
          settle({
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            exitCode: null,
            signal: 'SIGTERM',
            durationMs,
            timedOut: lifecycleController.signal.reason === timeoutError,
          });
        }, 2000);
      };
      lifecycleController.signal.addEventListener('abort', onAbort);

      proc.on('error', (err) => {
        if (settled) return;
        cleanupLifecycle();
        reject(err);
      });

      proc.on('close', (exitCode, signal) => {
        if (settled) return;
        cleanupLifecycle();
        const durationMs = Date.now() - startTime;
        settle({
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          exitCode,
          signal,
          durationMs,
          timedOut: lifecycleController.signal.reason === timeoutError,
        });
      });
    });
  } finally {
    // Clean up temp directory
    if (promptDir) {
      try {
        await fs.rm(promptDir, { recursive: true, maxRetries: 3 });
      } catch {
        // best-effort
      }
    }
    for (const p of cleanupPaths) {
      try {
        await fs.rm(p, { recursive: true, maxRetries: 3 });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Extract the first stream-json error result from retained stdout.
 * Stream-json events are newline-delimited. This scans the retained (possibly
 * truncated) stdout for a result event that signals failure. Truncation may
 * lose the tail, but the result event is typically near the end — if it was
 * cut off, the caller falls back to the generic error message. Exported for
 * tests. (INT-2509)
 */
export function extractStreamJsonError(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('"type":"result"')) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev?.type === 'result' && (ev.is_error || (ev.subtype && ev.subtype !== 'success'))) {
        const reason = typeof ev.result === 'string' && ev.result.trim() ? ev.result : ev.subtype;
        return String(reason ?? '').trim();
      }
    } catch {
      // not a JSON line
    }
  }
  return '';
}