// ============================================
// OpenSwarm — durable review reuse (Tier 1)
// ============================================
//
// The replay cases here are the ones that decide whether this cache is a saving
// or a hole in the gate: a stored rejection must still roll the publication back,
// a stored "review did not run" must still say so on the PR, and a store that
// cannot be read must run the review rather than suppress it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  PUBLICATION_REVIEW_KIND,
  REVIEW_VERDICT_TTL_MS,
  ReviewVerdictStore,
  cliReviewKey,
  getReviewVerdictStore,
  lookupStoredPublication,
  lookupStoredReview,
  publicationReviewKey,
  recordStoredVerdict,
  resetReviewVerdictStoreForTests,
  reviewContentDigest,
  type ReviewVerdictKey,
} from './reviewVerdictStore.js';

const roots: string[] = [];

function createDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-review-verdict-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function storedOutcomes(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT * FROM publication_reviews').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ReviewVerdictStore', () => {
  it('survives a restart: a second store over the same file reads the first one back', () => {
    // The whole point. The in-process Set in publicationReviewHook.ts is empty
    // after every daemon restart (141 owner_process_exited + 157
    // shutdown_cancelled in the failure census), so a re-park after a redeploy
    // paid again for a review this deployment already had.
    const path = createDbPath();
    const key = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/1', headSha: 'abc1234' });

    const first = new ReviewVerdictStore(path);
    first.record(key, { success: false, gateRan: true, changesRequested: true, error: 'drops four passing tests' });
    first.close();

    const second = new ReviewVerdictStore(path);
    expect(second.lookupPublication(key)).toEqual({
      success: false, gateRan: true, changesRequested: true, error: 'drops four passing tests',
    });
    second.close();
  });

  it('stores the outcome whole, so nothing a replay needs is lost in the round trip', () => {
    // A partial outcome is how a rejecting verdict replays as an approve:
    // `changesRequested` is what the rollback branches on, and `gateRan`
    // distinguishes "did not run" from "rejected".
    const path = createDbPath();
    const store = new ReviewVerdictStore(path);
    const key = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/2', headSha: 'def5678' });

    store.record(key, { success: false, gateRan: false, error: 'openrouter timeout after 300000ms' });
    expect(store.lookupPublication(key)).toEqual({
      success: false, gateRan: false, error: 'openrouter timeout after 300000ms',
    });

    const [row] = storedOutcomes(path);
    expect(row.kind).toBe(PUBLICATION_REVIEW_KIND);
    expect(row.pr_url).toBe('https://github.com/o/r/pull/2');
    expect(row.head_sha).toBe('def5678');
    store.close();
  });

  it('does not confuse two head shas at the same PR', () => {
    // A new push to the same PR is a different diff. Reusing across shas would
    // hand a verdict about one commit to a review of another.
    const store = new ReviewVerdictStore(createDbPath());
    const first = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/3', headSha: 'aaa1111' });
    const second = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/3', headSha: 'bbb2222' });

    store.record(first, { success: true, gateRan: true, changesRequested: false });

    expect(store.lookupPublication(second)).toBeUndefined();
    expect(store.lookupPublication(first)).toBeDefined();
    store.close();
  });

  it('does not confuse the same PR number in two repositories', () => {
    const store = new ReviewVerdictStore(createDbPath());
    store.record(
      publicationReviewKey({ prUrl: 'https://github.com/o/one/pull/7', headSha: 'aaa1111' }),
      { success: true, gateRan: true, changesRequested: false },
    );
    expect(store.lookupPublication(
      publicationReviewKey({ prUrl: 'https://github.com/o/two/pull/7', headSha: 'aaa1111' }),
    )).toBeUndefined();
    store.close();
  });

  it('does not reuse the same content reviewed against a different base', () => {
    // The reviewer's answer depends on what the diff is taken against, not only
    // on the file contents: the same tree against `main` and against its own
    // merge-base is two different sets of changes.
    const store = new ReviewVerdictStore(createDbPath());
    const files = ['src/a.ts'];
    const hashes = { 'src/a.ts': 'file:abc' };
    const onMain = cliReviewKey({ kind: 'direct', base: 'origin/main', files, contentHashes: hashes })!;
    const onHead = cliReviewKey({ kind: 'direct', base: 'HEAD', files, contentHashes: hashes })!;

    store.record(onMain, { decision: 'approve', feedback: 'fine against main' });

    expect(store.lookupReview(onHead)).toBeUndefined();
    expect(store.lookupReview(onMain)?.decision).toBe('approve');
    store.close();
  });

  it('does not reuse a verdict across review modes', () => {
    // Measured on the recorded history: 53 of the 68 identical-content pairs
    // pair a CLI direct review with a publication review, and 15 of those 53
    // flipped their verdict — different prompt, different base, different tool
    // exposure. Only the 8 direct→direct and 7 pr→pr same-mode pairs are the
    // honest suppression population.
    const store = new ReviewVerdictStore(createDbPath());
    const files = ['src/a.ts'];
    const hashes = { 'src/a.ts': 'file:abc' };
    const direct = cliReviewKey({ kind: 'direct', files, contentHashes: hashes })!;
    const asPr = cliReviewKey({ kind: 'pr', files, contentHashes: hashes })!;

    store.record(direct, { decision: 'reject', feedback: 'bad' });

    expect(store.lookupReview(asPr)).toBeUndefined();
    store.close();
  });

  it('expires a stored verdict rather than replaying it indefinitely', () => {
    const store = new ReviewVerdictStore(createDbPath());
    const key = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/4', headSha: 'ccc3333' });
    const recordedAt = 1_000_000;

    store.record(key, { success: true, gateRan: true }, recordedAt);

    expect(store.lookupPublication(key, recordedAt + REVIEW_VERDICT_TTL_MS)).toBeDefined();
    expect(store.lookupPublication(key, recordedAt + REVIEW_VERDICT_TTL_MS + 1)).toBeUndefined();
    store.close();
  });

  it('replaces a verdict for the same identity instead of keeping both', () => {
    const store = new ReviewVerdictStore(createDbPath());
    const key = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/5', headSha: 'ddd4444' });

    store.record(key, { success: false, gateRan: true, changesRequested: true }, 1_000);
    store.record(key, { success: true, gateRan: true, changesRequested: false }, 2_000);

    expect(store.lookupPublication(key, 2_001)).toEqual({
      success: true, gateRan: true, changesRequested: false,
    });
    store.close();
  });

  it('treats a row it cannot parse as a miss rather than as an approval', () => {
    // The one direction this store must never be wrong in. A mangled row read
    // as `changesRequested: undefined` would replay a rejection as an approval
    // and leave an objected-to publication standing.
    const path = createDbPath();
    const store = new ReviewVerdictStore(path);
    const key = publicationReviewKey({ prUrl: 'https://github.com/o/r/pull/6', headSha: 'eee5555' });
    store.close();

    const db = new Database(path);
    db.prepare(`
      INSERT INTO publication_reviews(kind, base, content_digest, pr_url, head_sha, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(key.kind, key.base, key.digest, key.prUrl, key.headSha, '{"gateRan":true}', Date.now());
    db.close();

    const reopened = new ReviewVerdictStore(path);
    expect(reopened.lookupPublication(key)).toBeUndefined();
    reopened.close();
  });

  it('refuses to digest a tree whose hashes do not cover every reviewed file', () => {
    // An incomplete hash set is not a weaker identity but a wrong one: two
    // unrelated reviews whose hashes are both empty (an injected history stub)
    // would share a digest and replay each other's verdicts for diffs neither
    // saw.
    expect(reviewContentDigest(['a.ts', 'b.ts'], { 'a.ts': 'file:x' })).toBeUndefined();
    expect(reviewContentDigest(['a.ts'], {})).toBeUndefined();
    expect(reviewContentDigest([], {})).toBeUndefined();
    expect(reviewContentDigest(['a.ts'], { 'a.ts': 'file:x' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digests the same content identically regardless of file order or path spelling', () => {
    const hashes = { 'a.ts': 'file:x', 'b.ts': 'file:y' };
    const forward = reviewContentDigest(['a.ts', 'b.ts'], hashes);
    const reversed = reviewContentDigest(['b.ts', 'a.ts'], hashes);
    const dotted = reviewContentDigest(['./a.ts', 'b.ts'], hashes);
    const slashed = reviewContentDigest(['a.ts', 'b.ts'], { './a.ts': 'file:x', 'b.ts': 'file:y' });

    expect(reversed).toBe(forward);
    expect(dotted).toBe(forward);
    expect(slashed).toBe(forward);
    // Guard the guard: a different hash for the same path is a different review.
    expect(reviewContentDigest(['a.ts', 'b.ts'], { 'a.ts': 'file:changed', 'b.ts': 'file:y' })).not.toBe(forward);
  });

  it('changes the digest when the file set changes', () => {
    // A review of {a,b} is not a review of {a}: reusing across it would hand
    // back a verdict about a diff that never included b.
    const hashes = { 'a.ts': 'file:x', 'b.ts': 'file:y' };
    expect(reviewContentDigest(['a.ts'], hashes)).not.toBe(reviewContentDigest(['a.ts', 'b.ts'], hashes));
  });
});

describe('fail-open accessors', () => {
  const key: ReviewVerdictKey = { kind: 'direct', base: '', digest: 'd' };

  it('returns a miss when the store throws on lookup, so the caller reviews', () => {
    // A cache that cannot be read must never suppress a review, and must never
    // fail the run: this is the whole fail-open policy.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = {
      lookupPublication: () => { throw new Error('database is locked'); },
      lookupReview: () => { throw new Error('database is locked'); },
      record: () => { throw new Error('readonly database'); },
    };

    expect(lookupStoredPublication(throwing, key)).toBeUndefined();
    expect(lookupStoredReview(throwing, key)).toBeUndefined();
    expect(() => recordStoredVerdict(throwing, key, { decision: 'approve', feedback: 'x' })).not.toThrow();
  });

  it('returns a miss when there is no store or no key at all', () => {
    expect(lookupStoredPublication(undefined, key)).toBeUndefined();
    expect(lookupStoredReview(undefined, key)).toBeUndefined();
    expect(() => recordStoredVerdict(undefined, undefined, { decision: 'approve', feedback: 'x' })).not.toThrow();
  });

  it('reads a stored CLI verdict back through the shared store', () => {
    const store = new ReviewVerdictStore(createDbPath());
    const reviewKey = cliReviewKey({
      kind: 'direct', base: 'origin/main', files: ['a.ts'], contentHashes: { 'a.ts': 'file:x' },
    })!;

    recordStoredVerdict(store, reviewKey, {
      decision: 'revise', feedback: 'missing error handling', issues: ['no try/catch'],
    });

    expect(lookupStoredReview(store, reviewKey)).toMatchObject({
      decision: 'revise', issues: ['no try/catch'],
    });
    store.close();
  });
});

describe('getReviewVerdictStore', () => {
  let root: string;
  let savedDb: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-verdict-path-'));
    savedDb = process.env.OPENSWARM_AUTOMATION_DB;
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
    resetReviewVerdictStoreForTests();
  });

  afterEach(() => {
    resetReviewVerdictStoreForTests();
    if (savedDb === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
    else process.env.OPENSWARM_AUTOMATION_DB = savedDb;
    rmSync(root, { recursive: true, force: true });
  });

  it('opens the deployment automation database and shares one handle', () => {
    const store = getReviewVerdictStore();
    expect(store).toBeInstanceOf(ReviewVerdictStore);
    expect(getReviewVerdictStore()).toBe(store);
    store!.close();
  });

  it('returns undefined instead of throwing when the database cannot be opened', () => {
    // A path whose parent is a regular file: mkdir cannot fix that, so the store
    // has to degrade to "no cache" rather than take a review down with it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(root, 'blocker'), 'not a directory');
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'blocker', 'automation.db');
    resetReviewVerdictStoreForTests();

    expect(getReviewVerdictStore()).toBeUndefined();
    // And the failure is remembered, so an unopenable database does not cost a
    // synchronous open attempt and a warning on every review.
    expect(getReviewVerdictStore()).toBeUndefined();
  });

  it('re-resolves the path when the environment points somewhere else', () => {
    const first = getReviewVerdictStore();
    const relocated = join(root, 'elsewhere', 'automation.db');
    process.env.OPENSWARM_AUTOMATION_DB = relocated;

    const second = getReviewVerdictStore();

    expect(second).not.toBe(first);
    expect(existsSync(relocated)).toBe(true);
  });
});
