// ============================================
// OpenSwarm — the draft survives a restart (AGT-4286)
// ============================================
//
// The analysis was already cached by a fingerprint that deliberately omits the
// attempt number, so reuse across retries was the intended behaviour. It never
// happened: the store was an in-memory Map, 256 entries against ~275 active
// runs, wiped by every daemon restart, while RETRY_AT backoff is counted in
// hours. Measured cost of that gap: 13,122 draft calls for 2,797 attempts —
// 4.7 per attempt — at $56.38 a day.
//
// These tests are about the property the Map could not have: an entry written
// by one process is readable by the next.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cachedDraftReusable, currentDraftActivity, draftActivityStamp } from './preClaimHold.js';
import {
  DRAFT_CACHE_TTL_MS, DRAFT_SCOPE_KEY_VERSION, draftFingerprint, pruneDraftCache, readDraftCache, resetDraftCacheForTests, writeDraftCache,
} from './draftCache.js';

let dir: string;
const ORIGINAL = process.env.OPENSWARM_AUTOMATION_DB;

const DRAFT = { taskType: 'bugfix', intentSummary: 'fix the guard', suggestedApproach: 'invert it' };
const entry = (fingerprint: string) => ({
  fingerprint,
  draft: DRAFT,
  fileScope: ['src/a.ts', 'src/b.ts'],
  description: 'the issue body',
  executionCommentsLoaded: true,
});

