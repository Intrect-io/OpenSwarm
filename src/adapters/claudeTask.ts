// ============================================
// OpenSwarm - one-shot `claude -p` task runner
// ============================================
//
// The scheduler and the Discord dev command used to spawn `claude` by hand,
// each with its own flags: no pinned model (INT-2509 — the operator's personal
// default can be the most expensive tier), no MCP isolation, the prompt in
// argv, and a kill that reached only the direct child. They now go through
// spawnCli with the regular adapter, which already owns temp-file stdin,
// process-group teardown, the wall-clock deadline, and setting/env isolation.

import { spawnCli } from './base.js';
import { ClaudeCliAdapter } from './claude.js';
import { extractResultFromStreamJson } from '../agents/cliStreamParser.js';

export interface ClaudeTaskOptions {
  prompt: string;
  cwd: string;
  /** Wall-clock budget; the process group is killed when it runs out. */
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Readable lines parsed from the stream-json output, as they arrive. */
  onLog?: (line: string) => void;
  /** Environment the child starts from (defaults to the daemon's env). */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ClaudeTaskResult {
  success: boolean;
  /** Raw stream-json stdout ('' when the run failed before producing any). */
  stdout: string;
  /** The final `result` text, or '' when there was none. */
  resultText: string;
  error?: string;
}

/** The terminal `result` event reports a failure even when the CLI exits 0. */
function streamJsonReportsError(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; is_error?: boolean; subtype?: string; result?: unknown };
      if (event.type !== 'result') continue;
      if (event.is_error || (event.subtype && event.subtype !== 'success')) {
        return typeof event.result === 'string' && event.result.trim() ? event.result : String(event.subtype ?? 'error');
      }
    } catch {
      // A truncated line is not a verdict.
    }
  }
  return undefined;
}

export async function runClaudeTask(options: ClaudeTaskOptions): Promise<ClaudeTaskResult> {
  try {
    const raw = await spawnCli(new ClaudeCliAdapter(), {
      prompt: options.prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      model: options.model,
      maxTurns: options.maxTurns,
      signal: options.signal,
      onLog: options.onLog,
      baseEnv: options.baseEnv,
      // A one-shot task has no OpenSwarm memory scope to write into.
      memoryTools: false,
    });
    const resultText = extractResultFromStreamJson(raw.stdout) ?? '';
    const reported = streamJsonReportsError(raw.stdout);
    return {
      success: raw.exitCode === 0 && !reported,
      stdout: raw.stdout,
      resultText,
      error: reported,
    };
  } catch (error) {
    return {
      success: false,
      stdout: '',
      resultText: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
