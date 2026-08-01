import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';
import {
  REVIEW_JSON_SCHEMA_VERSION,
  parseLocation,
  toReviewJson,
  toSarif,
} from './reviewOutput.js';

const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  decision: 'revise',
  feedback: 'CSRF validation was removed.',
  issues: ['session fixture depends on it'],
  suggestions: ['restore the guard'],
  recommendedActions: [
    { type: 'bug', title: 'Restore CSRF validation', location: 'src/auth/session.ts:42' },
  ],
  ...over,
});

describe('parseLocation', () => {
  it('splits path and line', () => {
    expect(parseLocation('src/auth/session.ts:42')).toEqual({ file: 'src/auth/session.ts', line: 42 });
  });

  it('takes the line from a path:line:column form', () => {
    expect(parseLocation('src/a.ts:42:7')).toEqual({ file: 'src/a.ts', line: 42 });
  });

  it('keeps a bare path with no line', () => {
    expect(parseLocation('src/auth/session.ts')).toEqual({ file: 'src/auth/session.ts' });
  });

  it('does not mistake a Windows drive letter for a line number', () => {
    expect(parseLocation('C:\\src\\foo.ts')).toEqual({ file: 'C:\\src\\foo.ts' });
  });

  it('refuses prose — pointing a tool at it would annotate a file that does not exist', () => {
    expect(parseLocation('the auth middleware')).toEqual({});
    expect(parseLocation('')).toEqual({});
    expect(parseLocation(undefined)).toEqual({});
  });
});

describe('toReviewJson', () => {
  it('carries the verdict and a stable schema version', () => {
    const json = toReviewJson(review());
    expect(json.schemaVersion).toBe(REVIEW_JSON_SCHEMA_VERSION);
    expect(json.decision).toBe('revise');
    expect(json.gateRan).toBe(true);
  });

  it('parses finding locations into file and line', () => {
    const [finding] = toReviewJson(review()).findings;
    expect(finding).toMatchObject({ file: 'src/auth/session.ts', line: 42, type: 'bug' });
    expect(finding.location).toBe('src/auth/session.ts:42');
  });

  it('normalizes absent collections to empty arrays so consumers need no guards', () => {
    const json = toReviewJson({ decision: 'approve', feedback: 'looks good' });
    expect(json.issues).toEqual([]);
    expect(json.suggestions).toEqual([]);
    expect(json.findings).toEqual([]);
  });

  it('records gateRan=false when the gate never produced a verdict', () => {
    expect(toReviewJson(review(), false).gateRan).toBe(false);
  });

  it('omits cost when the adapter reported none', () => {
    expect(toReviewJson(review()).costUsd).toBeUndefined();
  });
});

describe('toSarif', () => {
  it('emits a 2.1.0 run with the tool identified', () => {
    const sarif = toSarif(review(), '0.19.12') as any;
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('OpenSwarm');
    expect(sarif.runs[0].tool.driver.version).toBe('0.19.12');
  });

  it('places a finding on its file and line', () => {
    const sarif = toSarif(review(), '0.0.0') as any;
    const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('src/auth/session.ts');
    expect(loc.region.startLine).toBe(42);
  });

  it('keeps a finding whose location is prose, without a bogus physicalLocation', () => {
    // Dropping it would silently shrink the report; inventing a file would
    // annotate a path that does not exist.
    const sarif = toSarif(
      review({ recommendedActions: [{ type: 'bug', title: 'Tighten the guard', location: 'the auth middleware' }] }),
      '0.0.0',
    ) as any;
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0].locations).toBeUndefined();
  });

  it('reports findings as warnings — the verdict blocks, not the individual finding', () => {
    const sarif = toSarif(review(), '0.0.0') as any;
    expect(sarif.runs[0].results[0].level).toBe('warning');
  });

  it('declares one rule per finding type', () => {
    const sarif = toSarif(
      review({
        recommendedActions: [
          { type: 'bug', title: 'a' },
          { type: 'bug', title: 'b' },
          { type: 'test-coverage', title: 'c' },
        ],
      }),
      '0.0.0',
    ) as any;
    expect(sarif.runs[0].tool.driver.rules.map((r: any) => r.id).sort())
      .toEqual(['openswarm/bug', 'openswarm/test-coverage']);
    expect(sarif.runs[0].results).toHaveLength(3);
  });
});