beforeEach(() => {
  // Per-test file: vitest.setup globals are shared across fork workers, so a
  // fixed path lets one test's rows reach another's assertions.
  dir = mkdtempSync(join(tmpdir(), 'openswarm-draftcache-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  resetDraftCacheForTests();
});

afterEach(() => {
  resetDraftCacheForTests();
  if (ORIGINAL === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
  else process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL;
  rmSync(dir, { recursive: true, force: true });
});

describe('durable draft cache (AGT-4286)', () => {
  it('returns what was written, for the same inputs', () => {
    writeDraftCache('issue-1', entry('fp-a'));

    const got = readDraftCache('issue-1', 'fp-a');

    expect(got?.draft).toEqual(DRAFT);
    expect(got?.fileScope).toEqual(['src/a.ts', 'src/b.ts']);
    expect(got?.description).toBe('the issue body');
    expect(got?.executionCommentsLoaded).toBe(true);
  });

  it('survives the handle being dropped, which is the whole point', () => {
    // A daemon restart is this, plus a new process. The in-memory Map could
    // not do it, and autodeploy restarted the daemon twice on the day this
    // was measured.
    writeDraftCache('issue-1', entry('fp-a'));
    resetDraftCacheForTests();

    expect(readDraftCache('issue-1', 'fp-a')?.draft).toEqual(DRAFT);
  });

  it('misses when the issue text changed, without destroying the entry', () => {
    // A reader cannot tell whether its own fingerprint is the newer one or a
    // stale one it is still carrying. Deleting on mismatch let an out-of-date
    // caller wipe a freshly written entry and force the next attempt to pay
    // for the draft again — the exact cost this cache exists to remove.
    writeDraftCache('issue-1', entry('fp-a'));

    expect(readDraftCache('issue-1', 'fp-b')).toBeUndefined();
    expect(readDraftCache('issue-1', 'fp-a')?.draft).toEqual(DRAFT);
  });

  it('misses for a task that was never drafted', () => {
    expect(readDraftCache('nobody', 'fp-a')).toBeUndefined();
  });

  it('expires past the TTL rather than handing back a stale tree', () => {
    // The fingerprint tracks issue text, not the working tree, so a very old
    // draft can describe code that has since moved.
    const written = Date.now();
    writeDraftCache('issue-1', entry('fp-a'), written);

    expect(readDraftCache('issue-1', 'fp-a', written + DRAFT_CACHE_TTL_MS - 1_000)?.draft).toEqual(DRAFT);
    expect(readDraftCache('issue-1', 'fp-a', written + DRAFT_CACHE_TTL_MS + 1_000)).toBeUndefined();
  });

  it('replaces the entry when the same task is drafted again', () => {
    writeDraftCache('issue-1', entry('fp-a'));
    writeDraftCache('issue-1', { ...entry('fp-b'), draft: { taskType: 'feature' } });

    expect(readDraftCache('issue-1', 'fp-a')).toBeUndefined();
    expect(readDraftCache('issue-1', 'fp-b')?.draft).toEqual({ taskType: 'feature' });
  });

  it('sweeps expired rows, so the table cannot grow forever', () => {
    const old = Date.now() - DRAFT_CACHE_TTL_MS - 1_000;
    writeDraftCache('stale-1', entry('fp-a'), old);
    writeDraftCache('stale-2', entry('fp-a'), old);
    writeDraftCache('fresh', entry('fp-a'));

    expect(pruneDraftCache()).toBe(2);
    expect(readDraftCache('fresh', 'fp-a')?.draft).toEqual(DRAFT);
  });

  it('refuses to store an entry with no analysis in it', () => {
    // A half-written row would hand the pipeline an undefined draft on the
    // next attempt, which is worse than recomputing.
    writeDraftCache('issue-1', { ...entry('fp-a'), draft: undefined });

    expect(readDraftCache('issue-1', 'fp-a')).toBeUndefined();
  });

  it('does not let an empty write destroy the analysis already stored', () => {
    // This is what the write guard is actually for. The read guard alone
    // catches the empty row on the way out, but by then the good entry it
    // replaced is gone and the next attempt pays for the draft again.
    writeDraftCache('issue-1', entry('fp-a'));
    writeDraftCache('issue-1', { ...entry('fp-a'), draft: undefined });

    expect(readDraftCache('issue-1', 'fp-a')?.draft).toEqual(DRAFT);
  });

  it('recomputes instead of throwing when the store cannot be opened', () => {
    // A read-only mount or a full disk must cost one recompute, never a run.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetDraftCacheForTests();
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'no', 'such', 'dir', 'automation.db');

    expect(() => writeDraftCache('issue-1', entry('fp-a'))).not.toThrow();
    expect(readDraftCache('issue-1', 'fp-a')).toBeUndefined();
    expect(pruneDraftCache()).toBe(0);
  });

  it('follows the path when a test redirects the database mid-flight', () => {
    writeDraftCache('issue-1', entry('fp-a'));
    const second = mkdtempSync(join(tmpdir(), 'openswarm-draftcache-2-'));
    try {
      process.env.OPENSWARM_AUTOMATION_DB = join(second, 'automation.db');
      expect(readDraftCache('issue-1', 'fp-a')).toBeUndefined();
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

// A draft computed before the project goal existed has no scope verdict. Cached
// under a goal-blind key it was reused for up to 12 hours and walked past the gate
// that stops a worker before any worktree exists (cgf-portal AX-1726, AGT-4669).
describe('draftFingerprint goal awareness (AGT-4669)', () => {
  it('keeps the old key for a project without a goal, so nothing already cached is lost', () => {
    expect(draftFingerprint('Title', 'Body')).toBe(JSON.stringify(['Title', 'Body']));
    expect(draftFingerprint('Title', undefined)).toBe(JSON.stringify(['Title', '']));
    expect(draftFingerprint('Title', 'Body', undefined)).toBe(draftFingerprint('Title', 'Body'));
    expect(draftFingerprint('Title', 'Body', '')).toBe(draftFingerprint('Title', 'Body'));
  });

  it('changes the key once a goal is set, so a goal-blind draft is not reused', () => {
    expect(draftFingerprint('Title', 'Body', 'ship usable PRs')).not.toBe(draftFingerprint('Title', 'Body'));
  });

  it('changes the key when the goal is edited, and is stable for the same goal', () => {
    const first = draftFingerprint('Title', 'Body', 'ship usable PRs');
    expect(draftFingerprint('Title', 'Body', 'ship usable PRs')).toBe(first);
    expect(draftFingerprint('Title', 'Body', 'reconcile ledgers first')).not.toBe(first);
  });

  it('still separates different issue text under the same goal', () => {
    expect(draftFingerprint('Other', 'Body', 'goal')).not.toBe(draftFingerprint('Title', 'Body', 'goal'));
    expect(draftFingerprint('Title', 'Edited', 'goal')).not.toBe(draftFingerprint('Title', 'Body', 'goal'));
  });

  it('does not serve a draft stored under the goal-less key to a goal-aware reader', () => {
    writeDraftCache('issue-1', entry(draftFingerprint('Title', 'Body')));

    expect(readDraftCache('issue-1', draftFingerprint('Title', 'Body', 'ship usable PRs'))).toBeUndefined();
    expect(readDraftCache('issue-1', draftFingerprint('Title', 'Body'))).toBeDefined();
  });
});

// A held issue is released by an answer, and the answer usually comes as a comment, which changes
// neither title nor description. A declined draft also carries the issue activity. (AGT-4784)
describe('declined draft activity key (AGT-4784)', () => {
  const declined = {
    ...DRAFT, scope: {
      applicable: false as const, kind: 'decision_pending' as const, confidence: 0.95,
      reason: 'waiting for a choice', evidence: ['title says choose', 'no code deliverable'],
    },
  };
  const task = { issueId: 'issue-9', trackerUpdatedAt: 1_000 };
  const signed = (createdAt: string) => ({ body: '🧭 **[OpenSwarm]** Draft grooming did not start a worker for this issue.', createdAt });
  const human = (body: string) => ({ body, createdAt: '1970-01-01T00:00:00.500Z' });
  const stampOf = async (t: typeof task, comments: Array<{ body: string; createdAt: string }>) =>
    draftActivityStamp((await currentDraftActivity(t, async () => comments))!);

  it('invalidates the cached verdict when the comment count changes', async () => {
    const before = [human('please look at this')];
    const key = draftFingerprint('T', 'B', undefined, DRAFT_SCOPE_KEY_VERSION);
    writeDraftCache('issue-9', { ...entry(key), draft: declined, activity: await stampOf(task, before) });
    const stored = () => readDraftCache<typeof declined>('issue-9', key)!;
    const reusable = (t: typeof task, comments: Array<{ body: string; createdAt: string }>) =>
      cachedDraftReusable(stored(), () => currentDraftActivity(t, async () => comments));

    // Same comments: the cached decline is reused, no re-draft.
    expect(await reusable(task, before)).toBe(true);
    // A person answers in a comment: the decline is judged again.
    expect(await reusable(task, [...before, human('Decided: rotate the key.')])).toBe(false);
    // Other activity a person caused (updatedAt moved, no daemon comment since) releases it too.
    expect(await reusable({ ...task, trackerUpdatedAt: 2_000 }, before)).toBe(false);
    // Comments unreadable right now: keep the hold rather than pay for a draft.
    expect(await cachedDraftReusable(stored(), async () => undefined)).toBe(true);
    // A decline stored before the stamp existed is never reused.
    expect(await cachedDraftReusable({ draft: declined }, async () => ({ updatedAt: 1 }))).toBe(false);
    // A draft that holds nothing keeps the text-only key: activity never re-drafts it (AGT-4300).
    expect(await cachedDraftReusable({ draft: DRAFT }, async () => ({ updatedAt: 99, humanComments: 9 }))).toBe(true);
  });

  it('absorbs the updatedAt bump its own decline comment caused, so the hold stays without a re-draft', async () => {
    const held = { draft: declined, activity: '1000:0' };
    const persist = vi.fn();
    // The daemon commented at t=1500 (after the stamp) and that moved updatedAt to 1500.
    const ok = await cachedDraftReusable(held, () => currentDraftActivity({ ...task, trackerUpdatedAt: 1_500 },
      async () => [signed('1970-01-01T00:00:01.500Z')]), persist);
    expect(ok).toBe(true);
    expect(held.activity).toBe('1500:0');
    expect(persist).toHaveBeenCalledWith('1500:0');
    // A later move with no new daemon comment is a person's change: released.
    expect(await cachedDraftReusable(held, () => currentDraftActivity({ ...task, trackerUpdatedAt: 3_000 },
      async () => [signed('1970-01-01T00:00:01.500Z')]))).toBe(false);
  });

  it('keys drafts made with the every-project scope prompt apart from older ones', () => {
    expect(draftFingerprint('T', 'B', undefined, DRAFT_SCOPE_KEY_VERSION)).not.toBe(draftFingerprint('T', 'B'));
    expect(draftFingerprint('T', 'B', 'goal', DRAFT_SCOPE_KEY_VERSION)).not.toBe(draftFingerprint('T', 'B', 'goal'));
  });
});
