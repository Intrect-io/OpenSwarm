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

import {
  DRAFT_CACHE_TTL_MS, pruneDraftCache, readDraftCache, resetDraftCacheForTests, writeDraftCache,
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
