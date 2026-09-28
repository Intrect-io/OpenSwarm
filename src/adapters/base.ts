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
import { applyReasoningEffortOverride } from '../support/reasoningEffortOverride.js';
import { createSessionRecorder, type SessionRecorder } from '../support/sessionLog.js';

export { terminateCliProcessTree } from './processTree.js';

/**
 * Byte ceiling on the output kept for ONE stream.
 *
 * The data handlers below used to concatenate every chunk for the whole worker
 * lifetime, so a CLI that is verbose, wedged, or adversarial could hold hundreds
 * of MB in the daemon until its timeout fired — and streaming parsing does not
 * reduce that, it only decides what is logged. 2 MiB is the ceiling this repo
 * already puts on other bytes read from a source we do not control (web fetch
 * bodies, codex MCP enumeration), it is 16x the 128 KiB CLI buffer in
 * automation/scheduler.ts — which was sized for a stderr snippet, not for
 * parseable stdout — and it sits below the 8 MiB session log cap, so two
 * retained streams can never dominate a session record.
 */
export const CLI_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
/** Head room for the truncation marker, so a clipped stream stays under the ceiling. */
const CLI_OUTPUT_MARKER_RESERVE = 128;
const CLI_OUTPUT_KEEP_BYTES = CLI_OUTPUT_MAX_BYTES - CLI_OUTPUT_MARKER_RESERVE;
/**
 * Greppable opener of the marker a clipped stream carries in place of its head.
 *
 * The cut is stated in the data itself, so an operator (or a parser reading the
 * retained text) sees that bytes are missing and how many, rather than inferring
 * it from output that silently never arrived. Kept free of failure phrasings:
 * `isExplicitFailure` scans raw stdout for real failure declarations.
 */
export const CLI_OUTPUT_TRUNCATION_MARKER = '[openswarm-cli-output:';

/** How much of the tail a cut keeps, so the next cut is a megabyte away (below). */
const CLI_OUTPUT_TRIM_BYTES = Math.ceil(CLI_OUTPUT_KEEP_BYTES / 2);

/**
 * A stream's retained tail, its byte length, and the head bytes already dropped.
 * The retained text carries no marker of its own: the drop count lives here so a
 * second cut reports the total, not just the last one.
 */
interface RetainedCliOutput {
  text: string;
  bytes: number;
  droppedBytes: number;
}

/**
 * Append a chunk, keeping only the TAIL once the ceiling is passed.
 *
 * The tail, not the head, because every consumer of a delegated CLI's output
 * reads the terminal event: `extractResultFromStreamJson` (claude stream-json),
 * `extractCodexMessageText` (`messages.at(-1)`), `extractCursorFinalText`,
 * `detectRateLimit`, and `extractStreamJsonError` all need the LAST lines — a
 * head clip would throw away the result event of exactly the verbose runs this
 * bound exists for. Same direction as `tailWithinBytes`
 * (agents/verificationEvidence.ts) and the tail-keeping `appendBounded` in
 * automation/scheduler.ts.
 *
 * A cut keeps half the budget rather than exactly filling it: re-slicing on
 * every chunk after the ceiling would copy 2 MiB per chunk, which a chatty CLI
 * turns into gigabytes of memcpy while it floods the pipe. Each cut therefore
 * buys a full megabyte of appends, and the retained text still never exceeds the
 * ceiling — an append that would cross it is trimmed in the same call.
 */
function appendCliOutput(output: RetainedCliOutput, chunk: string): void {
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  const total = output.bytes + chunkBytes;
  if (total <= CLI_OUTPUT_KEEP_BYTES) {
    output.text += chunk;
    output.bytes = total;
    return;
  }
  // A single chunk can exceed what we keep on its own; then the retained text is
  // going to be discarded entirely, and concatenating it first would be a copy
  // of a payload already known to be thrown away.
  const source = chunkBytes >= CLI_OUTPUT_TRIM_BYTES ? chunk : output.text + chunk;
  // The cut can land mid-character, so the retained length is re-measured rather
  // than assumed. Decoding turns at most a handful of stray UTF-8 bytes into
  // replacement characters (3 bytes each), so the retained text can exceed
  // CLI_OUTPUT_TRIM_BYTES by a few bytes — never by more than
  // CLI_OUTPUT_MARKER_RESERVE, which is why the ceiling itself still holds.
  output.text = Buffer.from(source, 'utf8')
    .subarray(-CLI_OUTPUT_TRIM_BYTES)
    .toString('utf8');
  output.bytes = Buffer.byteLength(output.text, 'utf8');
  output.droppedBytes += total - output.bytes;
}

