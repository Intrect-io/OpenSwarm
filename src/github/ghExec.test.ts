// ============================================
// OpenSwarm - gh subprocess robustness tests
// ============================================
//
// Two failure modes that only show up under load, both re-reported by three
// consecutive audit runs:
//
//  1. commentOnPR pipes the body through gh's stdin. If gh exits before
//     draining the pipe, the stream emits 'error' (EPIPE). Node rethrows an
//     unhandled 'error' event as an uncaught exception, and it arrives
//     asynchronously — so the function's own try/catch cannot catch it and the
//     process dies instead of logging a failed comment.
//  2. Six gh readers called execFileAsync directly, inheriting Node's 1MB
//     maxBuffer default rather than the 4MB ghExec uses. A PR with a long
//     review thread overflows it and the call fails with
//     ERR_CHILD_PROCESS_STDOUT_MAXBUFFER.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));

import {
  checkPRConflicts,
  commentOnPR,
  getMergedPRsOrThrow,
  getOpenPRs,
  getPRBaseBranch,
  getPRComments,
  getPRMergeability,
  getPRReviewComments,
  getPRReviews,
} from './github.js';

/** Options object handed to execFileAsync for the Nth gh invocation. */
function optionsOfCall(index = 0): { maxBuffer?: number } | undefined {
  const args = execFileMock.mock.calls[index];
  return args?.find((a: unknown) => a !== null && typeof a === 'object' && !Array.isArray(a)) as
    | { maxBuffer?: number }
    | undefined;
}

function mockGhStdout(value: string): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, value, '');
  });
}

describe('gh readers use the shared maxBuffer', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  // 1MB is Node's default — i.e. the option was never passed. These readers pull
  // whole review threads and comment bodies, which is exactly the payload that
  // outgrows it.
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ['getOpenPRs', () => getOpenPRs('owner/repo'), '[]'],
    ['getPRReviews', () => getPRReviews('owner/repo', 1), ''],
    ['getPRReviewComments', () => getPRReviewComments('owner/repo', 1), ''],
    ['getPRComments', () => getPRComments('owner/repo', 1), '{"comments":[]}'],
    ['getPRBaseBranch', () => getPRBaseBranch('owner/repo', 1), '{"baseRefName":"main"}'],
    ['checkPRConflicts', () => checkPRConflicts('owner/repo', 1), '{"mergeable":"MERGEABLE"}'],
  ];

  for (const [name, call, stdout] of cases) {
    it(`${name} raises maxBuffer above Node's 1MB default`, async () => {
      mockGhStdout(stdout);
      await call();
      expect(optionsOfCall()?.maxBuffer).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    });
  }
});

describe('post-merge GitHub state (AGT-4078)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.each(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const)(
    'preserves the %s mergeability state',
    async (mergeable) => {
      mockGhStdout(JSON.stringify({ mergeable }));
      await expect(getPRMergeability('owner/repo', 1)).resolves.toBe(mergeable);
    },
  );

  it('reads merged PR identities in one strict listing', async () => {
    mockGhStdout(JSON.stringify([{
      number: 7,
      headRefName: 'swarm/task-7',
      baseRefName: 'main',
      headRefOid: 'head-7',
      mergedAt: '2026-08-30T00:00:00.000Z',
      mergeCommit: { oid: 'merge-7' },
    }]));

    await expect(getMergedPRsOrThrow('owner/repo')).resolves.toEqual([{
      repo: 'owner/repo',
      number: 7,
      state: 'MERGED',
      branch: 'swarm/task-7',
      baseBranch: 'main',
      headOid: 'head-7',
      mergedAt: '2026-08-30T00:00:00.000Z',
      mergeCommitOid: 'merge-7',
    }]);
  });
});

describe('commentOnPR stdin handling', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  function mockGhProcess() {
    const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    proc.stdin = new PassThrough();
    spawnMock.mockReturnValueOnce(proc);
    return proc;
  }

  it('resolves when gh exits cleanly', async () => {
    const proc = mockGhProcess();
    const done = commentOnPR('owner/repo', 1, 'hello');
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  // The regression itself: an 'error' on stdin with no listener is an uncaught
  // exception, not a rejected promise, so awaiting commentOnPR would not
  // observe it — the process would go down. Asserting via the process-level
  // uncaughtException path is what makes this test fail when the listener is
  // removed; a plain `await expect(...)` would pass either way.
  it('survives EPIPE when gh exits before reading stdin', async () => {
    const proc = mockGhProcess();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const done = commentOnPR('owner/repo', 1, 'hello');
      proc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      proc.emit('close', 1);
      await done;
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught).toEqual([]);
  });

  it('logs rather than throwing when gh exits non-zero', async () => {
    const proc = mockGhProcess();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done = commentOnPR('owner/repo', 1, 'hello');
    proc.emit('close', 1);
    await expect(done).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
