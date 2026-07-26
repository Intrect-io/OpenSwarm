// ============================================
// OpenSwarm - !dev progress timer lifecycle tests
// ============================================
//
// handleDev arms a 10s progress timer from a callback. Getting the disarm point
// right is subtle, and the first attempt got it wrong in a way a careless mock
// hid: `runDevTask` registers the child's stdout/close listeners and returns
// `{taskId, path}` *immediately* — it does not await the process. Disarming
// after that await therefore fired before the first chunk arrived and silenced
// progress reporting for the entire run.
//
// So every mock here follows the real contract: return right away, then drive
// onProgress/onComplete afterwards. A mock that blocks until the task finishes
// describes a function this codebase does not have.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProgressCb = (chunk: string) => void;
type CompleteCb = (output: string, exitCode: number | null) => void | Promise<void>;

const devMock = vi.hoisted(() => ({
  resolveRepoPath: vi.fn(() => '/repo'),
  runDevTask: vi.fn(),
  scanDevRepos: vi.fn(() => []),
  listKnownRepos: vi.fn(() => []),
}));

vi.mock('../support/dev.js', () => devMock);

const { handleDev } = await import('./discordHandlers.js');

/** A Discord message stub that records every reply handleDev sends. */
function makeMessage() {
  const replies: string[] = [];
  return {
    replies,
    content: '!dev myrepo "do the thing"',
    author: { username: 'tester', id: 'u1' },
    reply: vi.fn(async (body: unknown) => {
      replies.push(typeof body === 'string' ? body : JSON.stringify(body));
      return { id: 'reply-id' };
    }),
  };
}

/**
 * Stand in for runDevTask's real shape: capture the callbacks, return the task
 * handle immediately, and hand the callbacks back so the test can fire them at
 * the points a live child process would.
 */
function captureCallbacks(): { progress: () => ProgressCb; complete: () => CompleteCb } {
  let onProgress: ProgressCb;
  let onComplete: CompleteCb;
  devMock.runDevTask.mockImplementation(async (_repo, _task, _user, progress, complete) => {
    onProgress = progress;
    onComplete = complete;
    return { taskId: 'task-1', path: '/repo' };
  });
  return { progress: () => onProgress, complete: () => onComplete };
}

beforeEach(() => {
  vi.useFakeTimers();
  devMock.resolveRepoPath.mockReturnValue('/repo');
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('handleDev progress timer', () => {
  // The case the first fix broke. handleDev has already returned by the time
  // the child writes anything, so nothing about its return may silence output.
  it('posts progress for a task that is still running after handleDev returns', async () => {
    const cb = captureCallbacks();
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    cb.progress()('live output');
    await vi.advanceTimersByTimeAsync(11_000);

    expect(msg.replies.some((r) => r.includes('live output'))).toBe(true);
  });

  it('keeps posting progress across several chunks', async () => {
    const cb = captureCallbacks();
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    cb.progress()('first batch');
    await vi.advanceTimersByTimeAsync(11_000);
    cb.progress()('second batch');
    await vi.advanceTimersByTimeAsync(11_000);

    expect(msg.replies.some((r) => r.includes('first batch'))).toBe(true);
    expect(msg.replies.some((r) => r.includes('second batch'))).toBe(true);
  });

  // The original defect: a timer armed just before the task ends still fires
  // afterwards, quoting output the user has already seen the conclusion for.
  it('does not post progress queued before completion', async () => {
    const cb = captureCallbacks();
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    cb.progress()('chunk in flight');
    await cb.complete()('final output', 0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(msg.replies.some((r) => r.includes('chunk in flight'))).toBe(false);
    expect(msg.replies.some((r) => r.includes('final output'))).toBe(true);
  });

  // clearTimeout alone cannot cover this: a chunk that arrives *after*
  // completion arms a brand new timer, and nothing is left to cancel it. stdout
  // can still flush after the child closes, so this is the case the `settled`
  // flag exists for — not the already-armed timer, which clearTimeout handles.
  it('does not post progress from a chunk that arrives after completion', async () => {
    const cb = captureCallbacks();
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    await cb.complete()('final output', 0);
    cb.progress()('late flush from a closed pipe');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(msg.replies.some((r) => r.includes('late flush'))).toBe(false);
  });

  // A spawn failure reaches onComplete with exit code -1 rather than rejecting,
  // so the same disarm has to cover it.
  it('does not post progress after the child fails', async () => {
    const cb = captureCallbacks();
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    cb.progress()('output before the crash');
    await cb.complete()('Error: spawn claude ENOENT', -1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(msg.replies.some((r) => r.includes('output before the crash'))).toBe(false);
  });

  // No child was ever created, so no callback will ever fire — this is the one
  // case that must be disarmed from handleDev's own body.
  it('disarms when the task is rejected before launch', async () => {
    let onProgress!: ProgressCb;
    devMock.runDevTask.mockImplementation(async (_repo, _task, _user, progress) => {
      onProgress = progress;
      progress('leftover from a previous attempt');
      return { error: 'A task is already running for myrepo' };
    });
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);
    onProgress('more leftover');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(msg.replies.some((r) => r.includes('A task is already running'))).toBe(true);
    expect(msg.replies.some((r) => r.includes('leftover'))).toBe(false);
  });

  it('disarms when runDevTask throws before registering the child', async () => {
    devMock.runDevTask.mockImplementation(async (_repo, _task, _user, progress) => {
      progress('partial');
      throw new Error('spawn failed');
    });
    const msg = makeMessage();

    await expect(handleDev(msg as never, ['myrepo'])).rejects.toThrow('spawn failed');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(msg.replies.some((r) => r.includes('partial'))).toBe(false);
  });
});
