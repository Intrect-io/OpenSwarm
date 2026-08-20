import { describe, it, expect } from 'vitest';
import {
  filterSourceFiles,
  preferSrcRoot,
  partitionIntoAreas,
  balanceAreasToConcurrency,
  aggregateAuditResults,
  formatAuditReport,
  formatAuditSummary,
  runMaxReview,
  runAreaFixes,
  runFixVerifyLoop,
  fixTargets,
  buildFixTaskDescription,
  mergeFallback,
  mergeReReview,
  mergeSecurityAuditFindings,
  type AuditArea,
  type AuditAreaResult,
  type AuditProgress,
  type AuditRun,
  type AuditSummary,
} from './reviewAudit.js';
import type { ReviewResult } from '../agents/agentPair.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { planFixUnits, type FixRepositoryContext } from './fixPlanning.js';

describe('filterSourceFiles (INT-2006)', () => {
  it('keeps source extensions and drops the rest', () => {
    const out = filterSourceFiles(['src/a.ts', 'src/b.tsx', 'README.md', 'logo.png', 'data.json']);
    expect(out).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('excludes test and spec files', () => {
    const out = filterSourceFiles(['src/a.ts', 'src/a.test.ts', 'src/b.spec.tsx', 'src/m_test.py']);
    expect(out).toEqual(['src/a.ts']);
  });

  it('excludes tracked junk directories', () => {
    const out = filterSourceFiles(['src/a.ts', 'dist/a.js', 'trash/old.ts', '.openswarm/x.ts']);
    expect(out).toEqual(['src/a.ts']);
  });

  it('keeps non-JS/Python languages (Rust/Go/JVM/C/Ruby) (INT-2240)', () => {
    const files = ['src/lib.rs', 'cmd/main.go', 'App.java', 'core/util.cpp', 'a.kt', 'b.rb', 'c.swift'];
    expect(filterSourceFiles(files)).toEqual(files);
  });

  it('excludes language test files and build dirs (INT-2240)', () => {
    expect(filterSourceFiles(['pkg/foo_test.go', 'FooTest.java', 'spec/bar_spec.rb'])).toEqual([]);
    expect(filterSourceFiles(['target/debug/x.rs', 'src/lib.rs'])).toEqual(['src/lib.rs']);
  });
});

describe('preferSrcRoot (INT-2006)', () => {
  it('keeps only src/ files when any exist', () => {
    expect(preferSrcRoot(['src/a.ts', 'benchmarks/b.ts', 'scripts/c.ts', 'index.ts'])).toEqual(['src/a.ts']);
  });

  it('falls back to all files when there is no src/ root', () => {
    const files = ['lib/a.ts', 'app/b.ts'];
    expect(preferSrcRoot(files)).toEqual(files);
  });
});

describe('partitionIntoAreas (INT-2006)', () => {
  it('groups one area per directory, sorted', () => {
    const areas = partitionIntoAreas(['src/b/y.ts', 'src/a/x.ts', 'src/a/w.ts']);
    expect(areas.map((a) => a.label)).toEqual(['src/a', 'src/b']);
    expect(areas[0].files).toEqual(['src/a/w.ts', 'src/a/x.ts']); // sorted within
  });

  it('splits an oversized directory into numbered chunks', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/big/f${String(i).padStart(2, '0')}.ts`);
    const areas = partitionIntoAreas(files, 10);
    expect(areas.map((a) => a.label)).toEqual(['src/big (1/3)', 'src/big (2/3)', 'src/big (3/3)']);
    expect(areas[0].files).toHaveLength(10);
    expect(areas[2].files).toHaveLength(5);
    // every file lands in exactly one chunk
    expect(areas.flatMap((a) => a.files).sort()).toEqual(files);
  });

  it('keeps a directory at the cap as a single area', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/m/f${i}.ts`);
    const areas = partitionIntoAreas(files, 12);
    expect(areas).toHaveLength(1);
    expect(areas[0].label).toBe('src/m');
  });

  it('is deterministic across input orderings', () => {
    const a = partitionIntoAreas(['src/b/y.ts', 'src/a/x.ts']);
    const b = partitionIntoAreas(['src/a/x.ts', 'src/b/y.ts']);
    expect(a).toEqual(b);
  });
});

