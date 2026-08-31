// ============================================
// OpenSwarm - CLI Exec Prompt Handler
// Execute tasks via the running daemon or locally
// ============================================

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { expandPath } from '../core/config.js';
import { DAEMON_HOST_ENV, daemonAuthHeaders, daemonBaseUrl, daemonHost, isRemoteDaemon } from './daemonEndpoint.js';

// Types

export interface ExecOptions {
  prompt: string;
  path?: string;
  timeout?: number;
  autoStart?: boolean;
  local?: boolean;
  pipeline?: boolean;
  workerOnly?: boolean;
  model?: string;
  verbose?: boolean;
}

interface ExecTaskResponse {
  taskId: string;
  status: 'queued';
}

interface ExecTaskStatus {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  currentStage?: string;
  result?: {
    success: boolean;
    summary?: string;
    finalStatus?: string;
  };
  error?: string;
}

// Constants

const SERVICE_PORT = 3847;
/** Resolved per call: the host comes from the environment, which a test
 * (or an operator between commands) can change after this module loads. */
const BASE_URL = () => daemonBaseUrl(SERVICE_PORT);
const HEALTH_TIMEOUT_MS = 3000;
const AUTO_START_TIMEOUT_MS = 30000;
/** Submitting a task is a small JSON POST; it should never outlast this. */
const SUBMIT_TIMEOUT_MS = 30000;
const DEFAULT_TASK_TIMEOUT_S = 600;
const POLL_INTERVAL_MS = 3000;
const POLL_REQUEST_TIMEOUT_MS = 5000;

// Helpers

// expandPath imported from core/config.ts

function getProjectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/cli/promptHandler.ts -> ../../ = project root
  return resolve(dirname(thisFile), '..', '..');
}

// Service Health Check

async function checkServiceHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL()}/api/stats`, { headers: daemonAuthHeaders(), signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Auto-Start Service

async function startServiceAuto(): Promise<void> {
  // Strategy 1: systemctl --user start
  const systemctlOk = await new Promise<boolean>((resolve) => {
    execFile('systemctl', ['--user', 'start', 'openswarm'], (err) => {
      resolve(!err);
    });
  });

  if (!systemctlOk) {
    // Strategy 2: detached process spawn
    const projectRoot = getProjectRoot();
    const entryPoint = resolve(projectRoot, 'dist', 'index.js');

    if (!existsSync(entryPoint)) {
      console.error(`Error: dist/index.js not found at ${projectRoot}`);
      console.error('Build the project first: npm run build');
      process.exit(1);
    }

    const child = spawn('node', [entryPoint], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  // Poll for readiness
  const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await checkServiceHealth()) return;
  }

  console.error('Error: Service failed to start within 30 seconds.');
  process.exit(1);
}

// Task Submission

async function submitTask(opts: ExecOptions, projectPath: string): Promise<ExecTaskResponse> {
  const body = {
    prompt: opts.prompt,
    projectPath,
    pipeline: opts.pipeline,
    workerOnly: opts.workerOnly,
    model: opts.model,
    verbose: opts.verbose,
  };

  // The only daemon call here without a bound. Over loopback that rarely bit;
  // over a network it hangs forever with no way out (caught by openswarm pr
  // review, not self-caught).
  const res = await fetch(`${BASE_URL()}/api/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...daemonAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: Failed to submit task (HTTP ${res.status}): ${text}`);
    process.exit(1);
  }

  return (await res.json()) as ExecTaskResponse;
}

// Task Polling

async function pollForResult(taskId: string, timeoutS: number): Promise<ExecTaskStatus> {
  const deadline = Date.now() + timeoutS * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(POLL_REQUEST_TIMEOUT_MS, remainingMs),
      );
      try {
        const res = await fetch(`${BASE_URL()}/api/exec/${taskId}`, { headers: daemonAuthHeaders(), signal: controller.signal });
        if (!res.ok) continue;

        const status = (await res.json()) as ExecTaskStatus;
        if (status.status === 'completed' || status.status === 'failed') {
          return status;
        }

        // Show progress
        if (status.currentStage) {
          process.stdout.write(`\r  ~ ${status.currentStage}...`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network error, retry
    }
  }

  // Timeout
  return { taskId, status: 'failed', error: 'Timeout' };
}

// Local Execution

async function executeLocal(opts: ExecOptions, projectPath: string): Promise<void> {
  const { runCli } = await import('../runners/cliRunner.js');
  await runCli({
    task: opts.prompt,
    projectPath,
    model: opts.model,
    pipeline: opts.pipeline,
    workerOnly: opts.workerOnly,
    verbose: opts.verbose,
  });
}

// Main Entry Point

export async function executePrompt(opts: ExecOptions): Promise<void> {
  const projectPath = expandPath(opts.path ?? process.cwd(), true);

  if (!existsSync(projectPath)) {
    console.error(`Error: Project path does not exist: ${projectPath}`);
    process.exit(1);
  }

  // Local mode: skip daemon entirely
  if (opts.local) {
    await executeLocal(opts, projectPath);
    return;
  }

  // Daemon mode
  const autoStart = opts.autoStart !== false; // default true
  const timeoutS = opts.timeout ?? DEFAULT_TASK_TIMEOUT_S;

  // 1. Health check
  const healthy = await checkServiceHealth();

  if (!healthy) {
    // startServiceAuto() only ever starts a daemon on THIS machine. When
    // OPENSWARM_DAEMON_HOST points somewhere else, doing that would spawn a
    // daemon nobody asked for and then poll the remote host for 30s anyway,
    // so the unreachable remote is reported instead (caught by openswarm
    // review, not self-caught).
    if (isRemoteDaemon()) {
      console.error(`Error: no OpenSwarm daemon answered at ${daemonHost()}:${SERVICE_PORT}.`);
      console.error('Auto-start only applies to a local daemon — start it on that host, '
        + `or unset ${DAEMON_HOST_ENV} to use this machine.`);
      process.exit(1);
    }
    if (!autoStart) {
      console.error('Error: Service is not running. Use --auto-start or start it manually.');
      process.exit(1);
    }

    console.log('  Service not running. Starting...');
    await startServiceAuto();
    console.log('  Service started.');
  }

  // 2. Submit task
  const { taskId } = await submitTask(opts, projectPath);
  console.log(`  Task submitted: ${taskId}`);
  console.log(`  Timeout: ${timeoutS}s`);
  console.log('');

  // 3. Poll for result
  const result = await pollForResult(taskId, timeoutS);
  process.stdout.write('\r' + ' '.repeat(60) + '\r'); // Clear progress line

  // 4. Output result
  if (result.status === 'completed' && result.result) {
    const r = result.result;
    console.log('');
    console.log('  ======================================');
    console.log(`  Result: ${(r.finalStatus ?? 'COMPLETED').toUpperCase()}`);
    console.log('  ======================================');
    if (r.summary) {
      console.log(`  Summary: ${r.summary}`);
    }
    console.log('');
    process.exit(r.success ? 0 : 1);
  } else if (result.error === 'Timeout') {
    console.error(`\n  Error: Task timed out after ${timeoutS}s`);
    process.exit(2);
  } else {
    console.error(`\n  Error: Task failed`);
    if (result.error) {
      console.error(`  ${result.error}`);
    }
    process.exit(1);
  }
}
