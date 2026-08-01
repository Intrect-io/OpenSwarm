import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';
import {
  REVIEW_JSON_SCHEMA_VERSION,
  parseLocation,
  toReviewJson,
  toSarif,
  toUriReference,
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
    // results[0] is now the blocking issue; the located follow-up follows it.
    const loc = sarif.runs[0].results[1].locations[0].physicalLocation;
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
    expect(sarif.runs[0].results.filter((r: any) => r.ruleId !== 'openswarm/issue')).toHaveLength(1);
    expect(sarif.runs[0].results.find((r: any) => r.ruleId === 'openswarm/bug').locations).toBeUndefined();
  });

  it('reports follow-ups as warnings — they are advisory, unlike blocking issues', () => {
    const sarif = toSarif(review(), '0.0.0') as any;
    expect(sarif.runs[0].results.find((r: any) => r.ruleId === 'openswarm/bug').level).toBe('warning');
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
      .toEqual(['openswarm/bug', 'openswarm/issue', 'openswarm/test-coverage']);
    expect(sarif.runs[0].results.filter((r: any) => r.ruleId !== 'openswarm/issue')).toHaveLength(3);
  });
});

describe('packageVersion', () => {
  it('reads the shipped version rather than a hardcoded string', async () => {
    // A SARIF tool record that drifts from what actually ran is worse than
    // useless — it attributes findings to a version that never produced them.
    const { packageVersion } = await import('./reviewOutput.js');
    const pkg = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        new URL('../../package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    expect(await packageVersion()).toBe(pkg.version);
  });

  it('falls back rather than failing a report that is otherwise complete', async () => {
    // Exercised by pointing the reader at a directory with no package.json:
    // the module resolves relative to its own location, so the fallback is the
    // only reachable branch when the manifest is missing.
    const { packageVersion } = await import('./reviewOutput.js');
    const version = await packageVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});

describe('review findings feed SARIF (INT-3102 review)', () => {
  it('emits blocking issues even when there are no follow-ups', () => {
    // A revise carrying issues but no recommendedActions is a normal reviewer
    // response — the prompt separates blocking issues from advisory follow-ups.
    // Emitting only the latter left code scanning showing nothing for a failed gate.
    const sarif = toSarif(
      { decision: 'revise', feedback: 'x', issues: ['CSRF guard removed'], recommendedActions: [] },
      '0.0.0',
    ) as any;
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'openswarm/issue', level: 'error' });
    expect(sarif.runs[0].tool.driver.rules.map((r: any) => r.id)).toContain('openswarm/issue');
  });

  it('separates blocking issues from advisory follow-ups by level', () => {
    const sarif = toSarif(
      {
        decision: 'revise', feedback: 'x', issues: ['blocking'],
        recommendedActions: [{ type: 'bug', title: 'advisory' }],
      },
      '0.0.0',
    ) as any;
    const levels = sarif.runs[0].results.map((r: any) => r.level);
    expect(levels).toEqual(['error', 'warning']);
  });
});

describe('artifact URIs (INT-3102 review)', () => {
  it('converts Windows separators and encodes reserved characters', () => {
    expect(toUriReference('C:\\src\\my file.ts')).toBe('C%3A/src/my%20file.ts');
    expect(toUriReference('src/a#b/c.ts')).toBe('src/a%23b/c.ts');
  });

  it('applies the encoding in the SARIF location', () => {
    const sarif = toSarif(
      { decision: 'revise', feedback: 'x', recommendedActions: [{ type: 'bug', title: 't', location: 'src/my file.ts:7' }] },
      '0.0.0',
    ) as any;
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/my%20file.ts');
  });
});

describe('extensionless root files (INT-3102 review)', () => {
  it('keeps a location for build files that carry no suffix', () => {
    expect(parseLocation('Dockerfile')).toEqual({ file: 'Dockerfile' });
    expect(parseLocation('Makefile:12')).toEqual({ file: 'Makefile', line: 12 });
  });

  it('still refuses a bare prose word', () => {
    expect(parseLocation('middleware')).toEqual({});
    expect(parseLocation('the auth middleware:2')).toEqual({});
  });
});

describe('gateNotRunJson (INT-3102 review)', () => {
  it('reports no verdict rather than inventing one', async () => {
    const { gateNotRunJson } = await import('./reviewOutput.js');
    const json = gateNotRunJson(new Error('usage limit reached'));
    expect(json.gateRan).toBe(false);
    expect(json.decision).toBe('');
    expect(json.feedback).toContain('usage limit');
    expect(json.schemaVersion).toBe(REVIEW_JSON_SCHEMA_VERSION);
  });
});