describe('aggregateAuditResults (INT-2006)', () => {
  const review = (over: Partial<ReviewResult>): ReviewResult => ({
    decision: 'approve',
    feedback: '',
    ...over,
  });
  const area = (label: string) => ({ label, dir: label, files: [`${label}/f.ts`] });

  it('rolls up to the worst decision (reject > revise > approve)', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), review: review({ decision: 'revise' }) },
      { area: area('c'), review: review({ decision: 'reject' }) },
    ];
    expect(aggregateAuditResults(results).decision).toBe('reject');
  });

  it('approves only when every area approves', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), review: review({ decision: 'approve' }) },
    ];
    expect(aggregateAuditResults(results).decision).toBe('approve');
  });

  it('counts errored areas and makes incomplete audits non-approving', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), error: 'subagent timed out' },
    ];
    const sum = aggregateAuditResults(results);
    expect(sum.decision).toBe('reject');
    expect(sum.completed).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.areas.find((a) => a.label === 'b')?.decision).toBe('error');
  });

  it('prefixes issues and folds the area into action locations', () => {
    const results: AuditAreaResult[] = [
      {
        area: area('src/auth'),
        review: review({
          decision: 'revise',
          issues: ['missing null check'],
          recommendedActions: [
            { type: 'bug', title: 'Fix token refresh', location: 'src/auth/token.ts:42' },
            { type: 'test', title: 'Add coverage' },
          ],
        }),
      },
    ];
    const sum = aggregateAuditResults(results);
    expect(sum.issues).toEqual(['[src/auth] missing null check']);
    expect(sum.recommendedActions[0].location).toBe('src/auth: src/auth/token.ts:42');
    expect(sum.recommendedActions[1].location).toBe('src/auth'); // no original location
  });

  // INT-2022: fan-out areas duplicate shared files; isolate to the area + dedup.
  it('drops follow-ups pointing outside the area (fan-out isolation)', () => {
    const results: AuditAreaResult[] = [
      {
        area: area('src/a'),
        review: review({
          decision: 'revise',
          recommendedActions: [
            { type: 'bug', title: 'own', location: 'src/a/f.ts:10' },          // in area → keep
            { type: 'bug', title: 'foreign', location: 'src/broker/x.ts:5' },   // outside → drop
          ],
        }),
      },
    ];
    const sum = aggregateAuditResults(results);
    expect(sum.recommendedActions.map((a) => a.title)).toEqual(['own']);
    expect(sum.areas[0].actionCount).toBe(1); // count reflects kept, not raw
  });

  it('dedups the same type+file:line across areas', () => {
    const results: AuditAreaResult[] = [
      {
        area: area('src/a'),
        review: review({
          decision: 'revise',
          recommendedActions: [
            { type: 'bug', title: 't1', location: 'src/a/f.ts:5' },
            { type: 'bug', title: 't1-dup', location: 'src/a/f.ts:5' }, // same type+loc → dedup
            { type: 'test', title: 'same-loc-diff-type', location: 'src/a/f.ts:5' }, // diff type → keep
          ],
        }),
      },
      {
        area: area('src/b'),
        review: review({ decision: 'revise', recommendedActions: [{ type: 'bug', title: 'b', location: 'src/b/f.ts:1' }] }),
      },
    ];
    const sum = aggregateAuditResults(results);
    // t1 (bug), same-loc-diff-type (test), b (bug) = 3; t1-dup deduped
    expect(sum.recommendedActions.map((a) => a.title)).toEqual(['t1', 'same-loc-diff-type', 'b']);
  });
});

