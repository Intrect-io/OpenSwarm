// ============================================
// OpenSwarm - !dev progress timer lifecycle tests
// ============================================
//
// handleDev arms a 10s timer from the progress callback and awaits
// dev.runDevTask. The call had no try/catch, so a rejection propagated out with
// the timer still scheduled: ten seconds after the user was told the task
// failed, a stale "in progress" reply arrived quoting output from the run that
// had already ended.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  vi.useFakeTimers();
  devMock.resolveRepoPath.mockReturnValue('/repo');
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('handleDev progress timer', () => {
  // The regression. Without the finally, the armed timer survives the rejection
  // and fires after the caller has already surfaced the error.
  it('does not post progress after the task rejects', async () => {
    devMock.runDevTask.mockImplementation(async (_repo, _task, _user, onProgress) => {
      onProgress('partial output that never completed');
      throw new Error('worker died');
    });
    const msg = makeMessage();

    await expect(handleDev(msg as never, ['myrepo'])).rejects.toThrow('worker died');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(msg.replies.some((r) => r.includes('partial output that never completed'))).toBe(false);
  });

  it('does not post progress after the task completes', async () => {
    devMock.runDevTask.mockImplementation(async (_repo, _task, _user, onProgress, onComplete) => {
      onProgress('early chunk');
      await onComplete('final output', 0);
      return {};
    });
    const msg = makeMessage();

    await handleDev(msg as never, ['myrepo']);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(msg.replies.some((r) => r.includes('early chunk'))).toBe(false);
    expect(msg.replies.some((r) => r.includes('final output'))).toBe(true);
  });

  // The timer still has a job while the task is genuinely running — the fix
  // must not disable progress reporting altogether.
  it('still posts progress while the task is running', async () => {
    let release!: () => void;
    devMock.runDevTask.mockImplementation(async (_repo, _task, _user, onProgress) => {
      onProgress('live output');
      await new Promise<void>((resolve) => { release = resolve; });
      return {};
    });
    const msg = makeMessage();

    const pending = handleDev(msg as never, ['myrepo']);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(msg.replies.some((r) => r.includes('live output'))).toBe(true);

    release();
    await pending;
  });
});
