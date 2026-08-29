import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(async () => {
  vi.clearAllMocks();
  const store = await import('./coordinationStore.js'); store.resetCoordinationStoreForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runPeriodicReview', () => {
  it('runs in a linked worktree, where .git is a file rather than a directory', async () => {
    // A lock under `.git` cannot be created when `.git` is a worktree pointer
    // file — the scheduled job then throws instead of running the review.
    dir = mkdtempSync(join(tmpdir(), 'osw-review-worktree-'));
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, '{}', ''));
    const { runPeriodicReview } = await import('./periodicReview.js');

    const result = await runPeriodicReview({ repository: dir, taskId: 'audit', profile: 'hygiene' });
    expect(result?.success).toBe(true);
  });

  it('names the review agent on every event it publishes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-review-name-')); mkdirSync(join(dir, '.git'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, '{}', ''));
    const { runPeriodicReview } = await import('./periodicReview.js');
    await runPeriodicReview({ repository: dir, taskId: 'audit', profile: 'hygiene' });

    const { getCoordinationStore } = await import('./coordinationStore.js');
    const events = getCoordinationStore().list({ limit: 10 });
    expect(events).not.toHaveLength(0);
    // An assigned handle, never the machine-ID shape the operator banned after
    // seeing `→ reviewer-b0bc` on the board (AGT-4064).
    for (const event of events) {
      expect(event.actorName).toBeTruthy();
      expect(event.actorName).not.toMatch(/^(?:worker|reviewer|orchestrator|review-agent)-[0-9a-f]{4,}$/);
      expect(event.actorName).not.toMatch(/ \d+$/);
    }
  });

  it('runs hygiene through deterministic cxt and records lifecycle events', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-review-job-')); mkdirSync(join(dir, '.git'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, '{"issues":[]}', ''));
    const { runPeriodicReview } = await import('./periodicReview.js');
    const result = await runPeriodicReview({ repository: dir, taskId: 'audit', profile: 'hygiene' });
    expect(result?.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('cxt', ['bs', '--json'], expect.objectContaining({ cwd: dir }), expect.any(Function));
  });
});