describe('mergeSecurityAuditFindings', () => {
  it('turns deterministic CodeQL evidence into a fixable rejection', () => {
    const base: AuditRun = {
      results: [{
        area: { label: 'src', dir: 'src', files: ['src/a.ts'] },
        review: { decision: 'approve', feedback: '', issues: [], recommendedActions: [] },
      }],
      summary: aggregateAuditResults([{
        area: { label: 'src', dir: 'src', files: ['src/a.ts'] },
        review: { decision: 'approve', feedback: '', issues: [], recommendedActions: [] },
      }]),
    };
    const merged = mergeSecurityAuditFindings(base, [{
      ruleId: 'codeql/js/file-system-race', level: 'error', message: 'race', filePath: 'src/a.ts', line: 8,
    }]);
    expect(merged.summary.decision).toBe('reject');
    expect(fixTargets(merged)).toHaveLength(1);
    expect(merged.summary.issues).toContain('[.openswarm/codeql-security] CodeQL codeql/js/file-system-race (src/a.ts:8): race');
  });
});

describe('formatAuditReport (INT-2022)', () => {
  it('renders markdown with verdict, failures, typed follow-ups, and issues', () => {
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 3,
      completed: 2,
      failed: 1,
      areas: [
        { label: 'src/a', decision: 'revise', issueCount: 2, actionCount: 1 },
        { label: 'src/b', decision: 'error', issueCount: 0, actionCount: 0 },
      ],
      issues: ['[src/a] missing null check'],
      recommendedActions: [
        { type: 'bug', title: 'Fix X', location: 'src/a: src/a/f.ts:1' },
        { type: 'test', title: 'Add test' },
      ],
    };
    const md = formatAuditReport(summary, 'myrepo', '2026-06-30T20-00-00');
    expect(md).toContain('# Codebase audit — myrepo');
    expect(md).toContain('Verdict: REVISE');
    expect(md).toContain('## ⚠ Reviewer failures (1)');
    expect(md).toContain('- src/b');
    expect(md).toContain('### bug (1)');
    expect(md).toContain('Fix X — `src/a: src/a/f.ts:1`');
    expect(md).toContain('## Issues (1)');
  });
});

describe('formatAuditSummary terminal output', () => {
  it('separates issue area, body, action type, and location for scanability', () => {
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 1,
      completed: 1,
      failed: 0,
      areas: [{ label: 'src', decision: 'revise', issueCount: 1, actionCount: 1 }],
      issues: [
        '[src] src/python-bridge.ts:201 - child 이벤트 핸들러가 해당 child 인스턴스에 스코프되지 않고 pendingRequest 전역 상태를 직접 수정합니다.',
      ],
      recommendedActions: [
        {
          type: 'bug',
          title: 'Scope PythonBridge child event handling to the active process instance',
          location: 'src: src/python-bridge.ts:201',
        },
      ],
    };

    const out = formatAuditSummary(summary);
    expect(out).toContain('Issues (1):');
    expect(out).toContain('⚠ src');
    expect(out).toContain('    src/python-bridge.ts:201 - child 이벤트');
    expect(out).toContain('Recommended follow-ups (1):');
    expect(out).toContain('✎ [bug] Scope PythonBridge child event handling');
    expect(out).toContain('    loc: src: src/python-bridge.ts:201');
    expect(out).not.toContain('  - [src]');
    expect(out).not.toContain('  - [bug]');
  });
});

