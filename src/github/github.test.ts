import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  (fn as any)[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      (fn as any)(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return fn;
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

import { checkPRCIStatus, getActiveFailures, getAllFailedRuns, getPRChecks } from './github.js';

function mockGhJson(value: unknown): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify(value), '');
  });
}

describe('getPRChecks', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('normalizes gh pr checks buckets into CI status and conclusion values', async () => {
    mockGhJson([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail' },
      { name: 'build', state: 'QUEUED', bucket: 'pending' },
      { name: 'docs', state: 'SKIPPED', bucket: 'skipping' },
      { name: 'deploy', state: 'CANCELLED', bucket: 'cancel' },
      { name: 'approval', state: 'ACTION_REQUIRED', bucket: 'action_required' },
    ]);

    await expect(getPRChecks('owner/repo', 42)).resolves.toEqual([
      { name: 'unit', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'pending', conclusion: 'pending' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
      { name: 'deploy', status: 'completed', conclusion: 'cancelled' },
      { name: 'approval', status: 'completed', conclusion: 'action_required' },
    ]);

    expect(execFileMock.mock.calls[0][1]).toContain('name,state,bucket');
  });

  it('reports failed PR CI when gh classifies a check in the fail bucket', async () => {
    mockGhJson([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail' },
    ]);

    await expect(checkPRCIStatus('owner/repo', 42)).resolves.toEqual({
      status: 'failure',
      failedChecks: [{ name: 'lint', conclusion: 'failure' }],
    });
  });

  it('treats every blocking conclusion as a failed PR status', async () => {
    mockGhJson([
      { name: 'cancel', state: 'CANCELLED', bucket: 'cancel' },
      { name: 'approval', state: 'ACTION_REQUIRED', bucket: 'action_required' },
      { name: 'stale', state: 'STALE', bucket: 'stale' },
    ]);
    const result = await checkPRCIStatus('owner/repo', 42);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.failedChecks.map((check) => check.conclusion)).toEqual(['cancelled', 'action_required', 'stale']);
    }
  });
});

describe('repository fan-out', () => {
  it('bounds concurrent gh calls across repositories', async () => {
    execFileMock.mockReset();
    let active = 0;
    let maximum = 0;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
      active++;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        active--;
        callback(null, '[]', '');
      }, 2);
    });
    await getAllFailedRuns(Array.from({ length: 20 }, (_, index) => `owner/repo-${index}`));
    expect(maximum).toBeLessThanOrEqual(5);
  });
});

describe('getActiveFailures', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects failures that would have been beyond the old latest-20 run window', async () => {
    const runs = Array.from({ length: 24 }, (_, i) => ({
      databaseId: i + 1,
      name: 'ci',
      headBranch: `feature-${i}`,
      createdAt: '2026-06-30T00:00:00.000Z',
      conclusion: 'success',
      url: `https://example.test/runs/${i + 1}`,
    }));
    runs.push({
      databaseId: 25,
      name: 'ci',
      headBranch: 'still-failing',
      createdAt: '2026-06-20T00:00:00.000Z',
      conclusion: 'failure',
      url: 'https://example.test/runs/25',
    });
    mockGhJson(runs);

    await expect(getActiveFailures('owner/repo', 30)).resolves.toEqual([
      {
        workflow: 'ci',
        branch: 'still-failing',
        runId: 25,
        url: 'https://example.test/runs/25',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ]);

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('--paginate');
    expect(args).not.toContain('--slurp');
    expect(args).toContain('--jq');
    expect(args).toContain('created=>=2026-06-01');
  });

  it('parses paginated jq output as newline-delimited compact objects', async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
      callback(null, [
        JSON.stringify({ databaseId: 1, name: 'ci', headBranch: 'main', createdAt: '2026-06-30T00:00:00.000Z', conclusion: 'failure', url: 'https://example.test/1' }),
        JSON.stringify({ databaseId: 2, name: 'lint', headBranch: 'main', createdAt: '2026-06-30T00:00:00.000Z', conclusion: 'success', url: 'https://example.test/2' }),
      ].join('\n'), '');
    });

    await expect(getActiveFailures('owner/repo', 30)).resolves.toEqual([
      { workflow: 'ci', branch: 'main', runId: 1, url: 'https://example.test/1', createdAt: '2026-06-30T00:00:00.000Z' },
    ]);
  });

  it('does not log retained child-process stdout on failure', async () => {
    const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      stdout: 'sensitive-and-huge-output',
    });
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
      callback(error, '', '');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getActiveFailures('owner/repo', 30)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      '[GitHub] Failed to get active failures for owner/repo: stdout maxBuffer length exceeded',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-and-huge-output');
    log.mockRestore();
  });

  it('treats every blocking conclusion as an active failure', async () => {
    mockGhJson(['timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].map((conclusion, index) => ({
      databaseId: index + 1, name: `ci-${index}`, headBranch: 'main',
      createdAt: '2026-06-30T00:00:00.000Z', conclusion, url: `https://example.test/${index}`,
    })));
    const failures = await getActiveFailures('owner/repo', 30);
    expect(failures).toHaveLength(5);
  });
});
