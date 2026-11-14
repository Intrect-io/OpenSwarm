// AGT-4879 — merge steward guard engine (dry-run). Each guard has a fixture that
// differs from an all-green baseline in exactly one respect: the full engine
// refuses it naming that guard, and the same engine minus that guard lets it
// through. That is the proof the guard is load-bearing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STEWARD_GUARDS,
  applyStewardGuards,
  evaluateMergeSteward,
  formatStewardDecision,
  isDecisionCurrent,
  type StewardGuardName,
  type StewardSnapshot,
} from './mergeStewardGuards.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function baseline(overrides: Partial<StewardSnapshot> = {}): StewardSnapshot {
  return {
    prNumber: 101,
    author: 'swarm-publisher',
    prReviews: [],
    automationAccounts: ['swarm-publisher', 'swarm-worker', 'swarm-steward'],
    headSha: HEAD,
    title: 'fix(api): handle empty payload (AX-1)',
    files: ['src/api.ts', 'src/api.test.ts'],
    complete: true,
    requiredChecks: ['Tests', 'Lint'],
    checks: [
      { name: 'Tests', conclusion: 'success', headSha: HEAD },
      { name: 'Lint', conclusion: 'success', headSha: HEAD },
    ],
    risk: { level: 'low', headSha: HEAD },
    siblings: [{ number: 102, headRefName: 'swarm/AX-2-docs', files: ['docs/guide.md'], complete: true }],
    review: { verdict: 'approve', headSha: HEAD },
    completeness: { verdict: 'complete', headSha: HEAD },
    ...overrides,
  };
}

function without(name: StewardGuardName) {
  return STEWARD_GUARDS.filter((g) => g.name !== name);
}

function expectLoadBearing(name: StewardGuardName, snapshot: StewardSnapshot): void {
  const full = evaluateMergeSteward(snapshot);
  expect(full.mergeable).toBe(false);
  expect(full.results.filter((r) => !r.pass).map((r) => r.guard)).toEqual([name]);
  expect(applyStewardGuards(snapshot, without(name)).mergeable).toBe(true);
}

describe('merge steward baseline', () => {
  it('passes an all-green low-risk complete PR with no overlap', () => {
    const decision = evaluateMergeSteward(baseline());
    expect(decision.mergeable).toBe(true);
    expect(decision.dryRun).toBe(true);
    expect(decision.headSha).toBe(HEAD);
    expect(decision.results.map((r) => r.guard)).toEqual([
      'required-checks',
      'risk',
      'sibling-overlap',
      'review-completeness',
    ]);
  });

  it('runs all four guards', () => {
    expect(STEWARD_GUARDS.map((g) => g.name)).toEqual([
      'required-checks',
      'risk',
      'sibling-overlap',
      'review-completeness',
    ]);
  });

  it('never approves with an empty guard list', () => {
    expect(applyStewardGuards(baseline(), []).mergeable).toBe(false);
  });
});

describe('guard: required checks green on the head SHA', () => {
  it('a failing required check is load-bearing', () => {
    expectLoadBearing('required-checks', baseline({
      checks: [
        { name: 'Tests', conclusion: 'failure', headSha: HEAD },
        { name: 'Lint', conclusion: 'success', headSha: HEAD },
      ],
    }));
  });

  it('refuses a pending or missing required check', () => {
    expectLoadBearing('required-checks', baseline({
      checks: [{ name: 'Tests', conclusion: 'pending', headSha: HEAD }],
    }));
  });

  it('refuses checks that went green only on an older commit', () => {
    expectLoadBearing('required-checks', baseline({
      checks: [
        { name: 'Tests', conclusion: 'success', headSha: OLD },
        { name: 'Lint', conclusion: 'success', headSha: OLD },
      ],
    }));
  });

  it('refuses when a re-run on the head failed after an earlier success', () => {
    expectLoadBearing('required-checks', baseline({
      checks: [
        { name: 'Tests', conclusion: 'success', headSha: HEAD },
        { name: 'Tests', conclusion: 'failure', headSha: HEAD },
        { name: 'Lint', conclusion: 'success', headSha: HEAD },
      ],
    }));
  });

  it('refuses an empty required-check set (AGT-4414)', () => {
    const decision = evaluateMergeSteward(baseline({ requiredChecks: [], checks: [] }));
    expect(decision.mergeable).toBe(false);
    expect(decision.blockedBy[0]).toContain('no required checks');
  });
});

