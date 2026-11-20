// ============================================
// OpenSwarm - Disk usage logging (AGT-4801)
// ============================================
//
// Two kinds of line:
// - one per verify sandbox at creation and removal, and
// - one daemon-level line every five minutes with the BYTES held by each of
//   the four things that filled the host on 2026-10-20: verify sandboxes,
//   worker worktrees, package caches (uv, npm) and session logs.
//
// Measuring never sits on the verify critical path. Sizes come from `du -sk`
// in a child process with a timeout (a JS walk only when `du` is missing), the
// per-sandbox lines are fire-and-forget, and the periodic line runs from one
// daemon timer, not one per verify slot.

import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { sessionLogDir } from '../support/sessionLog.js';
import { VERIFY_SANDBOX_PATTERN, verifySandboxScratchRoots } from './sandboxSweep.js';

const execFileAsync = promisify(execFile);

/** A `du` over a cold uv cache can take a while; past this the size is reported unknown. */
export const DEFAULT_MEASURE_TIMEOUT_MS = 60_000;
export const DISK_USAGE_INTERVAL_MS = 5 * 60_000;

/** Bytes under `path`; 0 when it does not exist; null when the measurement did not finish. */
export type MeasureBytes = (path: string) => Promise<number | null>;

async function directoryBytes(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path); } catch { return 0; }
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry);
    try {
      const info = await lstat(child);
      if (info.isDirectory()) bytes += await directoryBytes(child);
      else if (info.isFile()) bytes += info.size;
    } catch { /* A concurrent cleanup is expected during a usage sample. */ }
  }
  return bytes;
}

function parseDuKiB(stdout: string | undefined): number | null {
  const match = /^(\d+)\s/.exec(stdout ?? '');
  return match ? Number(match[1]) * 1024 : null;
}

/** `du -sk` in a child process, bounded by `timeoutMs`; the JS walk only when `du` is unavailable. */
export async function measureBytes(path: string, timeoutMs = DEFAULT_MEASURE_TIMEOUT_MS): Promise<number | null> {
  try { await lstat(path); } catch { return 0; }
  try {
    const { stdout } = await execFileAsync('du', ['-sk', path], { timeout: timeoutMs, killSignal: 'SIGKILL' });
    return parseDuKiB(stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    if (failure.code === 'ENOENT') return await directoryBytes(path); // no du on this host
    if (failure.killed) return null; // timed out
    // du exits non-zero when entries vanish mid-walk but still prints the total.
    return parseDuKiB(failure.stdout);
  }
}

const formatBytes = (bytes: number | null): string => (bytes === null ? 'unknown' : String(bytes));

// Sandboxes this process created and has not removed yet, with the size sample
// taken at creation. The removal line reuses that sample: measuring at removal
// would either delay the `rm` or race it.
const liveSandboxes = new Map<string, Promise<number | null>>();

/**
 * Log a verify sandbox's size at creation or removal without waiting for it.
 * The removal line reports the creation-time sample (the clone, which is most
 * of a sandbox) and `live` counts this process's sandboxes, removal included.
 */
export function logVerifySandboxUsage(
  root: string,
  phase: 'create' | 'remove',
  measure: MeasureBytes = measureBytes,
): void {
  const line = (bytes: number | null, live: number) =>
    console.log(`[Verify] sandbox usage phase=${phase} bytes=${formatBytes(bytes)} live=${live} root=${root}`);
  if (phase === 'create') {
    const sample = measure(root).catch(() => null);
    liveSandboxes.set(root, sample);
    const live = liveSandboxes.size;
    void sample.then((bytes) => line(bytes, live));
    return;
  }
  const sample = liveSandboxes.get(root) ?? Promise.resolve(null);
  const live = liveSandboxes.has(root) ? liveSandboxes.size : liveSandboxes.size + 1;
  liveSandboxes.delete(root);
  void sample.then((bytes) => line(bytes, live));
}

export interface DiskUsageSources {
  /** Repositories whose `git worktree list` names the worker worktrees. */
  projectPaths: () => readonly string[];
  /** Where verify sandboxes live; defaults to the temp dir plus the strict executor roots. */
  scratchRoots?: () => readonly string[];
}

export interface DiskUsageSample {
  verifySandboxBytes: number | null;
  verifySandboxes: number;
  workerWorktreeBytes: number | null;
  workerWorktrees: number;
  uvCacheBytes: number | null;
  npmCacheBytes: number | null;
  sessionLogBytes: number | null;
}

export interface DiskUsageDeps {
  measure?: MeasureBytes;
  listWorktrees?: (projectPath: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Every worktree path `git worktree list` reports, the main checkout first. */
async function gitWorktreePaths(projectPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'], { timeout: 30_000 })
    .catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

/** Sum measured sizes one at a time (no I/O storm); unknown if any part is. */
async function sumBytes(paths: readonly string[], measure: MeasureBytes): Promise<number | null> {
  let total: number | null = 0;
  for (const path of paths) {
    const bytes = await measure(path);
    total = total === null || bytes === null ? null : total + bytes;
  }
  return total;
}

export function uvCacheDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.UV_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'uv');
}

export function npmCacheDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.npm_config_cache ?? join(home, '.npm'), '_cacache');
}

