import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDiskUsage,
  logVerifySandboxUsage,
  measureBytes,
  sampleDiskUsage,
  startDiskUsageMonitor,
  type MeasureBytes,
} from './diskUsage.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'osw-disk-usage-')); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('measureBytes (AGT-4801)', () => {
  it('reports bytes from du for a directory and 0 for a missing path', async () => {
    await writeFile(join(root, 'blob'), Buffer.alloc(64 * 1024));
    expect(await measureBytes(root)).toBeGreaterThanOrEqual(64 * 1024);
    expect(await measureBytes(join(root, 'missing'))).toBe(0);
  });
});

describe('logVerifySandboxUsage', () => {
  it('never waits for the measurement and reports the creation sample at removal', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let finish: (bytes: number) => void = () => undefined;
    const measure = vi.fn<MeasureBytes>(() => new Promise((resolve) => { finish = resolve; }));
    const sandbox = join(root, '.openswarm-verify-head-abc');

    expect(logVerifySandboxUsage(sandbox, 'create', measure)).toBeUndefined();
    expect(logVerifySandboxUsage(sandbox, 'remove', measure)).toBeUndefined();
    expect(measure).toHaveBeenCalledTimes(1); // removal does not measure (it would race the rm)
    expect(log).not.toHaveBeenCalled();

    finish(4096);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(String(log.mock.calls[0][0])).toContain('phase=create bytes=4096 live=1');
    expect(String(log.mock.calls[1][0])).toContain('phase=remove bytes=4096 live=1');
  });

  it('reports unknown bytes for a sandbox removed before it was ever sampled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logVerifySandboxUsage(join(root, '.openswarm-verify-head-xyz'), 'remove');
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(String(log.mock.calls[0][0])).toContain('phase=remove bytes=unknown live=1');
  });
});

describe('sampleDiskUsage', () => {
  it('reports bytes for verify sandboxes, worker worktrees, package caches and session logs', async () => {
    const scratch = join(root, 'scratch');
    const strict = join(root, 'work');
    await mkdir(join(scratch, '.openswarm-verify-head-aaa111'), { recursive: true });
    await mkdir(join(strict, '.openswarm-verify-base-bbb222'), { recursive: true });
    await mkdir(join(scratch, 'unrelated'), { recursive: true });
    const home = join(root, 'home');
    const sizes: Record<string, number> = {
      [join(scratch, '.openswarm-verify-head-aaa111')]: 1000,
      [join(strict, '.openswarm-verify-base-bbb222')]: 2000,
      '/repo/worktrees/w1': 300,
      '/repo/worktrees/w2': 400,
      [join(home, '.cache', 'uv')]: 50_000,
      [join(home, '.npm', '_cacache')]: 7_000,
      '/var/log/osw-sessions': 900,
    };
    const measure = vi.fn<MeasureBytes>(async (path) => sizes[path] ?? -1);

    const sample = await sampleDiskUsage(
      { projectPaths: () => ['/repo', '/repo'], scratchRoots: () => [scratch, strict] },
      {
        measure, home, env: { OPENSWARM_SESSION_LOG_DIR: '/var/log/osw-sessions' },
        listWorktrees: async () => [
          '/repo', '/repo/worktrees/w1', join(scratch, '.openswarm-verify-base-ccc333', 'worktree'), '/repo/worktrees/w2',
        ],
      },
    );

    expect(sample).toEqual({
      verifySandboxBytes: 3000, verifySandboxes: 2,
      workerWorktreeBytes: 700, workerWorktrees: 2,
      uvCacheBytes: 50_000, npmCacheBytes: 7_000, sessionLogBytes: 900,
    });
    expect(formatDiskUsage(sample)).toBe('[Verify] disk usage period=5m verify_sandbox_bytes=3000 verify_sandboxes=2'
      + ' worker_worktree_bytes=700 worker_worktrees=2 uv_cache_bytes=50000 npm_cache_bytes=7000 session_log_bytes=900');
  });

  it('reports a category as unknown when any of its measurements timed out', async () => {
    const sample = await sampleDiskUsage(
      { projectPaths: () => ['/repo'], scratchRoots: () => [] },
      { measure: async (path) => (path.endsWith('w1') ? null : 10), listWorktrees: async () => ['/repo', '/repo/w1'], home: root, env: {} },
    );
    expect(sample.workerWorktreeBytes).toBeNull();
    expect(formatDiskUsage(sample)).toContain('worker_worktree_bytes=unknown');
  });
});

describe('startDiskUsageMonitor', () => {
  it('samples once now and once per interval from a single timer, skipping ticks while one is in flight', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pending: Array<() => void> = [];
    const listWorktrees = vi.fn(() => new Promise<string[]>((resolve) => { pending.push(() => resolve([])); }));
    const stop = startDiskUsageMonitor(
      { projectPaths: () => ['/repo'], scratchRoots: () => [] },
      { intervalMs: 1_000, deps: { listWorktrees, measure: async () => 0, home: root, env: {} } },
    );
    expect(listWorktrees).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(listWorktrees).toHaveBeenCalledTimes(1); // the first sample is still running
    pending.shift()!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listWorktrees).toHaveBeenCalledTimes(2);
    stop();
    pending.shift()!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listWorktrees).toHaveBeenCalledTimes(2);
  });
});
