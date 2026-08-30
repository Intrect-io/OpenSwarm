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

export { terminateCliProcessTree } from './processTree.js';

/**
 * Spawn a CLI process using the given adapter and options.
 * Handles: temp file write, argv-safe spawn, timeout/SIGKILL,
 * stdout/stderr buffering, stream parsing via onLog, cleanup.
 */
export async function spawnCli(
  adapter: CliAdapter,
  requestedOptions: CliRunOptions,
): Promise<CliRunResult> {
  const strictHumanSurfaceBoundary = isHumanSurfaceReadOnlyEnabled();
  if (
    strictHumanSurfaceBoundary
    && (!adapter.run || adapter.capabilities.enforcesHumanSurfaceReadOnly !== true)
  ) {
    const reason = adapter.run
      ? 'does not declare enforcement of the strict human-surface boundary'
      : 'delegates to an external CLI with its own tool loop';
    throw new Error(
      `HUMAN_SURFACE_READ_ONLY: Adapter '${adapter.name}' ${reason}; `
      + 'arbitrary program execution is disabled while humanSurfaceReadOnly.enabled is true. '
      + 'Use a native OpenSwarm-loop adapter.',
    );
  }
  const options: CliRunOptions = strictHumanSurfaceBoundary
    ? { ...requestedOptions, shellTools: false, diagnosticsTool: false }
    : requestedOptions;
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

  // The caller's timeout is a wall-clock budget for the whole adapter run,
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

  // Below this line the adapter runs its own tool loop inside its own CLI, so
  // anything OpenSwarm assembles for *our* loop is dropped. Silence there is
  // how a configured MCP grant or an `ask_human` escape hatch turns into an
  // agent that quietly never had it — say it out loud instead.
  if (options.mcpTools?.length || options.coordinationContext) {
    const dropped = [
      options.mcpTools?.length ? `${options.mcpTools.length} MCP tool(s)` : '',
      options.coordinationContext ? 'coordination tools' : '',
    ].filter(Boolean).join(' and ');
    console.warn(
      `[Adapter] '${adapter.name}' delegates to its own CLI tool loop; ${dropped} will not be available to this run. `
      + `Use an adapter that runs OpenSwarm's loop (codex-responses, cc-router, gpt, openrouter, atlascloud, lmstudio, local) if they are required.`,
    );
  }
  if (options.shellTools === false) {
    throw new Error(
      `Adapter '${adapter.name}' delegates to its own CLI and cannot withhold shell access; refusing to run an agent that requires it. `
      + `Use an adapter that runs OpenSwarm's tool loop instead.`,
    );
  }

  // The prompt goes in a private per-call directory rather than a predictable
  // path in the shared /tmp. Three things were wrong with
  // `/tmp/openswarm-prompt-${Date.now()}.txt`:
  //   - Millisecond resolution. Workers run in parallel, so two spawnCli calls
  //     landing in the same millisecond overwrote each other's prompt — and the
  //     path is what gets handed to the CLI, so one agent ran the other's task.
  //   - Default file mode, leaving the prompt readable by every local user.
  //   - A predictable name in a world-writable directory, which another local
  //     user can pre-create as a symlink before the write lands.
  // mkdtemp answers all three at once: a unique 0700 directory, created
  // atomically by the OS.
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
      // the event handled.
      proc.stdin?.on('error', (error) => {
        if (options.onLog) options.onLog(`stdin closed before the prompt was written: ${error.message}`);
      });
      if (stdin) proc.stdin?.end(stdin);

      // Register process for tracking if context provided
      if (runOptions.processContext && proc.pid) {
        registerProcess({
          pid: proc.pid,
          taskId: runOptions.processContext.taskId,
          stage: runOptions.processContext.stage,
          model: runOptions.model,
          projectPath: runOptions.cwd,
          spawnedAt: startTime,
          lastActivityAt: startTime,
        }, proc);
      }

      let stdout = '';
      let stderr = '';
      let streamBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (options.onLog && adapter.capabilities.supportsStreaming) {
          streamBuffer = adapter.parseStreamingChunk
            ? adapter.parseStreamingChunk(text, options.onLog, streamBuffer)
            : parseCliStreamChunk(text, options.onLog, streamBuffer);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      let exitDrainTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const cleanupLifecycle = (): void => {
        if (exitDrainTimer) clearTimeout(exitDrainTimer);
        lifecycleController.signal.removeEventListener('abort', onAbort);
        untrackCliProcessTree(proc);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanupLifecycle();
        terminateCliProcessTree(proc);
        const reason = lifecycleController.signal.reason;
        reject(reason instanceof Error ? reason : new Error(`${adapter.name} aborted`));
      };

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanupLifecycle();
        const durationMs = Date.now() - startTime;

        if (options.onLog && adapter.capabilities.supportsStreaming && streamBuffer.trim()) {
          streamBuffer = adapter.parseStreamingChunk
            ? adapter.parseStreamingChunk('\n', options.onLog, streamBuffer)
            : parseCliStreamChunk('\n', options.onLog, streamBuffer);
        }

        if (code !== 0 && code !== null) {
          const stderrSnippet = stderr.slice(0, 500);
          const stdoutSnippet = stdout.slice(0, 300);
          console.error(`[${adapter.name}] CLI exited with code ${code}`);
          console.error(`[${adapter.name}] stderr: ${stderrSnippet || '(empty)'}`);
          console.error(`[${adapter.name}] stdout (first 300): ${stdoutSnippet || '(empty)'}`);
          console.error(`[${adapter.name}] Duration: ${durationMs}ms, CWD: ${options.cwd}`);

          // Non-blocking diagnostic: an OAuth-protected `url=` MCP server in
          // ~/.codex/config.toml makes codex quit with an opaque rmcp AuthRequired
          // error. Surface the real cause here instead of leaving it to be
          // investigated by hand. Additive only — does not affect control flow. (INT-2408)
          const mcpAuthHint = codexMcpAuthHint(`${stderr}\n${stdout}`);
          if (mcpAuthHint) {
            console.warn(`[${adapter.name}] ${mcpAuthHint}`);
          }

          const rateLimitErr = detectRateLimit(stdout, stderr);
          if (rateLimitErr) {
            console.error(`[${adapter.name}] Rate limit detected: ${rateLimitErr.message}`);
            reject(rateLimitErr);
            return;
          }

          // stream-json CLIs (claude -p) leave stderr EMPTY and report the
          // failure in a stdout result event — without this the daemon logs
          // an unactionable "claude CLI failed with code 1: ". (INT-2509)
          const detail = stderrSnippet.trim() || extractStreamJsonError(stdout) || '(no stderr)';
          reject(new Error(`${adapter.name} CLI failed with code ${code}: ${detail.slice(0, 200)}`));
          return;
        }

        resolve({ exitCode: code ?? 0, stdout, stderr, durationMs });
      };

      proc.on('close', (code) => {
        if (settled) return;
        // `close` only proves that the wrapper and its inherited stdio handles
        // are gone. A detached descendant with stdio redirected to /dev/null
        // can still remain in the wrapper's POSIX process group, so tear down
        // that group before reporting a completed stage.
        terminateCliProcessTree(proc);
        finish(code);
      });
      // `close` waits for every inherited stdio descriptor to close. Some CLIs
      // launch MCP/tool grandchildren that briefly retain those descriptors
      // after the direct child has exited, leaving an otherwise-finished stage
      // stuck until its full timeout. `exit` proves the direct executor is done;
      // allow a short drain window, then finalize with the bytes received so far.
      proc.on('exit', (code) => {
        if (settled || exitDrainTimer) return;
        exitDrainTimer = setTimeout(() => {
          if (settled) return;
          // `exit` only proves the wrapper is gone. If `close` still has not
          // arrived, a descendant owns one of its stdio descriptors. Kill the
          // detached group before reporting success so no MCP/native child can
          // outlive a completed OpenSwarm stage.
          terminateCliProcessTree(proc);
          finish(code);
        }, 1_000);
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanupLifecycle();
        reject(new Error(`${adapter.name} spawn error: ${err.message}`));
      });

      if (lifecycleController.signal.aborted) onAbort();
      else lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    cleanupDeadline();
    try {
      // Remove the whole private directory, not just the file inside it.
      if (promptDir) await fs.rm(promptDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    for (const cleanupPath of cleanupPaths) {
      await fs.rm(cleanupPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Pull the failure reason out of stream-json stdout. The claude CLI
 * (--output-format stream-json) exits non-zero with an EMPTY stderr and puts
 * the actual error in a `{"type":"result","is_error":true,...}` event —
 * surface it so failures are actionable. Exported for tests. (INT-2509)
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
