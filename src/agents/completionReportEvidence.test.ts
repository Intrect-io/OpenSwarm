import { describe, expect, it } from 'vitest';
import {
  completionReportEvidenceIssues,
  isProseDocFile,
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

describe('honest non-JS reports (review of #921)', () => {
  it('accepts go test with ok/PASS or exit 0 and no counts', () => {
    expect(completionReportEvidenceIssues(report('All tests pass.\nRan: go test ./... -> ok'))).toEqual([]);
    expect(completionReportEvidenceIssues(report('All tests pass.\nRan: go test ./... -> PASS'))).toEqual([]);
    expect(completionReportEvidenceIssues(report('All tests pass.\nRan: go test ./... -> exit 0'))).toEqual([]);
  });

  it('reads a missing failed count with exit 0 as zero failed', () => {
    expect(parseReportedRuns('Ran: npx vitest run -> exit 0, 46 passed').runs[0].failed).toBe(0);
    expect(completionReportEvidenceIssues(report('Tests pass.\nRan: npx vitest run -> exit 0, 46 passed'))).toEqual([]);
  });

  it('accepts Korean counts', () => {
    expect(parseReportedRuns('Ran: npm test -> exit 0, 412개 통과, 0개 실패').runs[0])
      .toMatchObject({ passed: 412, failed: 0 });
    expect(parseReportedRuns('Ran: npm test -> exit 0, 통과 412, 실패 0').runs[0])
      .toMatchObject({ passed: 412, failed: 0 });
    expect(completionReportEvidenceIssues(report('테스트 모두 통과했습니다.\nRan: npm test -> exit 0, 통과 412, 실패 0'))).toEqual([]);
  });
});

describe('known failures reported honestly', () => {
  it('does not hold a failing lint run against a test claim', () => {
    expect(completionReportEvidenceIssues(report(
      'All tests pass.\nRan: npm test -> exit 0, 10 passed, 0 failed\nRan: npm run lint -> exit 1',
    ))).toEqual([]);
  });

  it('still rejects a test claim backed only by a failing run of another kind', () => {
    expect(completionReportEvidenceIssues(report('Tests pass.\nRan: npm run lint -> exit 1'))[0])
      .toMatch(/shows no execution evidence/);
  });

  it('does not count a failing run marked pre-existing on the same or the next line', () => {
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 1, 411 passed, 1 failed (pre-existing, already failing on main)',
    ))).toEqual([]);
    expect(completionReportEvidenceIssues(report(
      '테스트 통과.\nRan: npm test -> exit 1, 411 passed, 1 failed\n이 1건은 기존 실패입니다.',
    ))).toEqual([]);
  });

  it('still rejects a same-kind failure that is not marked pre-existing', () => {
    expect(completionReportEvidenceIssues(report('Lint is clean.\nRan: npm run lint -> exit 1')).join(' '))
      .toMatch(/evidence shows a failing run/);
  });
});

describe('same-diff document detection', () => {
  it('does not treat requirements/constraints/CMakeLists .txt files as docs', () => {
    expect(isProseDocFile('requirements.txt')).toBe(false);
    expect(isProseDocFile('requirements-dev.txt')).toBe(false);
    expect(isProseDocFile('constraints.txt')).toBe(false);
    expect(isProseDocFile('CMakeLists.txt')).toBe(false);
    expect(isProseDocFile('src/readme.ts')).toBe(false);
    expect(isProseDocFile('NOTES.txt')).toBe(true);
    expect(isProseDocFile('README')).toBe(true);
    expect(isProseDocFile('docs/results.txt')).toBe(true);
    expect(isProseDocFile('guide.adoc')).toBe(true);
  });

  it('counts a run that takes a same-diff file as input, not just reads it', () => {
    expect(completionReportEvidenceIssues(report(
      'Lint is clean.\nRan: markdownlint docs/x.md -> exit 0',
      ['docs/x.md'],
    ))).toEqual([]);
    expect(completionReportEvidenceIssues(report(
      'The build passes.\nRan: pip install -r requirements.txt && make build -> exit 0',
      ['requirements.txt'],
    ))).toEqual([]);
  });

  it('flags an Evidence line citing a same-diff doc even when valid runs exist', () => {
    const issues = completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed\nEvidence: docs/results.md',
      ['src/a.ts', 'docs/results.md'],
    ));
    expect(issues.join(' ')).toMatch(/cites documents written in this same change as evidence \(docs\/results\.md\)/);
  });
});

