import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';
import {
  aggregateAuditResults,
  buildAuditReviewerOptions,
  formatAuditReport,
  formatAuditSummary,
  runMaxReview,
  type AuditArea,
  type AuditAreaResult,
  type AuditProgress,
} from './reviewAudit.js';

const mkAreas = (n: number): AuditArea[] =>
  Array.from({ length: n }, (_, i) => ({
    label: `src/m${i}`,
    dir: `src/m${i}`,
    files: [`src/m${i}/f.ts`],
  }));

describe('buildAuditReviewerOptions (AGT-3990)', () => {
  it('forwards the max-review turn and timeout overrides to each reviewer', () => {
    const area: AuditArea = { label: 'src/auth', dir: 'src/auth', files: ['src/auth/token.ts'] };
    const onLog = () => {};
    const options = buildAuditReviewerOptions(area, '/repo', {
      concurrency: 2,
      adapter: 'codex',
      maxTurns: 7,
      timeoutMs: 123_456,
      priorReviewContextByArea: { 'src/auth': 'prior evidence' },
    }, onLog);

    expect(options).toMatchObject({
      mode: 'audit',
      projectPath: '/repo',
      adapterName: 'codex',
      maxTurns: 7,
      timeoutMs: 123_456,
      priorReviewContext: 'prior evidence',
      onLog,
    });
    expect(options.workerResult.filesChanged).toEqual(['src/auth/token.ts']);
  });
});

describe('reviewer failure reporting (AGT-3990)', () => {
  const errored = (error?: string): AuditAreaResult[] => [
    { area: { label: 'src/a', dir: 'src/a', files: ['src/a/f.ts'] }, error },
  ];

  it('carries the subagent error into the area summary', () => {
    expect(aggregateAuditResults(errored('codex timeout after 300000ms')).areas[0].error)
      .toBe('codex timeout after 300000ms');
  });

  it('falls back to a placeholder when an area produced neither verdict nor error', () => {
    expect(aggregateAuditResults(errored(undefined)).areas[0].error).toBe('no result');
  });

  it('prints the reason in the terminal summary instead of a bare failure label', () => {
    const out = formatAuditSummary(aggregateAuditResults(errored('codex timeout after 300000ms')));
    expect(out).toContain('codex timeout after 300000ms');
  });

  it('collapses a multi-line error so one failure stays one row', () => {
    const out = formatAuditSummary(aggregateAuditResults(errored('codex failed\n  at spawn\n  at run')));
    const row = out.split('\n').find((line) => line.includes('src/a'))!;
    expect(row).toContain('codex failed at spawn at run');
  });

  it('strips terminal controls from failure reasons before report rendering', () => {
    const summary = aggregateAuditResults(errored('\u001b]52;c;clipboard\u0007\u001b[31mcodex failed\u001b[0m'));
    const terminal = formatAuditSummary(summary);
    const markdown = formatAuditReport(summary, 'repo', 'ts');
    expect(terminal).toContain('codex failed');
    expect(markdown).toContain('codex failed');
    expect(terminal).not.toContain('\u001b');
    expect(markdown).not.toContain('\u001b');
  });

  it('truncates a runaway error rather than flooding the report', () => {
    const md = formatAuditReport(aggregateAuditResults(errored('x'.repeat(1000))), 'repo', 'ts');
    const row = md.split('\n').find((line) => line.startsWith('- src/a'))!;
    expect(row.length).toBeLessThan(340);
    expect(row).toContain('…');
  });
});