/** The retained output, preceded by the marker when the head was clipped. */
function renderCliOutput(output: RetainedCliOutput): string {
  return output.droppedBytes > 0
    ? `${CLI_OUTPUT_TRUNCATION_MARKER} ${output.droppedBytes} bytes omitted from the head]\n${output.text}`
    : output.text;
}

/**
 * Spawn a CLI process using the given adapter and options.
 * Handles: temp file write, argv-safe spawn, timeout/SIGKILL,
 * stdout/stderr buffering, stream parsing via onLog, cleanup.
 */
export async function spawnCli(
  adapter: CliAdapter,
  requestedOptions: CliRunOptions,
): Promise<CliRunResult> {
  requestedOptions = applyReasoningEffortOverride(requestedOptions);
  const strictHumanSurfaceBoundary = isHumanSurfaceReadOnlyEnabled();
  assertAdapterCanRunUnderHumanSurfaceBoundary(adapter);
  const options: CliRunOptions = strictHumanSurfaceBoundary
    ? { ...requestedOptions, diagnosticsTool: false }
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
  // agent that quietly never had it — say it out loud instead. The same goes for
  // a role's `tools.allow`/`tools.deny`, and for `protectedFiles` /
  // `forbidPublication`: this path cannot honor any of them (the CLI owns its
  // tools), and a silently inert fence is worse than none. (AGT-4444)
  if (
    options.mcpTools?.length
    || options.coordinationContext
    || options.toolAllow?.length
    || options.toolDeny?.length
    || options.protectedFiles?.length
    || options.forbidPublication
  ) {
    const dropped = [
      options.mcpTools?.length ? `${options.mcpTools.length} MCP tool(s)` : '',
      options.coordinationContext ? 'coordination tools' : '',
      options.toolAllow?.length || options.toolDeny?.length ? 'the role tool allow/deny list' : '',
      options.protectedFiles?.length ? `${options.protectedFiles.length} protected path(s)` : '',
      options.forbidPublication ? 'the publication fence' : '',
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
  // Delegated CLIs own their internal tool loop, so this is deliberately a
  // CLI-level record rather than a misleading per-turn transcript. It still
  // preserves the prompt, raw result, timing, and exit result an operator
  // needs to audit the boundary OpenSwarm actually controls. (AGT-4456)
  let session: SessionRecorder | undefined;

  try {
    session = createSessionRecorder({
      taskId: options.usageAttribution?.taskId ?? options.processContext?.taskId,
      stage: options.usageAttribution?.stage ?? options.processContext?.stage,
      adapter: options.usageAttribution?.adapter ?? adapter.name,
      model: options.model,
      cwd: options.cwd,
      recordingLevel: 'cli',
    });
    session?.record({ type: 'notice', note: 'prompt', prompt: options.prompt });
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

      // Retained only for the final parse and the transcript; bounded per stream
      // so a flooding CLI cannot hold the daemon's memory for its whole run.
      const stdoutOutput: RetainedCliOutput = { text: '', bytes: 0, droppedBytes: 0 };
      const stderrOutput: RetainedCliOutput = { text: '', bytes: 0, droppedBytes: 0 };
      let streamBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        appendCliOutput(stdoutOutput, text);
        if (options.onLog && adapter.capabilities.supportsStreaming) {
          streamBuffer = adapter.parseStreamingChunk
            ? adapter.parseStreamingChunk(text, options.onLog, streamBuffer)
            : parseCliStreamChunk(text, options.onLog, streamBuffer);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        appendCliOutput(stderrOutput, data.toString());
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
        session?.record({ type: 'assistant', rawStdout: renderCliOutput(stdoutOutput), rawStderr: renderCliOutput(stderrOutput) });
        session?.close({
          outcome: 'aborted', durationMs: Date.now() - startTime,
          error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
        });
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

        // Rendered once per settling path: the marker belongs in the transcript
        // and in the returned result, but the retained text itself carries none.
        const stdout = renderCliOutput(stdoutOutput);
        const stderr = renderCliOutput(stderrOutput);

        session?.record({ type: 'assistant', rawStdout: stdout, rawStderr: stderr });
        session?.close({
          outcome: code === 0 || code === null ? 'returned' : 'exit_nonzero',
          exitCode: code,
          durationMs,
        });

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
        session?.close({ outcome: 'spawn_error', durationMs: Date.now() - startTime, error: err.message });
        reject(new Error(`${adapter.name} spawn error: ${err.message}`));
      });

      if (lifecycleController.signal.aborted) onAbort();
      else lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
    });
  } catch (error) {
    session?.close({
      outcome: 'threw', durationMs: Date.now() - startTime,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  } finally {
    session?.close({ outcome: 'threw', durationMs: Date.now() - startTime });
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