describe('guard: risk is low', () => {
  it('a medium-risk PR without a human approval is load-bearing', () => {
    expectLoadBearing('risk', baseline({ risk: { level: 'medium', headSha: HEAD } }));
  });

  it('refuses high, unknown and missing risk', () => {
    expectLoadBearing('risk', baseline({ risk: { level: 'high', headSha: HEAD } }));
    expectLoadBearing('risk', baseline({ risk: { level: null, headSha: HEAD } }));
    expectLoadBearing('risk', baseline({ risk: null }));
  });

  it('refuses a low class computed on an older commit', () => {
    expectLoadBearing('risk', baseline({ risk: { level: 'low', headSha: OLD } }));
  });
});

describe('guard: no open sibling PR touches the same files', () => {
  it('an overlapping sibling is load-bearing', () => {
    expectLoadBearing('sibling-overlap', baseline({
      siblings: [{ number: 103, headRefName: 'swarm/AX-3-api', files: ['src/api.ts'], complete: true }],
    }));
  });

  it('refuses when a sibling\'s file list is unknown or truncated', () => {
    expectLoadBearing('sibling-overlap', baseline({
      siblings: [{ number: 103, headRefName: 'swarm/AX-3', files: null, complete: false }],
    }));
    expectLoadBearing('sibling-overlap', baseline({
      siblings: [{ number: 103, headRefName: 'swarm/AX-3', files: ['docs/x.md'], complete: false }],
    }));
  });

  it('refuses when this PR\'s own file list is unknown or truncated', () => {
    expectLoadBearing('sibling-overlap', baseline({ files: null, complete: false }));
    expectLoadBearing('sibling-overlap', baseline({ complete: false }));
  });

  it('counts a rename source listed by a sibling as overlap', () => {
    // This PR renamed src/old.ts -> src/new.ts; the list carries both paths.
    expectLoadBearing('sibling-overlap', baseline({
      files: ['src/old.ts', 'src/new.ts'],
      siblings: [{ number: 104, headRefName: 'swarm/AX-4', files: ['src/old.ts'], complete: true }],
    }));
  });

  it('ignores OpenSwarm bookkeeping that every worktree carries, and itself', () => {
    const decision = evaluateMergeSteward(baseline({
      files: ['src/api.ts', '.openswarm-preserved'],
      siblings: [
        { number: 105, headRefName: 'swarm/AX-5', files: ['.openswarm-preserved', 'docs/a.md'], complete: true },
        { number: 101, headRefName: 'swarm/AX-1', files: ['src/api.ts'], complete: true },
      ],
    }));
    expect(decision.mergeable).toBe(true);
  });
});

describe('guard: reviewer approved and the run is complete', () => {
  it('a missing reviewer is load-bearing (fail-closed until AGT-4806 lands)', () => {
    expectLoadBearing('review-completeness', baseline({ review: null }));
  });

  it('refuses a rejecting or stale review', () => {
    expectLoadBearing('review-completeness', baseline({ review: { verdict: 'reject', headSha: HEAD } }));
    expectLoadBearing('review-completeness', baseline({ review: { verdict: 'approve', headSha: OLD } }));
  });

  it('refuses a partial run, by verdict or by the [partial] title marker', () => {
    expectLoadBearing('review-completeness', baseline({ completeness: { verdict: 'partial', headSha: HEAD } }));
    expectLoadBearing('review-completeness', baseline({ completeness: null }));
    expectLoadBearing('review-completeness', baseline({ completeness: { verdict: 'complete', headSha: OLD } }));
    expectLoadBearing('review-completeness', baseline({ title: '[partial] fix(api): handle empty payload' }));
  });
});

