// ============================================
// OpenSwarm - Long-Running Task Monitor
// Track external long-running tasks (RunPod training, batch processing, etc.)
// ============================================

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  LongRunningMonitorConfig,
  LongRunningMonitor,
  MonitorState,
  CompletionCheck,
} from '../core/types.js';
import { broadcastEvent } from '../core/eventHub.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';

// Constants

const PERSIST_DIR = join(homedir(), '.openswarm');
const PERSIST_FILE = join(PERSIST_DIR, 'openswarm-monitors.json');
const CHECK_TIMEOUT_MS = 30_000; // Individual check command timeout: 30 seconds
const MAX_OUTPUT_PATTERN_LENGTH = 512;
const ALLOWED_OUTPUT_PATTERN_CHARS = /^[\x20-\x7E\t\u00A0-\uFFFF]*$/;

/**
 * Treat configured output patterns as literal strings. This preserves the
 * completion-check shape without evaluating user-supplied regular expressions.
 */
function outputIncludesPattern(stdout: string, pattern: string | undefined): boolean {
  if (!pattern) return false;
  if (pattern.length > MAX_OUTPUT_PATTERN_LENGTH) return false;
  if (!ALLOWED_OUTPUT_PATTERN_CHARS.test(pattern)) return false;
  return stdout.includes(pattern);
}

// Argv validation: reject null bytes, newlines, and other control chars.
// Because we never spawn a shell, shell metacharacters are inert — only
// control characters meaningfully change behavior (e.g. null byte truncation).
// eslint-disable-next-line no-control-regex
const ARGV_SAFE = /^[^\x00-\x1F\x7F]+$/;

// Program allowlist for monitor checks. Anything outside this list — or any
// absolute path outside of the user's own directories — is rejected before
// it reaches `execFile`, so a misconfigured monitor cannot spawn arbitrary
// binaries. Extend `ALLOWED_PROGRAMS` deliberately when a new probe is
// genuinely needed.
const ALLOWED_PROGRAMS = new Set([
  'curl',
  'wget',
  'ssh',
  'jq',
  'grep',
  'awk',
  'sed',
  'cat',
  'tail',
  'head',
  'nvidia-smi',
  'kubectl',
  'docker',
  'podman',
]);

function isAllowedAbsolutePath(program: string): boolean {
  if (!program.startsWith('/') && !program.startsWith('~/')) return false;
  // Resolve `~` via HOME so absolute-path comparisons are meaningful.
  const home = homedir();
  const resolved = program.startsWith('~/') ? home + program.slice(1) : program;
  const allowedPrefixes = [
    '/usr/local/bin/',
    '/usr/local/sbin/',
    '/opt/',
    `${home}/bin/`,
    `${home}/.local/bin/`,
    `${home}/scripts/`,
    `${home}/.openswarm/monitors/`,
  ];
  return allowedPrefixes.some(p => resolved.startsWith(p));
}

function isAllowedProgram(program: string): boolean {
  // Reject anything that could be interpreted as a path-shell construct or
  // contain separators we haven't validated.
  if (program.includes('..')) return false;
  // Bare program name (no slash) → must appear in the allowlist. We look it
  // up via PATH at exec time, which is the standard behaviour.
  if (!program.includes('/')) return ALLOWED_PROGRAMS.has(program);
  // Otherwise it must be an absolute path (or `~/...`) into a known location.
  return isAllowedAbsolutePath(program);
}

function isValidArgv(argv: unknown): argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (!argv.every(a => typeof a === 'string' && a.length > 0 && a.length <= 4096 && ARGV_SAFE.test(a))) {
    return false;
  }
  return isAllowedProgram(argv[0] as string);
}

// State

const monitors = new Map<string, LongRunningMonitor>();

// Persistence

interface PersistedData {
  monitors: LongRunningMonitor[];
  updatedAt: string;
}