describe('claim detection loopholes', () => {
  it('only exempts a line when the negation is attached to the verification verb', () => {
    expect(verificationClaims('All tests pass (not flaky).')).toHaveLength(1);
    expect(verificationClaims('Tests pass without network.')).toHaveLength(1);
    expect(verificationClaims('Tests not run.')).toEqual([]);
    expect(verificationClaims('I did not run tests, but the change is small.')).toEqual([]);
    expect(verificationClaims('Tests weren\'t run here.')).toEqual([]);
    expect(verificationClaims('테스트는 실행하지 않았습니다')).toEqual([]);
  });

  it('reads the summary/text of a JSON one-liner as report text', () => {
    expect(verificationClaims('{"success":true,"summary":"all tests pass"}')).toEqual(['all tests pass']);
    expect(completionReportEvidenceIssues(report('{"success":true,"summary":"all tests pass","commands":[]}'))[0])
      .toMatch(/shows no execution evidence/);
  });

  it('does not treat "made the build succeed" as a verification claim', () => {
    expect(verificationClaims('Made the build succeed on Node 22 by pinning the dep.')).toEqual([]);
    expect(verificationClaims('빌드가 성공하도록 의존성을 고정했다')).toEqual([]);
    expect(verificationClaims('The build passes.')).toHaveLength(1);
    expect(verificationClaims('Build is green on Node 22.')).toHaveLength(1);
    expect(verificationClaims('빌드 통과')).toHaveLength(1);
  });
});

describe('cross-check against observed runs', () => {
  it('does not let a targeted run satisfy a claim of the full run', () => {
    const issues = completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test -- a.test.ts'],
    ));
    expect(issues.join(' ')).toMatch(/only observed as a targeted run/);
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npx vitest run -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npx vitest run src/a.test.ts'],
    )).join(' ')).toMatch(/only observed as a targeted run/);
    // Redirects and pipes are not targeting.
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test 2>&1 | tail -20'],
    ))).toEqual([]);
  });

  it('compares the exit code of the last observed matching run', () => {
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test [exit 1]', 'npm test'],
    ))).toEqual([]);
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test', 'npm test [exit 1]'],
    )).join(' ')).toMatch(/exit code does not match the observed run/);
  });

  it('only checks that the run was observed when its exit status is unknown', () => {
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npm test [exit ?]'],
    ))).toEqual([]);
  });
});

describe('compound observed lines and unrecognised commands', () => {
  it('attributes a line exit code only to the command that ends the line', () => {
    expect(completionReportEvidenceIssues(report(
      'Lint is clean.\nRan: npm run lint -> exit 0\nRan: npm test -> exit 1, 9 passed, 1 failed (pre-existing)',
      ['src/a.ts'],
      ['npm run lint && npm test [exit 1]'],
    ))).toEqual([]);
    expect(completionReportEvidenceIssues(report(
      'Lint is clean.\nRan: npm run lint -> exit 0\nRan: npm test -> exit 1, 9 passed, 1 failed (pre-existing)',
      ['src/a.ts'],
      ['npm run lint', 'npm test 2>&1 | tail -20'],
    ))).toEqual([]);
    // A clean `&&` chain proves every link exited 0.
    expect(completionReportEvidenceIssues(report(
      'Lint is clean.\nRan: npm run lint -> exit 1',
      ['src/a.ts'],
      ['npm run lint && npm test'],
    )).join(' ')).toMatch(/exit code does not match the observed run/);
  });

  it('holds a failing run of an unrecognised kind against any claim', () => {
    for (const command of ['make test', './gradlew test', 'dotnet test', 'tox', './scripts/check.sh']) {
      expect(completionReportEvidenceIssues(report(
        `Tests pass.\nRan: npm run lint -> exit 0\nRan: ${command} -> exit 2`,
      )).join(' ')).toMatch(/evidence shows a failing run/);
    }
  });

  it('does not read a value-taking flag as a target', () => {
    expect(completionReportEvidenceIssues(report(
      'Typecheck is clean.\nRan: npx tsc -> exit 0',
      ['src/a.ts'],
      ['npx tsc -p tsconfig.json'],
    ))).toEqual([]);
    expect(completionReportEvidenceIssues(report(
      'Tests pass.\nRan: npx vitest run -> exit 0, 3 passed, 0 failed',
      ['src/a.ts'],
      ['npx vitest run --config vitest.config.ts'],
    ))).toEqual([]);
  });

  it('does not read the exit digit as a count', () => {
    expect(parseReportedRuns('Ran: npx vitest run -> exit 0 통과').runs[0].passed).toBeUndefined();
  });

  it('ignores a top-level text field on a stream event', () => {
    expect(verificationClaims('{"type":"assistant","text":"All tests pass"}')).toEqual([]);
  });
});
