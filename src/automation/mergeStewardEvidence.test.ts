// Created: 2026-11-21
// Purpose: review/completeness evidence from the steward verdict ledger and the run ledger (AGT-4803)
// Dependencies: vitest, better-sqlite3 (tmp DBs only)
// Test Status: passing

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createVerdictLookup,
  readStoredVerdict,
  reviewEvidence,
  type ReviewEvidenceInput,
  type StewardLedgerEvidence,
} from './mergeStewardEvidence.js';
import { evaluateMergeSteward, type StewardSnapshot } from './mergeStewardGuards.js';
import { recordStewardVerdict, type StewardVerdictRecord } from './stewardVerdictLedger.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/7';
const BODY = ['## Summary', 'did it', '', '## Risk: low', 'ok', '', '## Linear', 'Closes AGT-1', ''].join('\n');
const LEDGER: StewardLedgerEvidence = { issueId: 'uuid-1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'low' };
const VERDICT: StewardVerdictRecord = { prUrl: PR_URL, reviewedSha: HEAD, verdict: 'approve', coverage: null, recordedAt: '2026-11-21T00:00:00.000Z' };

const input = (o: Partial<ReviewEvidenceInput> & { record?: Partial<StewardVerdictRecord> | null } = {}): ReviewEvidenceInput => {
  const { record, ...rest } = o;
  return {
    headSha: HEAD,
    pr: { body: BODY, title: 'feat: thing', isDraft: false },
    ledger: LEDGER,
    verdict: { record: record === null ? null : { ...VERDICT, ...record } },
    ...rest,
  };
};

/** Run the real review guard on the evidence; every other guard input is green. */
function reviewGuard(evidence: ReturnType<typeof reviewEvidence>, title = 'feat: thing') {
  const snapshot: StewardSnapshot = {
    prNumber: 7, author: 'bot', prReviews: [], automationAccounts: [], headSha: HEAD, title,
    requiredChecks: [], checks: [], risk: { level: 'low', headSha: HEAD }, siblings: [],
    review: evidence.review, completeness: evidence.completeness,
    mergeGrant: { granted: true, reason: 'test' }, files: ['src/a.ts'], complete: true,
  };
  return evaluateMergeSteward(snapshot).results.find((r) => r.guard === 'review-completeness');
}

describe('reviewEvidence: stored verdict bound to the head', () => {
  it('approve at the head with a clean ledger run, Closes and no partial coverage is approve/complete', () => {
    const evidence = reviewEvidence(input());
    expect(evidence).toMatchObject({ review: { verdict: 'approve', headSha: HEAD }, completeness: { verdict: 'complete', headSha: HEAD } });
    expect(evidence.note).toMatch(/coverage not recorded/);
    expect(reviewGuard(evidence)?.pass).toBe(true);
    expect(reviewEvidence(input({ record: { coverage: 'complete' } })).review?.verdict).toBe('approve');
    expect(reviewEvidence(input({ ledger: { ...LEDGER, state: 'SYNC_PENDING' } })).review?.verdict).toBe('approve');
  });

  it('a stored verdict for an older sha is bound to that sha and names both', () => {
    const evidence = reviewEvidence(input({ record: { reviewedSha: OLD } }));
    expect(evidence.review).toEqual({ verdict: 'unknown', headSha: OLD });
    expect(evidence.note).toBe(`stored verdict is for ${OLD}, head is ${HEAD}`);
    expect(reviewGuard(evidence)?.reason).toBe('review was for bbbbbbbbbbbb, not the head aaaaaaaaaaaa');
  });

  it('a stored reject refuses', () => {
    const evidence = reviewEvidence(input({ record: { verdict: 'reject' } }));
    expect(evidence.review).toEqual({ verdict: 'reject', headSha: HEAD });
    expect(reviewGuard(evidence)).toMatchObject({ pass: false, reason: 'reviewer verdict is reject' });
  });

  it('stored coverage partial refuses', () => {
    const evidence = reviewEvidence(input({ record: { coverage: 'partial' } }));
    expect(evidence).toMatchObject({ review: { verdict: 'unknown' }, completeness: { verdict: 'partial' }, note: 'stored reviewer coverage is partial' });
    expect(reviewGuard(evidence)?.pass).toBe(false);
  });

  it('a draft PR refuses', () => {
    const evidence = reviewEvidence(input({ pr: { body: BODY, title: 'feat: thing', isDraft: true } }));
    expect(evidence.note).toMatch(/draft/);
    expect(reviewGuard(evidence)?.pass).toBe(false);
  });

  it('a ledger run at another head, a missing run or an unclean state refuses', () => {
    const other = reviewEvidence(input({ ledger: { ...LEDGER, headSha: OLD } }));
    expect(other.note).toBe(`ledger run published ${OLD}, head is ${HEAD}`);
    expect(reviewGuard(other)?.pass).toBe(false);
    expect(reviewEvidence(input({ ledger: null })).note).toMatch(/no ledger run binds/);
    for (const state of ['NEEDS_RECONCILE', 'NEEDS_HUMAN', 'PUBLISHING', 'RETRY_AT']) {
      const evidence = reviewEvidence(input({ ledger: { ...LEDGER, state } }));
      expect(evidence.review?.verdict, state).toBe('unknown');
      expect(evidence.note).toContain(state);
    }
  });

  it('a missing Closes line or a [partial] title refuses', () => {
    const refs = reviewEvidence(input({ pr: { body: BODY.replace('Closes AGT-1', 'Refs AGT-1'), title: 'feat: thing', isDraft: false } }));
    expect(refs).toMatchObject({ review: { verdict: 'unknown' }, completeness: { verdict: 'partial' } });
    expect(refs.note).toMatch(/no Closes AGT-1 line/);
    expect(reviewGuard(refs)?.pass).toBe(false);
    const wrongIssue = reviewEvidence(input({ pr: { body: BODY.replace('Closes AGT-1', 'Closes AGT-99'), title: 'feat: thing', isDraft: false } }));
    expect(wrongIssue.review?.verdict).toBe('unknown');
    const partial = reviewEvidence(input({ pr: { body: BODY, title: '[partial] feat: thing', isDraft: false } }));
    expect(partial).toMatchObject({ review: { verdict: 'unknown' }, completeness: { verdict: 'partial' }, note: 'PR title is marked [partial]' });
    expect(reviewGuard(partial, '[partial] feat: thing')?.pass).toBe(false);
  });

  it('no stored verdict is null; an unreadable one refuses with a note', async () => {
    expect(reviewEvidence(input({ record: null }))).toMatchObject({ review: null, completeness: null });
    const thrown = await readStoredVerdict(() => { throw new Error('boom'); }, PR_URL, HEAD);
    const rejected = await readStoredVerdict(() => Promise.reject(new Error('locked')), PR_URL, HEAD);
    expect([thrown, rejected]).toEqual([{ error: 'boom' }, { error: 'locked' }]);
    const evidence = reviewEvidence(input({ verdict: thrown }));
    expect(evidence.note).toBe('stored reviewer verdict unreadable (boom): no approval counts');
    expect(reviewGuard(evidence)).toMatchObject({ pass: false, reason: 'reviewer verdict is unknown' });
  });
});

describe('createVerdictLookup (read-only)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dbIn = () => {
    const dir = mkdtempSync(join(tmpdir(), 'steward-evidence-'));
    dirs.push(dir);
    return join(dir, 'automation.db');
  };

  it('returns the head row, else the newest row for the PR, else null', async () => {
    const path = dbIn();
    recordStewardVerdict({ prUrl: PR_URL, reviewedSha: 'c'.repeat(40), decision: 'reject', now: Date.parse('2026-11-20T00:00:00Z') }, path);
    recordStewardVerdict({ prUrl: PR_URL, reviewedSha: OLD, decision: 'approve', coverage: 'complete', now: Date.parse('2026-11-21T00:00:00Z') }, path);
    const lookup = createVerdictLookup(path);
    expect(await lookup(PR_URL, HEAD)).toMatchObject({ reviewedSha: OLD, verdict: 'approve', coverage: 'complete' });
    recordStewardVerdict({ prUrl: PR_URL, reviewedSha: HEAD, decision: 'revise', now: Date.parse('2026-11-19T00:00:00Z') }, path);
    expect(await lookup(PR_URL, HEAD)).toMatchObject({ reviewedSha: HEAD, verdict: 'reject' });
    expect(await lookup('https://github.com/acme/widgets/pull/8', HEAD)).toBeNull();
  });

  it('a missing database or table is null; a broken file throws', async () => {
    expect(await createVerdictLookup(join(tmpdir(), 'steward-no-such-dir', 'x.db'))(PR_URL, HEAD)).toBeNull();
    const empty = dbIn();
    const { default: Database } = await import('better-sqlite3');
    new Database(empty).close();
    expect(await createVerdictLookup(empty)(PR_URL, HEAD)).toBeNull();
    const broken = dbIn();
    writeFileSync(broken, 'not a database');
    expect(await readStoredVerdict(createVerdictLookup(broken), PR_URL, HEAD)).toEqual({ error: expect.any(String) });
  });
});