function loadFromDisk(): void {
  try {
    if (!existsSync(PERSIST_FILE)) return;
    const data = JSON.parse(readFileSync(PERSIST_FILE, 'utf-8')) as PersistedData;
    let skippedLegacy = 0;
    for (const m of data.monitors) {
      if (m.state !== 'pending' && m.state !== 'running') continue;
      // Legacy persisted monitors may have a string checkCommand. Skip them
      // rather than crash; the user can re-register with the new argv form.
      if (!isValidArgv(m.checkCommand)) {
        skippedLegacy++;
        continue;
      }
      monitors.set(m.id, m);
    }
    if (monitors.size > 0) {
      console.log(`[Monitor] Restored ${monitors.size} monitors from disk`);
    }
    if (skippedLegacy > 0) {
      console.warn(`[Monitor] Skipped ${skippedLegacy} legacy monitor(s) with string checkCommand — please re-register with argv arrays`);
    }
  } catch (err) {
    console.warn('[Monitor] Failed to load persisted monitors:', err);
  }
}

function saveToDisk(): void {
  try {
    const active = Array.from(monitors.values()).filter(
      m => m.state === 'pending' || m.state === 'running'
    );
    const data: PersistedData = {
      monitors: active,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(PERSIST_FILE, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    console.warn('[Monitor] Failed to save monitors to disk:', err);
  }
}

// Check Execution

function executeCheck(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (!isValidArgv(argv)) {
      resolve({ exitCode: 1, stdout: '', stderr: 'invalid checkCommand argv' });
      return;
    }
    const [rawProgram, ...args] = argv;
    // Double-check the program against the allowlist at the call site so the
    // flow into `execFile` cannot receive anything unvetted even if
    // `isValidArgv` were bypassed. The resolved program is always either a
    // bare name from ALLOWED_PROGRAMS or an absolute path under a trusted
    // prefix.
    if (!isAllowedProgram(rawProgram)) {
      resolve({ exitCode: 1, stdout: '', stderr: 'program not in allowlist' });
      return;
    }
    const program = rawProgram;
    // No shell: execFile with shell:false treats program/args as literal
    // tokens. Pipes, redirects, substitutions, and other shell operators
    // in argv are inert because nothing interprets them.
    const proc = execFile(program, args, {
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code !== undefined
          ? (typeof error.code === 'number' ? error.code : 1)
          : proc.exitCode ?? 0,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      });
    });
  });
}

// Result Evaluation

function evaluateResult(
  check: CompletionCheck,
  exitCode: number,
  stdout: string,
): MonitorState {
  switch (check.type) {
    case 'exit-code': {
      const successCode = check.successExitCode ?? 0;
      // exit 0 (or successExitCode) = still running, otherwise = completed
      return exitCode === successCode ? 'running' : 'completed';
    }

    case 'output-regex': {
      if (outputIncludesPattern(stdout, check.failurePattern)) {
        return 'failed';
      }
      if (outputIncludesPattern(stdout, check.successPattern)) {
        return 'completed';
      }
      return 'running';
    }

    case 'http-status': {
      const expected = check.expectedStatus ?? 200;
      // Attempt to extract HTTP status code from stdout
      const statusMatch = stdout.match(/(\d{3})/);
      if (exitCode === 0 && statusMatch && Number(statusMatch[1]) === expected) {
        return 'completed';
      }
      return exitCode === 0 ? 'running' : 'failed';
    }
  }
}

// State Transition Handler

function handleStateTransition(
  monitor: LongRunningMonitor,
  prevState: MonitorState,
): void {
  if (prevState === monitor.state) return;

  console.log(`[Monitor] ${monitor.name}: ${prevState} → ${monitor.state}`);

  broadcastEvent({
    type: 'monitor:stateChange',
    data: {
      id: monitor.id,
      name: monitor.name,
      from: prevState,
      to: monitor.state,
      issueId: monitor.issueId,
    },
  });

  saveToDisk();
}

// Public API

/**
 * Load monitors from config + persisted file at service startup
 */