describe('runMaxReview orchestration (INT-2006)', () => {
  const mkAreas = (n: number): AuditArea[] =>
    Array.from({ length: n }, (_, i) => ({ label: `src/m${i}`, dir: `src/m${i}`, files: [`src/m${i}/f.ts`] }));

  it('fans out over areas and aggregates the worst verdict', async () => {
    const areas = mkAreas(3);
    const review = async (area: AuditArea): Promise<ReviewResult> => ({
      decision: area.label === 'src/m1' ? 'reject' : 'approve',
      feedback: '',
      issues: [`issue in ${area.label}`],
    });
    const { summary: sum } = await runMaxReview(areas, '/repo', { concurrency: 2 }, { review });
    expect(sum.decision).toBe('reject');
    expect(sum.completed).toBe(3);
    expect(sum.issues).toContain('[src/m1] issue in src/m1');
  });

  it('emits start/done progress for every area', async () => {
    const areas = mkAreas(4);
    const events: AuditProgress[] = [];
    await runMaxReview(
      areas,
      '/repo',
      { concurrency: 2 },
      { review: async () => ({ decision: 'approve', feedback: '' }), onProgress: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.type === 'start')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(4);
    const lastDone = [...events].reverse().find((e) => e.type === 'done');
    expect(lastDone && 'done' in lastDone && lastDone.done).toBe(4);
  });

  it('records a thrown subagent as an errored area without aborting', async () => {
    const areas = mkAreas(3);
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      if (area.label === 'src/m1') throw new Error('subagent crashed');
      return { decision: 'approve', feedback: '' };
    };
    const { summary: sum } = await runMaxReview(areas, '/repo', { concurrency: 3 }, { review });
    expect(sum.completed).toBe(2);
    expect(sum.failed).toBe(1);
    expect(sum.areas.find((a) => a.label === 'src/m1')?.decision).toBe('error');
  });

  it('aborts early on a RateLimitError, skipping remaining areas (INT-2192)', async () => {
    const areas = mkAreas(5);
    let calls = 0;
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      calls++;
      if (area.label === 'src/m1') throw new RateLimitError(1782824950, 'codex limit', 100, 300);
      return { decision: 'approve', feedback: '' };
    };
    const run = await runMaxReview(areas, '/repo', { concurrency: 1 }, { review });
    expect(run.rateLimit).toBeInstanceOf(RateLimitError);
    expect(run.rateLimit?.usedPercent).toBe(100);
    expect(calls).toBeLessThan(5); // m2..m4 skipped, not attempted against the dead quota
  });
});

describe('mergeFallback (INT-2192)', () => {
  const area = (label: string): AuditArea => ({ label, dir: label, files: [`${label}/f.ts`] });

  it('fills the primary run failed areas with fallback results and clears rateLimit', () => {
    const primary: AuditRun = {
      results: [
        { area: area('src/a'), review: { decision: 'approve', feedback: '' } },
        { area: area('src/b'), error: 'codex limit' },
      ],
      summary: aggregateAuditResults([]),
      rateLimit: new RateLimitError(1, 'codex'),
    };
    const fallback: AuditRun = {
      results: [{ area: area('src/b'), review: { decision: 'revise', feedback: '' } }],
      summary: aggregateAuditResults([]),
    };
    const merged = mergeFallback(primary, fallback);
    expect(merged.results[0].review?.decision).toBe('approve'); // a untouched
    expect(merged.results[1].review?.decision).toBe('revise'); // b filled by claude fallback
    expect(merged.summary.completed).toBe(2);
    expect(merged.summary.failed).toBe(0);
    expect(merged.rateLimit).toBeUndefined(); // fallback succeeded → resolved
  });
});

describe('balanceAreasToConcurrency (INT-2249)', () => {
  // Two dirs, 5 files each — the plain partition gives 2 areas.
  const files = [
    ...Array.from({ length: 5 }, (_, i) => `src/a/f${i}.ts`),
    ...Array.from({ length: 5 }, (_, i) => `src/b/f${i}.ts`),
  ];

  it('splits below-pool partitions so the fan-out saturates concurrency', () => {
    expect(partitionIntoAreas(files, 12)).toHaveLength(2); // baseline: 2 dirs
    const balanced = balanceAreasToConcurrency(files, 8, 12);
    expect(balanced.length).toBeGreaterThanOrEqual(8);
    // Every original file is still covered exactly once.
    expect(balanced.flatMap((a) => a.files).sort()).toEqual([...files].sort());
  });

  it('is a no-op when the directory partition already fills the pool', () => {
    const balanced = balanceAreasToConcurrency(files, 2, 12);
    expect(balanced).toHaveLength(2);
  });

  it('does not over-split past what the files allow (cap floors at 1/file)', () => {
    // 10 files, concurrency 50 → at most 10 areas (one file each).
    const balanced = balanceAreasToConcurrency(files, 50, 12);
    expect(balanced).toHaveLength(files.length);
  });

  it('concurrency <= 1 returns the plain partition', () => {
    expect(balanceAreasToConcurrency(files, 1, 12)).toHaveLength(2);
  });
});

