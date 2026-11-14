// AGT-4055: the Discord /pair flow calls runWorker/runReviewer directly, so the
// coordination inbox (AGT-4054) was inert there. These tests pin the wiring:
// issue-backed sessions get a board identity keyed like the daemon pipeline,
// hand-typed sessions get none.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const getIssue = vi.fn();

vi.mock('../agents/worker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/worker.js')>()),
  runWorker: (...args: unknown[]) => runWorker(...args),
  formatWorkReport: () => 'work report',
}));

vi.mock('../agents/reviewer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/reviewer.js')>()),
  runReviewer: (...args: unknown[]) => runReviewer(...args),
  formatReviewFeedback: () => 'review feedback',
}));

vi.mock('../linear/index.js', () => ({
  getIssue: (...args: unknown[]) => getIssue(...args),
  getMyIssues: vi.fn(async () => []),
  logPairStart: vi.fn(async () => undefined),
  logPairReview: vi.fn(async () => undefined),
  logPairComplete: vi.fn(async () => undefined),
  logPairFailed: vi.fn(async () => undefined),
  logPairRevision: vi.fn(async () => undefined),
}));

vi.mock('../agents/pairMetrics.js', () => ({
  recordSession: vi.fn(async () => undefined),
  getSummary: vi.fn(),
  getDailyMetrics: vi.fn(),
}));

vi.mock('../agents/pairWebhook.js', () => ({
  isValidWebhookUrl: () => false,
  notifyPairApproved: vi.fn(),
  notifyPairRejected: vi.fn(),
  notifyPairFailed: vi.fn(),
  notifyPairCancelled: vi.fn(),
}));

vi.mock('../support/dev.js', () => ({
  resolveRepoPath: (name: string) => `/tmp/agt4055-${name}`,
}));

const { handlePair, pairCoordinationContext } = await import('./discordPair.js');

function fakeMessage() {
  const thread = { id: 'thread-1', send: vi.fn(async () => undefined), toString: () => '<#thread-1>' };
  const msg = {
    channel: { threads: { create: vi.fn(async () => thread) } },
    reply: vi.fn(async () => undefined),
  };
  return { msg, thread };
}

beforeEach(() => {
  runWorker.mockReset().mockResolvedValue({
    success: true, summary: 'done', filesChanged: ['a.ts'], commands: [], output: '',
  });
  runReviewer.mockReset().mockResolvedValue({ decision: 'approve', feedback: 'ok', issues: [], suggestions: [] });
  getIssue.mockReset();
});

describe('pairCoordinationContext (AGT-4055)', () => {
  it('gives no board identity to a session with no Linear issue behind it', () => {
    expect(pairCoordinationContext({ taskId: 'fix the login bug', projectPath: '/tmp/x' }, 'worker')).toBeUndefined();
  });

  it('keys an issue-backed session by the issue UUID and labels it with the identifier', () => {
    const ctx = pairCoordinationContext(
      { taskId: 'AGT-1', linearIssueId: 'uuid-agt-1', projectPath: '/tmp/agt4055-proj' },
      'worker',
    );
    expect(ctx).toBeDefined();
    expect(ctx?.taskId).toBe('uuid-agt-1');
    expect(ctx?.taskLabel).toBe('AGT-1');
    expect(ctx?.actorRole).toBe('worker');
    expect(ctx?.actor).toBeTruthy();
  });

  it('keeps one handle per role across calls and separates worker from reviewer', () => {
    const session = { taskId: 'AGT-2', linearIssueId: 'uuid-agt-2', projectPath: '/tmp/agt4055-proj' };
    const w1 = pairCoordinationContext(session, 'worker');
    const w2 = pairCoordinationContext(session, 'worker');
    const r = pairCoordinationContext(session, 'reviewer');
    expect(w2?.actor).toBe(w1?.actor);
    expect(r?.actor).not.toBe(w1?.actor);
  });
});

describe('!pair run wiring (AGT-4055)', () => {
  it('passes coordinationContext to both worker and reviewer when the issue resolves', async () => {
    getIssue.mockResolvedValue({ id: 'uuid-agt-3', identifier: 'AGT-3', title: 'T', description: 'D' });
    const { msg } = fakeMessage();
    await handlePair(msg as never, ['run', 'AGT-3', 'proj']);
    await vi.waitFor(() => expect(runReviewer).toHaveBeenCalled());

    const workerCtx = runWorker.mock.calls[0][0].coordinationContext;
    const reviewerCtx = runReviewer.mock.calls[0][0].coordinationContext;
    expect(workerCtx?.taskId).toBe('uuid-agt-3');
    expect(workerCtx?.actorRole).toBe('worker');
    expect(reviewerCtx?.taskId).toBe('uuid-agt-3');
    expect(reviewerCtx?.actorRole).toBe('reviewer');
  });

  it('runs without coordination tools when the Linear lookup finds nothing', async () => {
    getIssue.mockResolvedValue(null);
    const { msg } = fakeMessage();
    await handlePair(msg as never, ['run', 'free-text-task', 'proj']);
    await vi.waitFor(() => expect(runReviewer).toHaveBeenCalled());

    expect(runWorker.mock.calls[0][0].coordinationContext).toBeUndefined();
    expect(runReviewer.mock.calls[0][0].coordinationContext).toBeUndefined();
  });
});