export function initMonitors(configs?: LongRunningMonitorConfig[]): void {
  // Restore from persisted file first
  loadFromDisk();

  // Register monitors defined in config.yaml (skip if already exists)
  if (configs) {
    for (const cfg of configs) {
      if (!monitors.has(cfg.id)) {
        registerMonitor(cfg);
      }
    }
  }

  console.log(`[Monitor] Initialized with ${monitors.size} monitor(s)`);
}

/**
 * Register a monitor
 */
export function registerMonitor(config: LongRunningMonitorConfig): LongRunningMonitor {
  if (!isValidArgv(config.checkCommand)) {
    throw new Error('registerMonitor: checkCommand must be a non-empty string[] of safe tokens');
  }

  const monitor: LongRunningMonitor = {
    ...config,
    checkInterval: config.checkInterval ?? 1,
    maxDurationHours: config.maxDurationHours ?? 48,
    notify: config.notify ?? true,
    state: 'pending',
    registeredAt: Date.now(),
    checkCount: 0,
    heartbeatsSinceRegister: 0,
  };

  monitors.set(monitor.id, monitor);
  saveToDisk();

  console.log(`[Monitor] Registered: ${monitor.name} (${monitor.id})`);
  broadcastEvent({
    type: 'monitor:stateChange',
    data: { id: monitor.id, name: monitor.name, from: 'pending', to: 'pending', issueId: monitor.issueId },
  });

  return monitor;
}

/**
 * Unregister a monitor
 */
export function unregisterMonitor(id: string): boolean {
  const deleted = monitors.delete(id);
  if (deleted) {
    saveToDisk();
    console.log(`[Monitor] Unregistered: ${id}`);
  }
  return deleted;
}

/**
 * Check all active monitors (called from heartbeat)
 */
export async function checkAllMonitors(): Promise<number> {
  const active = Array.from(monitors.values()).filter(
    m => m.state === 'pending' || m.state === 'running'
  );

  if (active.length === 0) return 0;

  let checkedCount = 0;

  for (const monitor of active) {
    monitor.heartbeatsSinceRegister++;

    // Skip based on checkInterval
    if (monitor.heartbeatsSinceRegister % monitor.checkInterval! !== 0) {
      continue;
    }

    // Timeout check
    const elapsedHours = (Date.now() - monitor.registeredAt) / (1000 * 60 * 60);
    if (elapsedHours > monitor.maxDurationHours!) {
      const prevState = monitor.state;
      monitor.state = 'timeout';
      handleStateTransition(monitor, prevState);
      continue;
    }

    try {
      const result = await executeCheck(monitor.checkCommand);
      const prevState = monitor.state;

      monitor.lastCheckedAt = Date.now();
      monitor.checkCount++;
      monitor.lastOutput = result.stdout.slice(0, 1000); // max 1KB
      monitor.lastExitCode = result.exitCode;

      const newState = evaluateResult(monitor.completionCheck, result.exitCode, result.stdout);

      // Auto-transition pending → running (on first check)
      if (monitor.state === 'pending' && newState === 'running') {
        monitor.state = 'running';
      } else if (newState === 'completed' || newState === 'failed') {
        monitor.state = newState;
      }

      handleStateTransition(monitor, prevState);

      broadcastEvent({
        type: 'monitor:checked',
        data: {
          id: monitor.id,
          name: monitor.name,
          state: monitor.state,
          output: monitor.lastOutput,
          checkCount: monitor.checkCount,
        },
      });

      checkedCount++;
    } catch (err) {
      console.error('[Monitor] Check failed for %s:', monitor.name, err);
    }
  }

  if (checkedCount > 0) {
    saveToDisk();
  }

  return checkedCount;
}

/**
 * Get list of active monitors
 */
export function getActiveMonitors(): LongRunningMonitor[] {
  return Array.from(monitors.values());
}

/**
 * Get a specific monitor by ID
 */
export function getMonitor(id: string): LongRunningMonitor | undefined {
  return monitors.get(id);
}
