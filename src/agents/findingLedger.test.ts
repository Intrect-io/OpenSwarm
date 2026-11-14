import { describe, expect, it } from 'vitest';
import {
  buildReviewerFindingsSection,
  buildWorkerFindingsSection,
  createFindingLedger,
  describeLedgerStop,
  ledgerVerdict,
  openFindings,
  parseReviewerRulings,
  parseWorkerResponses,
  recordReviewRound,
  recordWorkerResponses,
  type FindingLedger,
} from './findingLedger.js';

function revise(ledger: FindingLedger, round: number, issues: string[], feedback = ''): FindingLedger {
  return recordReviewRound(ledger, { round, decision: 'revise', issues, feedback });
}

describe('findingLedger', () => {
  describe('id stability', () => {
    it('assigns pipeline ids in order and keeps them when the reviewer rewords a finding', () => {
      let l = revise(createFindingLedger(), 1, ['off-by-one in range()', 'missing test for empty input']);
      expect(l.findings.map((f) => f.id)).toEqual(['F1', 'F2']);

      l = revise(l, 2, ['F1: range() still stops one short (reworded)', 'F2: resolved'], 'F2: resolved');
      const f1 = l.findings.find((f) => f.id === 'F1')!;
      expect(f1.text).toBe('off-by-one in range()');
      expect(f1.lastReviewerNote).toBe('range() still stops one short (reworded)');
      expect(f1.status).toBe('open');
      expect(l.findings.find((f) => f.id === 'F2')!.status).toBe('resolved');
      expect(l.findings).toHaveLength(2);
    });

    it('gives an untagged or unknown-tagged issue a fresh id and never reuses one', () => {
      let l = revise(createFindingLedger(), 1, ['a']);
      l = revise(l, 2, ['F1: resolved', 'F99: model-invented id', 'brand new point'], 'F1: resolved');
      expect(l.findings.map((f) => f.id)).toEqual(['F1', 'F2', 'F3']);
      expect(l.findings[1].text).toBe('model-invented id');
      l = revise(l, 3, ['another']);
      expect(l.findings.at(-1)!.id).toBe('F4');
    });

    it('does not mutate the ledger it is given', () => {
      const a = revise(createFindingLedger(), 1, ['x']);
      const snapshot = JSON.stringify(a);
      revise(a, 2, ['y']);
      recordWorkerResponses(a, { round: 2, summary: 'F1: fixed — a.ts:1' });
      expect(JSON.stringify(a)).toBe(snapshot);
    });
  });

  describe('missing responses stay unresolved', () => {
    it('records an unanswered open id as missing', () => {
      let l = revise(createFindingLedger(), 1, ['x', 'y']);
      l = recordWorkerResponses(l, { round: 2, summary: 'Did the work.\nF1: fixed — src/a.ts:12 now checks bounds' });
      expect(l.findings[0].lastWorkerResponse).toEqual({ kind: 'fixed', evidence: 'src/a.ts:12 now checks bounds', round: 2 });
      expect(l.findings[1].lastWorkerResponse).toEqual({ kind: 'missing', evidence: '', round: 2 });
    });

    it('treats a fixed/disputed answer without evidence as missing', () => {
      const r = parseWorkerResponses('F1: fixed\nF2: disputed —   ', new Set(['F1', 'F2']));
      expect(r.get('F1')!.kind).toBe('missing');
      expect(r.get('F2')!.kind).toBe('missing');
    });

    it('treats two different answers for one id as missing', () => {
      const r = parseWorkerResponses('F1: fixed — a.ts:1\nF1: disputed — b.ts:2', new Set(['F1']));
      expect(r.get('F1')!.kind).toBe('missing');
    });

    it('a worker "fixed" alone never closes an id; an unruled id stays open and counts a round', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: fixed — a.ts:3' });
      l = revise(l, 2, [], 'Looks better overall.');
      expect(l.findings[0].status).toBe('open');
      expect(l.findings[0].openRounds).toBe(2);
    });

    it('does not let a reviewer quoting the worker ("F1: fixed") close the id', () => {
      expect(parseReviewerRulings('the worker wrote F1: fixed').has('F1')).toBe(false);
      expect(parseReviewerRulings('F1: resolved\nF2: still open\nF3: verified')).toEqual(
        new Map([['F1', 'resolved'], ['F2', 'open'], ['F3', 'resolved']]),
      );
    });

    it('fails closed when one id is ruled both resolved and open', () => {
      expect(parseReviewerRulings('F1: resolved ... F1: open').get('F1')).toBe('open');
      expect(parseReviewerRulings('F1: open ... F1: resolved').get('F1')).toBe('open');
    });

    it('keeps an id open when it is re-raised even if the feedback also says resolved', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = revise(l, 2, ['F1: still wrong'], 'F1: resolved');
      expect(l.findings[0].status).toBe('open');
    });
  });

  describe('deadlock detection', () => {
    it('stops when the worker disputes and the reviewer keeps the same id open twice in a row', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: disputed — spec says otherwise, README.md:4' });
      l = revise(l, 2, ['F1: still applies']);
      expect(ledgerVerdict(l, { maxRounds: 10 })).toEqual({ kind: 'continue' });
      l = recordWorkerResponses(l, { round: 3, summary: 'F1: disputed — README.md:4 again' });
      l = revise(l, 3, ['F1: still applies']);
      const v = ledgerVerdict(l, { maxRounds: 10 });
      expect(v.kind).toBe('deadlock');
      expect(v.kind !== 'continue' && v.ids).toEqual(['F1']);
    });

    it('resets the streak when the worker stops disputing', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: disputed — a' });
      l = revise(l, 2, ['F1: no']);
      l = recordWorkerResponses(l, { round: 3, summary: 'F1: fixed — b.ts:1' });
      l = revise(l, 3, ['F1: no']);
      expect(l.findings[0].disputeStreak).toBe(0);
      expect(ledgerVerdict(l, { maxRounds: 10 }).kind).toBe('continue');
    });

    it('does not count a dispute the reviewer accepted', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: disputed — a' });
      l = revise(l, 2, [], 'F1: resolved — dispute accepted');
      expect(openFindings(l)).toHaveLength(0);
      expect(ledgerVerdict(l).kind).toBe('continue');
    });
  });

  describe('round cap', () => {
    it('stops once an id has stayed open for maxRounds reviewer rounds', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = revise(l, 2, ['F1: still']);
      expect(ledgerVerdict(l, { maxRounds: 3 }).kind).toBe('continue');
      l = revise(l, 3, ['F1: still']);
      const v = ledgerVerdict(l, { maxRounds: 3 });
      expect(v.kind).toBe('round_cap');
      expect(describeLedgerStop(l, v as Exclude<typeof v, { kind: 'continue' }>)).toContain('F1: x');
    });

    it('never ends a capped run as an approval: verdict is a stop kind, not continue', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      const v = ledgerVerdict(l, { maxRounds: 1 });
      expect(v.kind).toBe('round_cap');
      l = recordReviewRound(l, { round: 2, decision: 'approve' });
      expect(ledgerVerdict(l, { maxRounds: 1 }).kind).toBe('continue');
      expect(l.findings[0].status).toBe('resolved');
    });
  });

  describe('idempotent replay (resume)', () => {
    it('replaying an applied review or worker round leaves the ledger unchanged', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      const again = revise(l, 1, ['x', 'y']);
      expect(again).toBe(l);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: fixed — a.ts:1' });
      expect(recordWorkerResponses(l, { round: 2, summary: '' })).toBe(l);
      const roundTrip = JSON.parse(JSON.stringify(l)) as FindingLedger;
      expect(revise(roundTrip, 1, ['z'])).toBe(roundTrip);
    });
  });

  describe('prompt sections', () => {
    it('is empty with nothing open', () => {
      expect(buildWorkerFindingsSection(undefined)).toBe('');
      expect(buildReviewerFindingsSection(createFindingLedger())).toBe('');
    });

    it('lists open ids with the answer form for the worker and the ruling form for the reviewer', () => {
      let l = revise(createFindingLedger(), 1, ['x']);
      l = recordWorkerResponses(l, { round: 2, summary: 'F1: disputed — README.md:4' });
      expect(buildWorkerFindingsSection(l)).toContain('- F1: x');
      expect(buildWorkerFindingsSection(l)).toContain('F<n>: fixed');
      const reviewer = buildReviewerFindingsSection(l);
      expect(reviewer).toContain('worker said disputed (round 2): README.md:4');
      expect(reviewer).toContain('F<n>: resolved');
    });
  });
});