describe('fixTargets + runAreaFixes (INT-2249)', () => {
  const area = (label: string): AuditArea => ({ label, dir: label, files: [`${label}/f.ts`] });
  const repositoryContext: FixRepositoryContext = {
    canonicalRoot: '/repo', workspaces: [], manifests: [], verificationCommands: [], sharedPaths: [], repoMemories: [],
    dependencyGraphAvailable: true,
    dependencyMap: {
      'src/b/f.ts': { imports: [], dependents: [], tests: [] },
      'src/c/f.ts': { imports: [], dependents: [], tests: [] },
    },
    preflight: { ready: true, issues: [] },
  };
  const run = (): AuditRun => ({
    results: [
      { area: area('src/a'), review: { decision: 'approve', feedback: '' } },
      { area: area('src/b'), review: { decision: 'revise', feedback: '', issues: ['bug in f'] } },
      { area: area('src/c'), review: { decision: 'reject', feedback: '' } },
      { area: area('src/d'), error: 'reviewer crashed' },
    ],
    summary: aggregateAuditResults([]),
  });

  it('targets only non-approve areas with a review', () => {
    const targets = fixTargets(run());
    expect(targets.map((t) => t.area.label)).toEqual(['src/b', 'src/c']);
  });

  it('buildFixTaskDescription scopes to the area files and lists issues', () => {
    const context: FixRepositoryContext = {
      canonicalRoot: '/repo', packageManager: 'pnpm', workspaces: [], manifests: ['package.json'],
      verificationCommands: ['pnpm test'], sharedPaths: ['node_modules'], repoMemories: [],
      dependencyGraphAvailable: true, dependencyMap: {}, preflight: { ready: true, issues: [] },
    };
    const [unit] = planFixUnits([
      { area: area('src/b'), review: { decision: 'revise', feedback: '', issues: ['bug in f'] } },
    ], context);
    const desc = buildFixTaskDescription(unit, context);
    expect(desc).toContain('src/b/f.ts');
    expect(desc).toContain('bug in f');
    expect(desc).toContain('Supporting edits');
    expect(desc).toContain('pnpm test');
  });

  it('fans a fix worker out over each target and reports edited files', async () => {
    const seen: string[] = [];
    const fixes = await runAreaFixes(run(), '/repo', { concurrency: 2, repositoryContext }, {
      fix: async (unit) => {
        seen.push(unit.label);
        return { success: true, filesChanged: unit.primaryFiles };
      },
    });
    expect(seen.sort()).toEqual(['src/b', 'src/c']); // approve + error areas skipped
    expect(fixes.every((f) => f.applied)).toBe(true);
    expect(fixes.flatMap((f) => f.filesChanged).sort()).toEqual(['src/b/f.ts', 'src/c/f.ts']);
  });

  it('falls back to serial fix units when no repository dependency graph is available', async () => {
    let active = 0;
    let maxActive = 0;
    await runAreaFixes(run(), '/repo', { concurrency: 8 }, {
      fix: async (unit) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { success: true, filesChanged: unit.primaryFiles };
      },
    });
    expect(maxActive).toBe(1);
  });

  it('emits fix worker log progress for a live status board', async () => {
    const events: string[] = [];
    await runAreaFixes(run(), '/repo', { concurrency: 1, repositoryContext }, {
      fix: async (unit, onLog) => {
        onLog(`[Worker] Git detected 1 changed file(s): ${unit.primaryFiles[0]}`);
        return { success: true, filesChanged: unit.primaryFiles };
      },
      onProgress: (e) => {
        if (e.type === 'log') events.push(`${e.label}: ${e.line}`);
      },
    });
    expect(events).toEqual([
      'src/b: [Worker] Git detected 1 changed file(s): src/b/f.ts',
      'src/c: [Worker] Git detected 1 changed file(s): src/c/f.ts',
    ]);
  });

  it('a failed fix lands as an error, not a throw', async () => {
    const fixes = await runAreaFixes(run(), '/repo', { concurrency: 1, repositoryContext }, {
      fix: async (unit) => {
        if (unit.label === 'src/c') throw new Error('worker died');
        return { success: true, filesChanged: unit.primaryFiles };
      },
    });
    const c = fixes.find((f) => f.label === 'src/c');
    expect(c?.applied).toBe(false);
    expect(c?.error).toContain('worker died');
  });
});