describe('dry-run only', () => {
  it('refuses dryRun: false instead of silently doing nothing', () => {
    expect(() => evaluateMergeSteward(baseline(), { dryRun: false })).toThrow(/no merge path/);
  });

  it('a decision is valid only for the head it was computed on', () => {
    const decision = evaluateMergeSteward(baseline());
    expect(isDecisionCurrent(decision, HEAD)).toBe(true);
    expect(isDecisionCurrent(decision, OLD)).toBe(false);
  });

  it('records the verdict and reasons in one line', () => {
    expect(formatStewardDecision(evaluateMergeSteward(baseline()))).toContain('would merge');
    const line = formatStewardDecision(evaluateMergeSteward(baseline({ risk: { level: 'high', headSha: HEAD } })));
    expect(line).toContain('would NOT merge');
    expect(line).toContain('risk: risk is high');
  });

  it('has no code path that could merge: no process, network or GitHub client imports', () => {
    const source = readFileSync(fileURLToPath(new URL('./mergeStewardGuards.ts', import.meta.url)), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*import\s/.test(line));
    expect(imports.every((line) => line.includes("'../agents/siblingWorkFormat.js'"))).toBe(true);
    expect(source).not.toMatch(/child_process|execFile|spawn\(|fetch\(|octokit|gh pr merge|\/merge\b/i);
  });
});

// AGT-4881 — medium and above merge only after one human approval on the head SHA.
describe('risk guard: medium and above need a human approval on the head', () => {
  const at = (minute: number) => `2026-11-15T00:${String(minute).padStart(2, '0')}:00Z`;
  const medium = (prReviews: StewardSnapshot['prReviews'], extra: Partial<StewardSnapshot> = {}) =>
    baseline({ risk: { level: 'medium', headSha: HEAD }, prReviews, ...extra });

  it('no approval: refused', () => {
    expectLoadBearing('risk', medium([]));
  });

  it('a bot approval: refused', () => {
    expectLoadBearing('risk', medium([
      { login: 'ci-helper[bot]', userType: 'Bot', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) },
    ]));
  });

  it('an approval on an earlier SHA: refused', () => {
    expectLoadBearing('risk', medium([
      { login: 'alice', userType: 'User', state: 'APPROVED', commitId: OLD, submittedAt: at(1) },
    ]));
  });

  it('a valid human approval on the head: passes', () => {
    const decision = evaluateMergeSteward(medium([
      { login: 'alice', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) },
    ]));
    expect(decision.mergeable).toBe(true);
    expect(decision.results.find((r) => r.guard === 'risk')?.reason).toContain('approved on the head by alice');
  });

  it('high risk follows the same rule', () => {
    const human = { login: 'alice', userType: 'User', state: 'APPROVED' as const, commitId: HEAD, submittedAt: at(1) };
    expectLoadBearing('risk', baseline({ risk: { level: 'high', headSha: HEAD } }));
    expect(evaluateMergeSteward(baseline({ risk: { level: 'high', headSha: HEAD }, prReviews: [human] })).mergeable).toBe(true);
  });

  it('factory accounts and the PR author do not count, even with a User type', () => {
    expectLoadBearing('risk', medium([
      { login: 'swarm-worker', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) },
      { login: 'Swarm-Steward', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: at(2) },
    ]));
    expectLoadBearing('risk', medium(
      [{ login: 'carol', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) }],
      { author: 'carol' },
    ));
  });

  it('a missing user type is not human', () => {
    expectLoadBearing('risk', medium([{ login: 'alice', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) }]));
  });

  it('a later change request or dismissal withdraws the approval; a comment does not', () => {
    const approve = { login: 'alice', userType: 'User', state: 'APPROVED' as const, commitId: HEAD, submittedAt: at(1) };
    expectLoadBearing('risk', medium([
      { ...approve, state: 'CHANGES_REQUESTED', submittedAt: at(2) },
      approve,
    ]));
    expectLoadBearing('risk', medium([approve, { ...approve, state: 'DISMISSED', submittedAt: at(3) }]));
    expect(evaluateMergeSteward(medium([approve, { ...approve, state: 'COMMENTED', submittedAt: at(4) }])).mergeable).toBe(true);
  });

  it('without a configured automation account list no approval is trusted', () => {
    expectLoadBearing('risk', medium(
      [{ login: 'alice', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: at(1) }],
      { automationAccounts: [] },
    ));
  });

  it('the other guards still apply to an approved medium PR', () => {
    const approved = [{ login: 'alice', userType: 'User', state: 'APPROVED' as const, commitId: HEAD, submittedAt: at(1) }];
    expectLoadBearing('required-checks', medium(approved, { checks: [] }));
    expectLoadBearing('review-completeness', medium(approved, { review: null }));
  });
});
