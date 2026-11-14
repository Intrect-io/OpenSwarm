import { describe, expect, it } from 'vitest';
import {
  completionReportEvidenceIssues,
  parseReportedRuns,
  verificationClaims,
} from './completionReportEvidence.js';

function report(output: string, filesChanged: string[] = ['src/a.ts'], executedCommands?: string[]) {
  return { output, summary: '', filesChanged, executedCommands };
}

describe('verificationClaims', () => {
  it('finds assertions that a check passed', () => {
    expect(verificationClaims('Codename: Atlas\nAll tests pass.\nLint is clean')).toEqual([
      'All tests pass.',
      'Lint is clean',
    ]);
    expect(verificationClaims('테스트 모두 통과했습니다')).toHaveLength(1);
  });

  it('does not treat stated limits or ordinary prose as claims', () => {
    expect(verificationClaims('Tests were not run: no node_modules in this worktree.')).toEqual([]);
    expect(verificationClaims('Could not verify that the build passes on Windows.')).toEqual([]);
    expect(verificationClaims('Fixed the step where the build cleans the cache.')).toEqual([]);
    expect(verificationClaims('테스트는 실행하지 못했습니다')).toEqual([]);
    expect(verificationClaims('{"type":"tool_result","content":"Tests 46 passed"}')).toEqual([]);
  });
});

describe('parseReportedRuns', () => {
  it('reads command, exit code and counts', () => {
    const { runs, malformed } = parseReportedRuns(
      'Ran: `npm test` -> exit 0, 412 passed, 0 failed\n- Ran: npm run lint → exit 0\nRan: pytest',
    );
    expect(runs).toEqual([
      expect.objectContaining({ command: 'npm test', exitCode: 0, passed: 412, failed: 0 }),
      expect.objectContaining({ command: 'npm run lint', exitCode: 0, passed: undefined }),
    ]);
    expect(malformed).toEqual(['Ran: pytest']);
  });
});

describe('completionReportEvidenceIssues', () => {
  it('rejects a "tests pass" report with no execution evidence', () => {
    const issues = completionReportEvidenceIssues(report('Codename: Atlas\nImplemented the fix. All tests pass.'));
    expect(issues[0]).toMatch(/claims a check passed but shows no execution evidence/);
    // The rejection quotes the format so the next attempt can comply.
    expect(issues.at(-1)).toMatch(/Ran: <command> -> exit <code>/);
  });

  it('rejects a report whose only evidence is a document written in the same diff', () => {
    const issues = completionReportEvidenceIssues(report(
      'No credentials are committed; the readiness check passes.\nEvidence: docs/a1-readiness.md',
      ['src/a.ts', 'docs/a1-readiness.md'],
    ));
    expect(issues[0]).toMatch(/cites documents written in this same change as evidence \(docs\/a1-readiness\.md\)/);
  });

  it('does not count a `Ran:` line that points at a self-authored doc', () => {
    const issues = completionReportEvidenceIssues(report(
      'Tests pass.\nRan: cat docs/results.md -> exit 0',
      ['src/a.ts', 'docs/results.md'],
    ));
    expect(issues[0]).toMatch(/cites documents written in this same change/);
  });

  it('accepts a claim backed by command, exit code and counts', () => {
    expect(completionReportEvidenceIssues(report(
      'All tests pass.\nRan: npm test -> exit 0, 412 passed, 0 failed\nRan: npm run lint -> exit 0',
    ))).toEqual([]);
  });

  it('accepts evidence even when an unchanged doc is also cited', () => {
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: pytest -> exit 0, 10 passed, 0 failed\nEvidence: docs/existing.md',
      ['src/a.ts'],
    ))).toEqual([]);
  });

  it('requires passed/failed counts from a test runner', () => {
    const issues = completionReportEvidenceIssues(report('Tests pass.\nRan: npx vitest run -> exit 0'));
    expect(issues[0]).toMatch(/without passed\/failed counts/);
  });

  it('rejects a pass claim whose own evidence shows a failing run', () => {
    expect(completionReportEvidenceIssues(report('Tests pass.\nRan: npm test -> exit 1, 40 passed, 2 failed'))[0])
      .toMatch(/evidence shows a failing run/);
  });

  it('rejects an evidence line without an exit code', () => {
    expect(completionReportEvidenceIssues(report('Tests pass.\nRan: npm test (looked fine)')).join(' '))
      .toMatch(/without an exit code/);
  });

  it('checks reported runs against what the adapter observed', () => {
    const neverRan = completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['git diff'],
    ));
    expect(neverRan.join(' ')).toMatch(/never observed executing: npm test/);

    const wrongExit = completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test [exit 1]'],
    ));
    expect(wrongExit.join(' ')).toMatch(/exit code does not match the observed run/);

    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['cd pkg && npm test'],
    ))).toEqual([]);
  });

  it('leaves a report that claims nothing to the missing-validation nudge', () => {
    expect(completionReportEvidenceIssues(report('Codename: Atlas\nRenamed the helper and updated callers.'))).toEqual([]);
  });
});
