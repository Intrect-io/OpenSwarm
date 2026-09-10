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
// writers". Fake timers skip the real backoff sleeps.
describe('withMemoryWriteRetry (INT-2817 store-path concurrency)', () => {
  afterAll(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the result without retrying when the write succeeds', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withMemoryWriteRetry(op, 'test')).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on a concurrent-writer conflict and then succeeds', async () => {
    vi.useFakeTimers();
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('lance error: Too many concurrent writers.'))
      .mockRejectedValueOnce(new Error('Commit conflict: version conflict detected'))
      .mockResolvedValue('stored');
    const p = withMemoryWriteRetry(op, 'test');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('stored');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately (no retry)', async () => {
    const op = vi.fn().mockRejectedValue(new Error('schema mismatch: column not found'));
    await expect(withMemoryWriteRetry(op, 'test')).rejects.toThrow('schema mismatch');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap when the conflict never clears', async () => {
    vi.useFakeTimers();
    const op = vi.fn().mockRejectedValue(new Error('Too many concurrent writers.'));
    const p = withMemoryWriteRetry(op, 'test');
    const assertion = expect(p).rejects.toThrow('concurrent writers');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(8); // MAX_ATTEMPTS
  });
});
