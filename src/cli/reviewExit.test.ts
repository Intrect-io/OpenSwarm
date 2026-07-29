import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../adapters/rateLimitError.js';
import {
  REVIEW_EXIT_GATE_NOT_RUN,
  REVIEW_EXIT_OK,
  REVIEW_EXIT_REJECT,
  describeReviewGateFailure,
} from './reviewExit.js';
import { runReviewCommand } from './reviewCommand.js';

describe('review exit-code contract (INT-3100)', () => {
  it('keeps the three outcomes distinct', () => {
    // CI reads only the exit code; 0 must be unreachable without a verdict.
    expect(REVIEW_EXIT_OK).toBe(0);
    expect(REVIEW_EXIT_REJECT).toBe(1);
    expect(REVIEW_EXIT_GATE_NOT_RUN).toBe(2);
    expect(new Set([REVIEW_EXIT_OK, REVIEW_EXIT_REJECT, REVIEW_EXIT_GATE_NOT_RUN]).size).toBe(3);
  });

  it('names the usage limit and its reset time in the gate-not-run message', () => {
    const resetsAt = 1_800_000_000; // fixed timestamp; format is locale-dependent, presence is not
    const message = describeReviewGateFailure(
      new RateLimitError(resetsAt, 'Codex 100% used of 10080min window', 100, 10080),
    );
    expect(message).toContain('did NOT run');
    expect(message).toContain('usage limit');
    expect(message).toContain('Codex 100% used of 10080min window');
    expect(message).toContain('Retry after');
  });

  it('reports a usage limit without a reset time without inventing one', () => {
    const message = describeReviewGateFailure(new RateLimitError(undefined, 'claude: usage limit reached'));
    expect(message).toContain('usage limit');
    expect(message).not.toContain('Retry after');
  });

  it('describes a non-quota infrastructure failure plainly', () => {
    const message = describeReviewGateFailure(new Error('claude cli failed: spawn ENOENT'));
    expect(message).toContain('did NOT run');
    expect(message).toContain('spawn ENOENT');
  });
});

describe('--max gate-not-run detection (INT-3100)', () => {
  it('a run where every area errored counts zero completed areas', async () => {
    // runReviewMaxCommand derives gateRan from summary.completed > 0; the CLI
    // maps gateRan=false to exit 2. Lock the aggregation invariant that feeds it.
    const { aggregateAuditResults } = await import('./reviewAudit.js');
    const summary = aggregateAuditResults([
      { area: { label: 'src (1/2)', dir: 'src', files: ['src/a.ts'] }, error: 'skipped: codex usage limit already hit this run' },
      { area: { label: 'src (2/2)', dir: 'src', files: ['src/b.ts'] }, error: 'usage limit reached' },
    ]);
    expect(summary.completed).toBe(0);
    expect(summary.decision).toBe('reject'); // still fails closed even if a caller ignores gateRan
  });

  it('one real verdict among errors keeps the gate as ran', async () => {
    const { aggregateAuditResults } = await import('./reviewAudit.js');
    const summary = aggregateAuditResults([
      { area: { label: 'src (1/2)', dir: 'src', files: ['src/a.ts'] }, review: { decision: 'approve', feedback: 'ok' } },
      { area: { label: 'src (2/2)', dir: 'src', files: ['src/b.ts'] }, error: 'usage limit reached' },
    ]);
    expect(summary.completed).toBe(1);
  });
});

describe('runReviewCommand post-verdict side-effects (INT-3100)', () => {
  it('returns the verdict even when follow-up filing throws', async () => {
    // A verdict exists — a Linear/network failure while filing must stay a
    // warning, not become gate-not-run (exit 2) or mask a reject (exit 1).
    const lines: string[] = [];
    const result = await runReviewCommand(
      { path: '/tmp', fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['src/a.ts'],
        review: async () => ({ decision: 'reject', feedback: 'bad', recommendedActions: [{ type: 'fix', title: 't' }] }),
        ensureProjectMapping: async () => ({ projectId: undefined, abort: false }),
        fileFollowups: async () => {
          throw new Error('Linear API unreachable');
        },
        startProgress: () => null,
        log: (l) => lines.push(l),
      },
    );
    expect(result?.decision).toBe('reject');
    expect(lines.join('\n')).toContain('Could not file follow-ups: Linear API unreachable');
  });
});

describe('runReviewCommand propagates a quota abort (INT-3100)', () => {
  it('rethrows RateLimitError instead of swallowing it into a fake verdict', async () => {
    // The CLI catch converts a propagated throw into exit 2 (gate-not-run).
    // If this were swallowed, a quota-exhausted run would print nothing and
    // exit 0 — the silent pass this contract exists to prevent.
    await expect(
      runReviewCommand(
        { path: '/tmp' },
        {
          getChangedFiles: async () => ['src/a.ts'],
          review: async () => {
            throw new RateLimitError(undefined, 'Codex 100% used of 10080min window');
          },
          startProgress: () => null,
          log: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