export async function sampleDiskUsage(sources: DiskUsageSources, deps: DiskUsageDeps = {}): Promise<DiskUsageSample> {
  const measure = deps.measure ?? measureBytes;
  const listWorktrees = deps.listWorktrees ?? gitWorktreePaths;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();

  const sandboxes: string[] = [];
  for (const root of new Set(sources.scratchRoots?.() ?? verifySandboxScratchRoots())) {
    const names = await readdir(root).catch(() => [] as string[]);
    sandboxes.push(...names.filter((name) => VERIFY_SANDBOX_PATTERN.test(name)).map((name) => join(root, name)));
  }

  const worktrees = new Set<string>();
  for (const project of new Set(sources.projectPaths())) {
    // The first entry is the main checkout; a verify base worktree is counted with the sandboxes.
    for (const path of (await listWorktrees(project)).slice(1)) {
      if (!path.split(sep).some((part) => VERIFY_SANDBOX_PATTERN.test(part))) worktrees.add(path);
    }
  }

  return {
    verifySandboxBytes: await sumBytes(sandboxes, measure),
    verifySandboxes: sandboxes.length,
    workerWorktreeBytes: await sumBytes([...worktrees], measure),
    workerWorktrees: worktrees.size,
    uvCacheBytes: await measure(uvCacheDir(env, home)),
    npmCacheBytes: await measure(npmCacheDir(env, home)),
    sessionLogBytes: await measure(env.OPENSWARM_SESSION_LOG_DIR ?? sessionLogDir()),
  };
}

export function formatDiskUsage(sample: DiskUsageSample): string {
  return `[Verify] disk usage period=5m`
    + ` verify_sandbox_bytes=${formatBytes(sample.verifySandboxBytes)} verify_sandboxes=${sample.verifySandboxes}`
    + ` worker_worktree_bytes=${formatBytes(sample.workerWorktreeBytes)} worker_worktrees=${sample.workerWorktrees}`
    + ` uv_cache_bytes=${formatBytes(sample.uvCacheBytes)} npm_cache_bytes=${formatBytes(sample.npmCacheBytes)}`
    + ` session_log_bytes=${formatBytes(sample.sessionLogBytes)}`;
}

export async function logPeriodicDiskUsage(sources: DiskUsageSources, deps: DiskUsageDeps = {}): Promise<void> {
  console.log(formatDiskUsage(await sampleDiskUsage(sources, deps)));
}

/**
 * Start the one daemon-level disk usage line: a sample now, then every
 * `intervalMs`. A tick is skipped while the previous sample is still running.
 * Returns the stop function; the timer never keeps the process alive.
 */
export function startDiskUsageMonitor(
  sources: DiskUsageSources,
  options: { intervalMs?: number; deps?: DiskUsageDeps } = {},
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    logPeriodicDiskUsage(sources, options.deps)
      .catch((error) => console.warn(`[Verify] disk usage sample failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? DISK_USAGE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
