import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

const lockDir = mkdtempSync(join(tmpdir(), 'openswarm-mem-lock-'));
process.env.OPENSWARM_MEMORY_MUTATION_LOCK = join(lockDir, 'mutation.lock');

const { withMemoryWriteRetry } = await import('./memoryCore.js');

// withMemoryWriteRetry wraps Lance writes so `openswarm review --max` (up to 16
// concurrent reviewer processes sharing one on-disk table) survives Lance's
// optimistic-concurrency conflicts instead of surfacing "Too many concurrent
// writers".
//
// Real timers, deliberately: each attempt now also takes a cross-process file
// lock, whose acquisition is real fs I/O. Fake timers drain the backoff queue
// before that I/O settles, so the next backoff timer is armed after the drain
// has already finished and the test hangs. The sleeps are ~25ms + jitter.
describe('withMemoryWriteRetry (INT-2817 store-path concurrency)', () => {
  afterAll(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the result without retrying when the write succeeds', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withMemoryWriteRetry(op, 'test')).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on a concurrent-writer conflict and then succeeds', async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('lance error: Too many concurrent writers.'))
      .mockRejectedValueOnce(new Error('Commit conflict: version conflict detected'))
      .mockResolvedValue('stored');
    await expect(withMemoryWriteRetry(op, 'test')).resolves.toBe('stored');
    expect(op).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('rethrows a non-retryable error immediately (no retry)', async () => {
    const op = vi.fn().mockRejectedValue(new Error('schema mismatch: column not found'));
    await expect(withMemoryWriteRetry(op, 'test')).rejects.toThrow('schema mismatch');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap when the conflict never clears', async () => {
    const op = vi.fn().mockRejectedValue(new Error('Too many concurrent writers.'));
    await expect(withMemoryWriteRetry(op, 'test')).rejects.toThrow('concurrent writers');
    expect(op).toHaveBeenCalledTimes(8); // MAX_ATTEMPTS
  }, 30_000);

  it('releases the mutation lock when an attempt fails, so the next writer can proceed', async () => {
    // A lock leaked on the error path would wedge every later memory write
    // until the lock timed out (120s); the next retry has to be able to take it.
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('Commit conflict: version conflict detected'))
      .mockResolvedValue('stored');
    await expect(withMemoryWriteRetry(op, 'test')).resolves.toBe('stored');
    expect(op).toHaveBeenCalledTimes(2);
  }, 30_000);
});