describe('runFixVerifyLoop (INT-2443)', () => {
  const area = (label: string): AuditArea => ({ label, dir: label, files: [`${label}/f.ts`] });
  // src/a already approves; src/b is flagged and needs fixing.
  const initial = (): AuditRun => ({
    results: [
      { area: area('src/a'), review: { decision: 'approve', feedback: '' } },
      { area: area('src/b'), review: { decision: 'revise', feedback: '', issues: ['bug'] } },
    ],
    summary: aggregateAuditResults([]),
  });

  it('mergeReReview overlays fresh verdicts, flipping reject→approve', () => {
    const base: AuditRun = {
      results: [
        { area: area('src/a'), review: { decision: 'approve', feedback: '' } },
        { area: area('src/b'), review: { decision: 'reject', feedback: '' } },
      ],
      summary: aggregateAuditResults([]),
    };
    const reReview: AuditRun = {
      results: [{ area: area('src/b'), review: { decision: 'approve', feedback: '' } }],
      summary: aggregateAuditResults([]),
    };
    const merged = mergeReReview(base, reReview);
    expect(merged.results.find((r) => r.area.label === 'src/b')?.review?.decision).toBe('approve');
    expect(merged.summary.decision).toBe('approve'); // both areas now approve
  });

  it('loops fix → re-review and converges once the re-review approves', async () => {
    let bReviews = 0;
    const fixed: string[] = [];
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 2, maxRounds: 3 }, {
      fix: async (unit) => { fixed.push(unit.label); return { success: true, filesChanged: unit.primaryFiles }; },
      // round 1 re-review still revises, round 2 approves
      review: async (a) => ({
        decision: a.label === 'src/b' && ++bReviews < 2 ? 'revise' : 'approve',
        feedback: '',
      }),
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toBe('all-approved');
    expect(result.filesChanged).toEqual(['src/b/f.ts']); // only the flagged area, deduped
    expect(fixed).toEqual(['src/b', 'src/b']);            // fixed twice, never touched src/a
  });

  it('keeps fixing past three rounds by default until every area approves', async () => {
    let bReviews = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async (a) => ({
        decision: a.label === 'src/b' && ++bReviews < 5 ? 'revise' : 'approve',
        feedback: '',
      }),
    });
    expect(result.rounds).toHaveLength(5);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toBe('all-approved');
  });

  it('does not complete on LLM approval until deterministic verification passes', async () => {
    let verifies = 0;
    let fixes = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async (unit) => {
        fixes++;
        return { success: true, filesChanged: unit.primaryFiles };
      },
      review: async () => ({ decision: 'approve', feedback: '' }),
      verify: async () => ++verifies >= 2
        ? { success: true }
        : { success: false, failedTests: ['test'], output: 'new test failure' },
    });
    expect(fixes).toBe(2);
    expect(verifies).toBe(2);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds.map((round) => round.resolved)).toEqual([0, 1]);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toBe('all-approved');
  });

  it('fails closed when deterministic verification never passes', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 2 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async () => ({ decision: 'approve', feedback: '' }),
      verify: async () => ({ success: false, failedTests: ['test'], output: 'still failing' }),
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.resolved).toBe(false);
    expect(result.stopReason).toBe('max-rounds');
    expect(result.finalRun.summary.issues.join('\n')).toContain('Deterministic verification failed');
  });

  it('re-reviews the whole audit each round and fixes findings discovered in a previously approved area', async () => {
    const fixed: string[] = [];
    let confirmationFoundRegression = false;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1 }, {
      fix: async (unit) => {
        fixed.push(unit.label);
        return { success: true, filesChanged: unit.primaryFiles };
      },
      review: async (a) => {
        if (a.label === 'src/a' && !confirmationFoundRegression) {
          confirmationFoundRegression = true;
          return { decision: 'revise', feedback: '', issues: ['cross-area regression'] };
        }
        return { decision: 'approve', feedback: '' };
      },
    });
    expect(fixed).toEqual(['src/b', 'src/a']);
    expect(result.rounds).toHaveLength(2);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toBe('all-approved');
  });

  it('stops at the round budget and reports the still-flagged area', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 2 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async (a) => ({ decision: a.label === 'src/b' ? 'reject' : 'approve', feedback: '' }), // never clears b
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.stopReason).toBe('max-rounds');
    expect(result.resolved).toBe(false);
    expect(fixTargets(result.finalRun).map((t) => t.area.label)).toEqual(['src/b']);
  });

  it('fails unresolved when the whole-loop wall-clock budget is exhausted', async () => {
    let now = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxDurationMs: 100 }, {
      now: () => now,
      fix: async (unit) => {
        now += 100;
        return { success: true, filesChanged: unit.primaryFiles };
      },
      review: async (a) => ({ decision: a.label === 'src/b' ? 'revise' : 'approve', feedback: '' }),
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.resolved).toBe(false);
    expect(result.stopReason).toBe('time-budget');
  });

  it('interrupts an in-flight fix phase when the whole-loop budget expires', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxDurationMs: 10 }, {
      fix: async () => await new Promise<{ success: boolean; filesChanged: string[] }>(() => {}),
    });
    expect(result.rounds).toHaveLength(0);
    expect(result.resolved).toBe(false);
    expect(result.stopReason).toBe('time-budget');
  });

  it('returns a fail-closed result when post-fix verification exceeds the loop budget', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxDurationMs: 10 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async () => ({ decision: 'approve', feedback: '' }),
      verify: async () => await new Promise<{ success: boolean }>(() => {}),
    });
    expect(result.stopReason).toBe('time-budget');
    expect(result.verified).toBe(false);
    expect(result.verificationStatus).not.toBe('passed');
  });

  it('returns the post-review result when a CodeQL refresh exceeds the loop budget', async () => {
    let refreshes = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxDurationMs: 10 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async () => ({ decision: 'approve', feedback: '' }),
      refreshSecurityAudit: async () => ++refreshes === 1
        ? []
        : await new Promise<never>(() => {}),
    });

    expect(result.stopReason).toBe('time-budget');
    expect(result.finalRun.results.every((entry) => entry.review?.decision === 'approve')).toBe(true);
  });

  it('reports all-approved before consulting an expired time budget', async () => {
    const clean: AuditRun = {
      results: [{ area: area('src/a'), review: { decision: 'approve', feedback: '' } }],
      summary: aggregateAuditResults([]),
    };
    const result = await runFixVerifyLoop(clean, '/repo', { concurrency: 1, maxDurationMs: 1 }, {
      now: () => 10_000,
    });
    expect(result.rounds).toHaveLength(0);
    expect(result.resolved).toBe(true);
    expect(result.stopReason).toBe('all-approved');
    expect(result.verified).toBe(false);
    expect(result.verificationStatus).toBe('unavailable');
  });

  it('runs deterministic verification even when the initial review is already clean', async () => {
    const clean: AuditRun = {
      results: [{ area: area('src/a'), review: { decision: 'approve', feedback: '' } }],
      summary: aggregateAuditResults([]),
    };
    const verify = async () => ({ success: true });
    const result = await runFixVerifyLoop(clean, '/repo', { concurrency: 1 }, { verify });
    expect(result.rounds).toHaveLength(0);
    expect(result.resolved).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.verificationStatus).toBe('passed');
  });

  it('does not send an infrastructure-only verification failure to a code worker', async () => {
    const clean: AuditRun = {
      results: [{ area: area('src/a'), review: { decision: 'approve', feedback: '' } }],
      summary: aggregateAuditResults([]),
    };
    let fixes = 0;
    const result = await runFixVerifyLoop(clean, '/repo', { concurrency: 1 }, {
      fix: async () => { fixes++; return { success: true, filesChanged: ['src/a/f.ts'] }; },
      verify: async () => { throw new Error('verify-runner: pnpm infrastructure failure'); },
    });
    expect(fixes).toBe(0);
    expect(result.resolved).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.verificationStatus).toBe('infra');
    expect(result.verificationError).toContain('pnpm infrastructure failure');
  });

  it('blocks all code workers when repository dependency preflight fails', async () => {
    let fixes = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', {
      concurrency: 2,
      repositoryContext: {
        canonicalRoot: '/repo', workspaces: [], manifests: ['package.json'], verificationCommands: ['pnpm test'],
        sharedPaths: [], repoMemories: [], dependencyGraphAvailable: true, dependencyMap: {},
        preflight: { ready: false, issues: ['node_modules missing'] },
      },
    }, {
      fix: async () => { fixes++; return { success: true, filesChanged: [] }; },
    });
    expect(fixes).toBe(0);
    expect(result.stopReason).toBe('dependency-preflight');
    expect(result.resolved).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.verificationError).toContain('node_modules missing');
  });

  it('re-reviews after a no-edit fix and accepts a finding that is already cleared', async () => {
    let reviewed = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async () => ({ success: true, filesChanged: [] }), // worker touched nothing
      review: async () => { reviewed++; return { decision: 'approve', feedback: '' }; },
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.stopReason).toBe('all-approved');
    expect(result.resolved).toBe(true);
    expect(reviewed).toBe(2); // whole surface: src/a + src/b
  });

  it('reports no-progress only after a no-edit whole review repeats identical findings', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async () => ({ success: true, filesChanged: [] }),
      review: async (a) => a.label === 'src/b'
        ? { decision: 'revise', feedback: '', issues: ['bug'] }
        : { decision: 'approve', feedback: '' },
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.stopReason).toBe('no-progress');
    expect(result.resolved).toBe(false);
  });

  it('retries a no-edit worker when the whole review provides a changed diagnosis', async () => {
    let fixes = 0;
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async (unit) => {
        fixes++;
        return fixes === 1
          ? { success: true, filesChanged: [] }
          : { success: true, filesChanged: unit.primaryFiles };
      },
      review: async (a) => {
        if (a.label === 'src/a') return { decision: 'approve', feedback: '' };
        return fixes === 1
          ? { decision: 'revise', feedback: '', issues: ['more actionable diagnosis'] }
          : { decision: 'approve', feedback: '' };
      },
    });
    expect(fixes).toBe(2);
    expect(result.rounds).toHaveLength(2);
    expect(result.stopReason).toBe('all-approved');
    expect(result.resolved).toBe(true);
  });

  it('stops when a re-review hits a usage limit, and stays unresolved', async () => {
    const result = await runFixVerifyLoop(initial(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async () => { throw new RateLimitError(1770000000, 'usage limit'); },
    });
    expect(result.stopReason).toBe('rate-limit');
    // The errored (rate-limited) area is NOT resolved — fixTargets would miss it
    // because it lost its review, but resolved counts it as not-approved.
    expect(result.resolved).toBe(false);
  });

  it('a rate-limited/errored re-review preserves the original findings (does not erase follow-ups)', async () => {
    // src/b carries an actionable follow-up; the fix edits it but the re-review
    // rate-limits before it can re-verdict. The prior findings must survive into
    // the final summary — otherwise the report and Linear filing lose them.
    const flagged = (): AuditRun => ({
      results: [
        {
          area: area('src/b'),
          review: {
            decision: 'revise',
            feedback: '',
            issues: ['bug in f'],
            recommendedActions: [{ type: 'fix', title: 'patch the bug', location: 'src/b/f.ts:1' }],
          },
        },
      ],
      summary: aggregateAuditResults([]),
    });
    const result = await runFixVerifyLoop(flagged(), '/repo', { concurrency: 1, maxRounds: 3 }, {
      fix: async (unit) => ({ success: true, filesChanged: unit.primaryFiles }),
      review: async () => { throw new RateLimitError(1770000000, 'usage limit'); },
    });
    const b = result.finalRun.results.find((r) => r.area.label === 'src/b');
    expect(b?.review?.decision).toBe('revise');          // original verdict kept, not turned into an error row
    expect(b?.review?.issues).toEqual(['bug in f']);
    // The actionable follow-up still reaches the aggregated summary for report/Linear filing.
    expect(result.finalRun.summary.recommendedActions.map((a) => a.title)).toContain('patch the bug');
  });
});