describe('reviewer infrastructure abort (AGT-3990)', () => {
  it('gives up after consecutive infra failures with no verdict, skipping the rest', async () => {
    let calls = 0;
    const review = async (): Promise<ReviewResult> => {
      calls++;
      throw new Error('codex timeout after 300000ms');
    };
    const run = await runMaxReview(mkAreas(10), '/repo', { concurrency: 1 }, { review });
    expect(run.infraAbort).toContain('codex timeout after 300000ms');
    expect(calls).toBe(3);
    expect(run.summary.failed).toBe(10);
  });

  it('reports the first failure in the consecutive infrastructure streak', async () => {
    const errors = ['codex spawn failed: ENOENT', 'codex timeout after 10ms', 'codex timeout after 20ms'];
    let calls = 0;
    const run = await runMaxReview(mkAreas(5), '/repo', { concurrency: 1 }, {
      review: async () => { throw new Error(errors[calls++] ?? 'unexpected review'); },
    });
    expect(run.infraAbort).toContain(errors[0]);
    expect(run.infraAbort).not.toContain(errors[2]);
  });

  it('does not give up while any area has produced a verdict', async () => {
    let calls = 0;
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      calls++;
      if (area.label !== 'src/m0') throw new Error('codex timeout after 300000ms');
      return { decision: 'approve', feedback: '' };
    };
    const run = await runMaxReview(mkAreas(10), '/repo', { concurrency: 1 }, { review });
    expect(run.infraAbort).toBeUndefined();
    expect(calls).toBe(10);
  });

  it('gives up at concurrency > 1 once every in-flight review has failed', async () => {
    let calls = 0;
    const review = async (): Promise<ReviewResult> => {
      calls++;
      throw new Error('codex timeout after 300000ms');
    };
    const run = await runMaxReview(mkAreas(12), '/repo', { concurrency: 4 }, { review });
    expect(run.infraAbort).toContain('codex timeout after 300000ms');
    expect(calls).toBeLessThan(12);
    expect(run.summary.failed).toBe(12);
  });

  it('does not give up while a concurrent healthy review is still in flight', async () => {
    let calls = 0;
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      calls++;
      if (area.label !== 'src/m0') throw new Error('codex timeout after 300000ms');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { decision: 'approve', feedback: '' };
    };
    const run = await runMaxReview(mkAreas(8), '/repo', { concurrency: 4 }, { review });
    expect(run.infraAbort).toBeUndefined();
    expect(calls).toBe(8);
    expect(run.summary.completed).toBe(1);
  });

  it('revokes a tentative give-up when a slow non-infra result breaks the streak', async () => {
    let calls = 0;
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      calls++;
      if (area.label === 'src/m0') {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error('reviewer returned malformed output');
      }
      throw new Error('codex timeout after 300000ms');
    };
    const run = await runMaxReview(mkAreas(8), '/repo', { concurrency: 4 }, { review });
    expect(run.infraAbort).toBeUndefined();
    expect(calls).toBe(8);
  });

  it('does not give up on failures that are not infrastructural', async () => {
    let calls = 0;
    const review = async (): Promise<ReviewResult> => {
      calls++;
      throw new Error('reviewer disagreed with the premise');
    };
    const run = await runMaxReview(mkAreas(6), '/repo', { concurrency: 1 }, { review });
    expect(run.infraAbort).toBeUndefined();
    expect(calls).toBe(6);
  });

  it('resets the consecutive infra streak when a non-infra failure intervenes', async () => {
    let calls = 0;
    const review = async (): Promise<ReviewResult> => {
      calls++;
      if (calls === 2) throw new Error('reviewer disagreed with the premise');
      throw new Error('codex timeout after 300000ms');
    };
    const run = await runMaxReview(mkAreas(8), '/repo', { concurrency: 1 }, { review });
    expect(run.infraAbort).toContain('codex timeout after 300000ms');
    expect(calls).toBe(5);
  });

  it('emits the give-up decision as a batch notice', async () => {
    const events: AuditProgress[] = [];
    await runMaxReview(mkAreas(5), '/repo', { concurrency: 1 }, {
      review: async () => { throw new Error('codex timeout after 300000ms'); },
      onProgress: (event) => events.push(event),
    });
    const notice = events.find((event) => event.type === 'notice');
    expect(notice && 'line' in notice && notice.line).toContain('never produced a verdict');
  });
});
