import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkRepoHealth, loadCIState, saveCIState, getFailedJobLogs, needsReminder,
  createIssue, broadcastEvent, execFileMock,
} = vi.hoisted(() => ({
  checkRepoHealth: vi.fn(),
  loadCIState: vi.fn(),
  saveCIState: vi.fn(),
  getFailedJobLogs: vi.fn(),
  needsReminder: vi.fn(),
  createIssue: vi.fn(),
  broadcastEvent: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('../github/github.js', () => ({
  checkRepoHealth, loadCIState, saveCIState, getFailedJobLogs, needsReminder,
}));
vi.mock('../linear/linear.js', () => ({ createIssue }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import {
  CIWorker,
  MIN_CI_CHECK_INTERVAL_MS,
  getCIWorkerStatus,
  startCIWorker,
  stopCIWorker,
  validateCIWorkerInterval,
} from './ciWorker.js';

/** Reach private members without widening the class surface just for tests. */
interface Internal {
  config: Record<string, unknown>;
  processing: boolean;
  checkCI(): Promise<void>;
  handleTransition(t: unknown): Promise<void>;
  investigateFailure(repo: string, f: unknown): Promise<void>;
  analyzeFailure(logs: string, f: unknown): Promise<{ type: string; confidence: number; reason: string; suggestion?: string }>;
  retryRun(repo: string, runId: number): Promise<void>;
  createFailureIssue(repo: string, f: unknown, logs: string, a: unknown): Promise<void>;
  handlePersistentFailure(h: unknown): Promise<void>;
  closeRelatedIssues(repo: string, resolved?: unknown[]): Promise<void>;
}

function internal(worker: CIWorker): Internal {
  return worker as unknown as Internal;
}

function failure(overrides: Record<string, unknown> = {}) {
  return {
    runId: 42,
    workflow: 'CI Pipeline',
    branch: 'main',
    url: 'https://github.com/o/r/actions/runs/42',
    createdAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return { repo: 'o/r', status: 'broken', activeFailures: [], ...overrides };
}

describe('validateCIWorkerInterval', () => {
  it('accepts the default and minimum interval', () => {
    expect(validateCIWorkerInterval(undefined)).toBe(300_000);
    expect(validateCIWorkerInterval(MIN_CI_CHECK_INTERVAL_MS)).toBe(MIN_CI_CHECK_INTERVAL_MS);
  });

  it.each([NaN, Infinity, -1, 0, 999, 1000.5])('rejects invalid interval %s', (value) => {
    expect(() => validateCIWorkerInterval(value)).toThrow(/checkIntervalMs/);
  });
});

describe('CIWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadCIState.mockResolvedValue({ repos: {} });
    saveCIState.mockResolvedValue(undefined);
    needsReminder.mockReturnValue(false);
    checkRepoHealth.mockResolvedValue({ health: health(), transition: undefined });
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) => {
      cb(null, { stdout: '', stderr: '' });
    });
  });

  afterEach(() => {
    stopCIWorker();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('construction and lifecycle', () => {
    it('applies documented defaults', () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      expect(internal(worker).config).toMatchObject({
        checkIntervalMs: 300_000, autoRetry: false, createIssues: true, maxAgeDays: 30,
      });
    });

    it('rejects an out-of-range interval at construction time', () => {
      expect(() => new CIWorker({ repos: ['o/r'], checkIntervalMs: 10 })).toThrow(RangeError);
    });

    it('runs one check immediately and then on the interval', async () => {
      vi.useFakeTimers();
      const worker = new CIWorker({ repos: ['o/r'], checkIntervalMs: 1_000 });

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadCIState).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(loadCIState).toHaveBeenCalledTimes(2);

      worker.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(loadCIState).toHaveBeenCalledTimes(2);
    });

    it('ignores a second start and a stop with nothing running', async () => {
      vi.useFakeTimers();
      const worker = new CIWorker({ repos: ['o/r'], checkIntervalMs: 1_000 });

      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(1_000);
      // A duplicate interval would double every tick.
      expect(loadCIState).toHaveBeenCalledTimes(2);

      worker.stop();
      expect(() => worker.stop()).not.toThrow();
    });

    it('survives a rejected check from both the immediate run and the interval', async () => {
      vi.useFakeTimers();
      loadCIState.mockRejectedValue(new Error('state unreadable'));
      const worker = new CIWorker({ repos: ['o/r'], checkIntervalMs: 1_000 });

      worker.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(console.error).toHaveBeenCalled();
      worker.stop();
    });
  });

  describe('checkCI', () => {
    it('persists refreshed health for every repo', async () => {
      const worker = new CIWorker({ repos: ['o/a', 'o/b'], maxAgeDays: 7 });
      checkRepoHealth.mockImplementation(async (repo: string) => ({
        health: health({ repo }), transition: undefined,
      }));

      await internal(worker).checkCI();

      expect(checkRepoHealth).toHaveBeenCalledWith('o/a', undefined, 7);
      expect(saveCIState).toHaveBeenCalledWith({
        repos: { 'o/a': health({ repo: 'o/a' }), 'o/b': health({ repo: 'o/b' }) },
      });
    });

    it('keeps going when one repo throws, and still saves state', async () => {
      const worker = new CIWorker({ repos: ['o/bad', 'o/good'] });
      checkRepoHealth.mockRejectedValueOnce(new Error('gh down'))
        .mockResolvedValueOnce({ health: health({ repo: 'o/good' }), transition: undefined });

      await internal(worker).checkCI();

      expect(console.error).toHaveBeenCalled();
      expect(saveCIState).toHaveBeenCalledWith({ repos: { 'o/good': health({ repo: 'o/good' }) } });
    });

    it('skips a re-entrant check while one is in flight', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      internal(worker).processing = true;

      await internal(worker).checkCI();

      expect(loadCIState).not.toHaveBeenCalled();
    });

    it('clears the in-flight flag even when loading state fails', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      loadCIState.mockRejectedValue(new Error('boom'));

      await expect(internal(worker).checkCI()).rejects.toThrow('boom');
      expect(internal(worker).processing).toBe(false);
    });

    it('stamps a reminder timestamp when a failure has persisted', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      const broken = health({ brokenSince: '2026-07-20T00:00:00.000Z' });
      checkRepoHealth.mockResolvedValue({ health: broken, transition: undefined });
      needsReminder.mockReturnValue(true);

      await internal(worker).checkCI();

      expect(needsReminder).toHaveBeenCalledWith(broken, 24);
      expect((broken as { lastReminder?: string }).lastReminder).toBeTruthy();
    });

    it('routes a reported transition through the transition handler', async () => {
      const worker = new CIWorker({ repos: ['o/r'], createIssues: false });
      checkRepoHealth.mockResolvedValue({
        health: health(),
        transition: { repo: 'o/r', from: 'healthy', to: 'broken', activeFailures: [] },
      });

      await internal(worker).checkCI();

      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'log' }));
    });
  });

  describe('analyzeFailure', () => {
    it('calls timeout/network noise flaky and caps confidence at 0.9', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      const analysis = await internal(worker).analyzeFailure(
        'connection refused\nnetwork error\nrate limit hit\n503 service unavailable', failure(),
      );

      expect(analysis).toMatchObject({ type: 'flaky', suggestion: 'Auto-retry recommended' });
      expect(analysis.confidence).toBeLessThanOrEqual(0.9);
    });

    it('calls assertion/type errors a real failure', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await expect(internal(worker).analyzeFailure('assertion failed: expected 1 but got 2', failure()))
        .resolves.toMatchObject({ type: 'real', suggestion: 'Code fix required' });
    });

    it('returns unknown when nothing matches', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await expect(internal(worker).analyzeFailure('build finished', failure()))
        .resolves.toMatchObject({ type: 'unknown', confidence: 0.5 });
    });

    it('prefers the real classification when both signals tie', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      // One flaky hit and one real hit: flakyScore is not greater, so it must not win.
      await expect(internal(worker).analyzeFailure('timeout\ntest failed', failure()))
        .resolves.toMatchObject({ type: 'real' });
    });
  });

  describe('investigateFailure', () => {
    it('stops early when no logs are available', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      getFailedJobLogs.mockResolvedValue(null);

      await internal(worker).investigateFailure('o/r', failure());

      expect(createIssue).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('retries a flaky run only when auto-retry is enabled', async () => {
      getFailedJobLogs.mockResolvedValue('connection refused\nnetwork error');

      const off = new CIWorker({ repos: ['o/r'], autoRetry: false });
      await internal(off).investigateFailure('o/r', failure());
      expect(execFileMock).not.toHaveBeenCalled();

      const on = new CIWorker({ repos: ['o/r'], autoRetry: true });
      await internal(on).investigateFailure('o/r', failure());
      // The rerun must be bounded so a hung `gh` cannot park the CI worker.
      expect(execFileMock).toHaveBeenCalledWith(
        'gh',
        ['run', 'rerun', '42', '-R', 'o/r', '--failed'],
        expect.objectContaining({ timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }),
        expect.any(Function),
      );
    });

    it('files an issue for a real failure only when issue creation is enabled', async () => {
      getFailedJobLogs.mockResolvedValue('assertion failed');
      createIssue.mockResolvedValue({ identifier: 'INT-1' });

      const off = new CIWorker({ repos: ['o/r'], createIssues: false });
      await internal(off).investigateFailure('o/r', failure());
      expect(createIssue).not.toHaveBeenCalled();

      const on = new CIWorker({ repos: ['o/r'], createIssues: true });
      await internal(on).investigateFailure('o/r', failure());
      expect(createIssue).toHaveBeenCalled();
    });
  });

  describe('handleTransition', () => {
    it('investigates every active failure when CI breaks', async () => {
      const worker = new CIWorker({ repos: ['o/r'], createIssues: true });
      getFailedJobLogs.mockResolvedValue('assertion failed');
      createIssue.mockResolvedValue({ identifier: 'INT-2' });

      await internal(worker).handleTransition({
        repo: 'o/r', from: 'healthy', to: 'broken',
        activeFailures: [failure({ runId: 1 }), failure({ runId: 2 })],
      });

      expect(getFailedJobLogs).toHaveBeenCalledTimes(2);
      expect(broadcastEvent).toHaveBeenCalled();
    });

    it('closes resolved failures when CI recovers', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await internal(worker).handleTransition({
        repo: 'o/r', from: 'broken', to: 'healthy',
        activeFailures: [], resolvedFailures: [failure()],
      });

      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'log' }));
      expect(getFailedJobLogs).not.toHaveBeenCalled();
    });

    it('does nothing for a broken → broken repeat', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await internal(worker).handleTransition({
        repo: 'o/r', from: 'broken', to: 'broken', activeFailures: [failure()],
      });

      expect(broadcastEvent).not.toHaveBeenCalled();
      expect(getFailedJobLogs).not.toHaveBeenCalled();
    });
  });

  describe('retryRun', () => {
    it('logs instead of throwing when the gh call fails', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      execFileMock.mockImplementation((_c: string, _a: string[], cb: (e: unknown) => void) => cb(new Error('gh missing')));

      await expect(internal(worker).retryRun('o/r', 7)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
      expect(broadcastEvent).not.toHaveBeenCalled();
    });
  });

  describe('createFailureIssue', () => {
    it('titles by short repo name and includes only the last 50 log lines', async () => {
      const worker = new CIWorker({ repos: ['owner/repo'] });
      createIssue.mockResolvedValue({ identifier: 'INT-3' });
      const logs = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n');

      await internal(worker).createFailureIssue('owner/repo', failure(), logs, {
        type: 'real', confidence: 0.6, reason: 'Test failures', suggestion: 'Fix the code',
      });

      const [title, description, labels] = createIssue.mock.calls[0];
      expect(title).toBe('CI: repo - CI Pipeline failing on main');
      expect(labels).toEqual(['ci-failure', 'automated']);
      expect(description).toContain('**Confidence**: 60%');
      expect(description).toContain('- **Suggestion**: Fix the code');
      expect(description).toContain('line-59');
      expect(description).not.toContain('line-5\n');
    });

    it('omits the suggestion line when the analysis has none', async () => {
      const worker = new CIWorker({ repos: ['owner/repo'] });
      createIssue.mockResolvedValue({ identifier: 'INT-4' });

      await internal(worker).createFailureIssue('owner/repo', failure(), 'log', {
        type: 'unknown', confidence: 0.5, reason: 'Unclassified',
      });

      expect(createIssue.mock.calls[0][1]).not.toContain('**Suggestion**');
    });

    it('reports an issue-creation error without throwing', async () => {
      const worker = new CIWorker({ repos: ['owner/repo'] });
      createIssue.mockResolvedValue({ error: 'linear rejected it' });

      await expect(internal(worker).createFailureIssue('owner/repo', failure(), 'log', {
        type: 'real', confidence: 0.6, reason: 'Test failures',
      })).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalled();
      expect(broadcastEvent).not.toHaveBeenCalled();
    });
  });

  describe('persistent failure and recovery helpers', () => {
    it('reports how long CI has been broken', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });
      const brokenSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

      await internal(worker).handlePersistentFailure(health({ brokenSince }));

      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ line: expect.stringContaining('3d') }),
      }));
    });

    it('stays silent when the repo has no broken-since stamp', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await internal(worker).handlePersistentFailure(health());

      expect(broadcastEvent).not.toHaveBeenCalled();
    });

    it('returns immediately when nothing was resolved', async () => {
      const worker = new CIWorker({ repos: ['o/r'] });

      await internal(worker).closeRelatedIssues('o/r');
      await internal(worker).closeRelatedIssues('o/r', []);

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('recovered'));
    });
  });

  describe('module-level singleton', () => {
    it('reports status, refuses a duplicate start, and clears on stop', () => {
      vi.useFakeTimers();
      expect(getCIWorkerStatus()).toEqual({ running: false, config: undefined });

      startCIWorker({ repos: ['o/r'], checkIntervalMs: 60_000 });
      const status = getCIWorkerStatus();
      expect(status.running).toBe(true);
      expect(status.config).toMatchObject({ repos: ['o/r'] });

      startCIWorker({ repos: ['o/other'] });
      expect(getCIWorkerStatus().config).toMatchObject({ repos: ['o/r'] });

      stopCIWorker();
      expect(getCIWorkerStatus()).toEqual({ running: false, config: undefined });
      // Stopping twice must stay a no-op.
      expect(() => stopCIWorker()).not.toThrow();
    });
  });
});
