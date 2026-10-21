// ============================================
// OpenSwarm - Worker dependency setup step (AGT-4798)
// ============================================
//
// The worker's shell runs with loopback-only network (AGT-4798) and no
// credentials (AGT-4783). Most runs need nothing more: worktrees share the
// project's installed dependencies through sharedPaths, and measured on
// cgf-portal and OpenSwarm the test suites run offline. A project that does
// need an install step declares it as `projectAgents[].setup`; those commands
// run here once, before the worker's loop, with the network open but still
// inside the sandbox and still without credentials. A failed setup ends the
// run before any model call: a worker started on a broken environment spends
// its turns discovering that.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWorkerShellEnv } from '../adapters/workerEnv.js';
import { workerWritableRoots, wrapForSandbox } from '../support/osSandbox.js';
import type { PipelineResult } from './pairPipeline.js';

const execFileAsync = promisify(execFile);

/** Upper bound for one setup command; a cold `uv sync` or `npm ci` fits. */
export const WORKER_SETUP_TIMEOUT_MS = 10 * 60_000;

export interface WorkerSetupOptions {
  /** `autonomous.workerSandbox`; `on` without a sandbox backend refuses, like the bash tool. */
  sandbox?: 'on' | 'off';
  timeoutMs?: number;
}

export type WorkerSetupResult =
  | { ok: true; ran: number }
  | { ok: false; command: string; detail: string };

function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/** Run the project's declared setup commands in the worktree, in order, stopping at the first failure. */
export async function runWorkerSetup(
  commands: readonly string[] | undefined,
  cwd: string,
  options: WorkerSetupOptions = {},
): Promise<WorkerSetupResult> {
  const steps = (commands ?? []).map((command) => command.trim()).filter(Boolean);
  const sandbox = options.sandbox ?? 'on';
  for (const command of steps) {
    const fenced = sandbox === 'on'
      ? wrapForSandbox(['bash', '-c', command], { writableRoots: workerWritableRoots(cwd), allowNetwork: true })
      : null;
    if (sandbox === 'on' && !fenced) {
      return {
        ok: false,
        command,
        detail: 'autonomous.workerSandbox is "on" but this host has neither sandbox-exec nor bwrap; '
          + 'set autonomous.workerSandbox: off to run setup unfenced on purpose',
      };
    }
    try {
      await execFileAsync(fenced?.file ?? 'bash', fenced?.args ?? ['-c', command], {
        cwd,
        env: buildWorkerShellEnv(),
        timeout: options.timeoutMs ?? WORKER_SETUP_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8,
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      const reason = err.killed ? 'timed out' : tail(output) || err.message || 'failed';
      return { ok: false, command, detail: reason };
    }
  }
  return { ok: true, ran: steps.length };
}

/**
 * The pipeline result for a run whose setup failed, or undefined when setup
 * succeeded or there was none. Called before the worker's loop: installs need
 * the network the worker's shell no longer has. The caller's cleanup removes
 * the (clean) worktree.
 */
export async function setupFailureBeforeWorker(
  commands: readonly string[] | undefined,
  cwd: string,
  sandbox?: 'on' | 'off',
): Promise<PipelineResult | undefined> {
  if (!commands?.length) return undefined;
  const setup = await runWorkerSetup(commands, cwd, { sandbox });
  if (setup.ok) return undefined;
  return {
    success: false,
    sessionId: `worker-setup-fail-${Date.now()}`,
    iterations: 0,
    totalDuration: 0,
    finalStatus: 'infra_error',
    failureDetail: `worker setup \`${setup.command}\` failed: ${setup.detail}`,
    stages: [],
  };
}
