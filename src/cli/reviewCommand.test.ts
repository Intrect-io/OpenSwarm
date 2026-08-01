import { describe, it, expect, vi } from 'vitest';
import {
  buildReviewWorkerResult,
  formatReviewOutput,
  runReviewCommand,
  resolveIssueFromBranch,
  ensureProjectMapping,
} from './reviewCommand.js';
import type { ReviewResult } from '../agents/agentPair.js';

// Only exercised by tests that do NOT override deps.getChangedFiles — every
// other test in this file supplies its own stub, so this mock never affects them.
const getChangedFilesMock = vi.fn(async () => ['x.ts']);
vi.mock('../support/gitTracker.js', () => ({ getChangedFiles: getChangedFilesMock }));

describe('buildReviewWorkerResult (INT-1955)', () => {
  it('synthesizes a WorkerResult from changed files', () => {
    const wr = buildReviewWorkerResult(['a.ts', 'b.ts']);
    expect(wr).toMatchObject({ success: true, filesChanged: ['a.ts', 'b.ts'], commands: [] });
    expect(wr.summary).toContain('2');
  });
});

describe('formatReviewOutput (INT-1955)', () => {
  it('renders decision, feedback, issues, suggestions, follow-ups', () => {
    const review: ReviewResult = {
      decision: 'approve',
      feedback: 'looks good',
      issues: ['minor naming'],
      suggestions: ['add a test'],
      recommendedActions: [{ type: 'test', title: 'cover edge case', location: 'a.ts:3' }],
    };
    const out = formatReviewOutput(review);
    expect(out).toContain('Decision: APPROVE');
    expect(out).toContain('looks good');
    expect(out).toContain('- minor naming');
    expect(out).toContain('- add a test');
    expect(out).toContain('[test] cover edge case (a.ts:3)');
  });

  it('color mode wraps with ANSI but keeps plain substrings (INT-1966)', () => {
    const review: ReviewResult = { decision: 'reject', feedback: 'nope' };
    const colored = formatReviewOutput(review, true);
    expect(colored).toContain('\x1b['); // has ANSI codes
    expect(colored).toContain('Decision: REJECT'); // substring still intact
    expect(formatReviewOutput(review, false)).not.toContain('\x1b['); // plain by default
  });
});

describe('resolveIssueFromBranch (INT-1967)', () => {
  it('extracts an uppercased issue id from common branch shapes', () => {
    expect(resolveIssueFromBranch('unoheeofficial/int-1705-fix-foo')).toBe('INT-1705');
    expect(resolveIssueFromBranch('swarm/INT-1821-s8-plan')).toBe('INT-1821');
    expect(resolveIssueFromBranch('feat/int-1967-branch-infer')).toBe('INT-1967');
  });
  it('returns undefined when no issue id is present', () => {
    expect(resolveIssueFromBranch('main')).toBeUndefined();
    expect(resolveIssueFromBranch('develop')).toBeUndefined();
  });
});

describe('ensureProjectMapping (INT-2599)', () => {
  // A path with no openswarm.json, so resolveProjectId(cwd) always misses and
  // each test's own stubs drive the rest of the decision tree.
  const unmappedCwd = '/tmp/openswarm-test-ensure-project-mapping-unmapped';

  it('short-circuits without touching Linear when an explicit parent is given', async () => {
    const resolveCredential = vi.fn(async () => ({ apiKey: 'x' }));
    const result = await ensureProjectMapping(unmappedCwd, 'INT-1', { resolveCredential });
    expect(result).toEqual({ projectId: undefined, abort: false });
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('proceeds without a project when Linear is not configured at all', async () => {
    const result = await ensureProjectMapping(unmappedCwd, undefined, {
      resolveCredential: async () => null,
    });
    expect(result).toEqual({ projectId: undefined, abort: false });
  });

  it('fails closed (no orphan issue) when unmapped and there is no terminal to prompt', async () => {
    const logs: string[] = [];
    const pickAndSave = vi.fn();
    const result = await ensureProjectMapping(unmappedCwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: false,
      pickAndSave,
      log: (l) => logs.push(l),
    });
    expect(result).toEqual({ projectId: undefined, abort: true });
    expect(pickAndSave).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/openswarm add/);
  });

  it('maps interactively on a TTY and returns the saved project id', async () => {
    const pickAndSave = vi.fn(async () => ({
      kind: 'saved' as const,
      teamId: 'team-1',
      mapping: { teamId: 'team-1', projectId: 'proj-1', projectName: 'Demo' },
    }));
    const result = await ensureProjectMapping(unmappedCwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: true,
      pickAndSave,
    });
    expect(result).toEqual({ projectId: 'proj-1', abort: false });
    expect(pickAndSave).toHaveBeenCalledWith(unmappedCwd, { apiKey: 'x' });
  });

  it('fails closed when the Linear team lookup itself fails (no-teams is not a user choice) (INT-2619)', async () => {
    const result = await ensureProjectMapping(unmappedCwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: true,
      pickAndSave: async () => ({ kind: 'no-teams' as const }),
    });
    expect(result).toEqual({ projectId: undefined, abort: true });
  });

  it('proceeds without a project when the user actively skips the interactive picker', async () => {
    const result = await ensureProjectMapping(unmappedCwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: true,
      pickAndSave: async () => ({ kind: 'skipped' as const }),
    });
    expect(result).toEqual({ projectId: undefined, abort: false });
  });
});

describe('runReviewCommand --issues branch inference (INT-1967)', () => {
  const approveWithFollowups = async () =>
    ({ decision: 'approve', feedback: 'ok', recommendedActions: [{ type: 'test', title: 't' }] }) as ReviewResult;

  it('infers the parent from the branch when --issues has no value', async () => {
    const fileFollowups = vi.fn(async () => 1);
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: true },
      {
        getChangedFiles: async () => ['x.ts'],
        review: approveWithFollowups,
        getBranch: async () => 'feat/int-1705-thing',
        fileFollowups,
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(fileFollowups).toHaveBeenCalledWith('INT-1705', expect.anything());
    expect(logs.join('\n')).toContain('inferred from branch');
  });

  it('warns to connect Linear when nothing is filed (INT-1969)', async () => {
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: true },
      {
        getChangedFiles: async () => ['x.ts'],
        review: approveWithFollowups,
        getBranch: async () => 'main',
        fileFollowups: async () => 0, // e.g. Linear not configured
        ensureProjectMapping: async () => ({ projectId: undefined, abort: false }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(logs.join('\n')).toMatch(/Linear connected|auth login/);
  });

  it('uses an explicit id over branch inference', async () => {
    const fileFollowups = vi.fn(async () => 1);
    const getBranch = vi.fn(async () => 'feat/int-9999-x');
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      { getChangedFiles: async () => ['x.ts'], review: approveWithFollowups, getBranch, fileFollowups, startProgress: () => null, log: () => {} },
    );
    expect(fileFollowups).toHaveBeenCalledWith('INT-1', expect.anything());
    expect(getBranch).not.toHaveBeenCalled();
  });

  it('files standalone issues when --issues is set but the branch has no issue id (INT-1968)', async () => {
    const fileFollowups = vi.fn(async () => 2);
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: true },
      {
        getChangedFiles: async () => ['x.ts'],
        review: approveWithFollowups,
        getBranch: async () => 'main',
        fileFollowups,
        ensureProjectMapping: async () => ({ projectId: undefined, abort: false }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(fileFollowups).toHaveBeenCalledWith(undefined, expect.anything()); // no parent → standalone
    expect(logs.join('\n')).toMatch(/standalone follow-up issue/);
  });
});

describe('runReviewCommand (INT-1955)', () => {
  it('returns null and skips review when there are no changes', async () => {
    const review = vi.fn();
    const out = await runReviewCommand({}, { getChangedFiles: async () => [], review, log: () => {} });
    expect(out).toBeNull();
    expect(review).not.toHaveBeenCalled();
  });

  it('does not review repository-local OpenSwarm logs as user code', async () => {
    const review = vi.fn();
    const out = await runReviewCommand({}, {
      getChangedFiles: async () => ['.openswarm/review-history/old.json', '.openswarm/audit/audit-old.md'],
      review,
      log: () => {},
    });
    expect(out).toBeNull();
    expect(review).not.toHaveBeenCalled();
  });

  it('runs the reviewer over changed files and prints the verdict', async () => {
    const logs: string[] = [];
    const review = vi.fn(async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult);
    const out = await runReviewCommand(
      {},
      { getChangedFiles: async () => ['x.ts'], review, log: (l) => logs.push(l) },
    );
    expect(review).toHaveBeenCalledOnce();
    expect(out?.decision).toBe('approve');
    expect(logs.join('\n')).toContain('Decision: APPROVE');
  });

  it('files follow-ups when --file is set and the reviewer recommends actions', async () => {
    const fileFollowups = vi.fn(async () => 2);
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['x.ts'],
        review: async () =>
          ({ decision: 'approve', feedback: 'ok', recommendedActions: [{ type: 'test', title: 't' }] }) as ReviewResult,
        fileFollowups,
        log: () => {},
      },
    );
    expect(fileFollowups).toHaveBeenCalledWith('INT-1', expect.objectContaining({ decision: 'approve' }));
  });

  it('forwards an onLog progress callback to the reviewer (INT-1963)', async () => {
    let received: ((line: string) => void) | undefined;
    const logs: string[] = [];
    await runReviewCommand(
      {},
      {
        getChangedFiles: async () => ['x.ts'],
        review: async (_wr, _cwd, onLog) => {
          received = onLog;
          onLog?.('🔧 read_file: x.ts');
          return { decision: 'approve', feedback: 'ok' } as ReviewResult;
        },
        // no TTY spinner in this test → onLog falls back to log()
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(typeof received).toBe('function');
    expect(logs.join('\n')).toContain('🔧 read_file: x.ts');
  });

  it('routes onLog to the progress note when a spinner is active (INT-1963)', async () => {
    const notes: string[] = [];
    const stop = vi.fn();
    const logs: string[] = [];
    await runReviewCommand(
      {},
      {
        getChangedFiles: async () => ['x.ts'],
        review: async (_wr, _cwd, onLog) => {
          onLog?.('🔧 edit_file: x.ts');
          return { decision: 'approve', feedback: 'ok' } as ReviewResult;
        },
        startProgress: () => ({ note: (l) => notes.push(l), stop }),
        log: (l) => logs.push(l),
      },
    );
    expect(notes).toContain('🔧 edit_file: x.ts');
    expect(stop).toHaveBeenCalled();
    // activity went to the spinner, not the plain log
    expect(logs.join('\n')).not.toContain('· 🔧 edit_file');
  });

  it('hints about --file when follow-ups exist but no parent issue is given (INT-1966)', async () => {
    const logs: string[] = [];
    await runReviewCommand(
      {},
      {
        getChangedFiles: async () => ['x.ts'],
        review: async () =>
          ({ decision: 'approve', feedback: 'ok', recommendedActions: [{ type: 'test', title: 't' }] }) as ReviewResult,
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    const out = logs.join('\n');
    expect(out).toMatch(/1 follow-up\(s\) suggested/);
    expect(out).toContain('--issues');
  });

  it('does not file when there are no recommendedActions', async () => {
    const fileFollowups = vi.fn(async () => 0);
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['x.ts'],
        review: async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult,
        fileFollowups,
        log: () => {},
      },
    );
    expect(fileFollowups).not.toHaveBeenCalled();
  });

  it('forwards prior review logs, suppresses unchanged duplicate follow-ups, and saves the deduped result', async () => {
    const review = vi.fn(async () => ({
      decision: 'revise',
      feedback: 'still present',
      issues: ['x.ts is still broken'],
      recommendedActions: [{ type: 'bug', title: 'Fix X', location: 'x.ts:9' }],
    }) as ReviewResult);
    const saveHistory = vi.fn(async () => undefined);
    const logs: string[] = [];

    const result = await runReviewCommand({}, {
      getChangedFiles: async () => ['x.ts'],
      loadHistory: async () => ({
        context: '[2026-07-20] prior review: Fix X',
        currentHashes: { 'x.ts': 'file:same' },
        records: [{
          version: 1 as const,
          createdAt: '2026-07-20T00:00:00.000Z',
          kind: 'direct' as const,
          files: ['x.ts'],
          fileHashes: { 'x.ts': 'file:same' },
          review: {
            decision: 'revise' as const,
            feedback: 'first pass',
            recommendedActions: [{ type: 'bug', title: 'Fix X', location: 'x.ts:1' }],
          },
        }],
      }),
      review,
      saveHistory,
      startProgress: () => null,
      log: (line) => logs.push(line),
    });

    expect(review.mock.calls[0]?.[3]).toBe('[2026-07-20] prior review: Fix X');
    expect(result?.issues).toEqual(['x.ts is still broken']);
    expect(result?.recommendedActions).toEqual([]);
    expect(saveHistory).toHaveBeenCalledWith(process.cwd(), ['x.ts'], result, undefined);
    expect(logs.join('\n')).toContain('Suppressed 1 duplicate follow-up');
  });
});

describe('runReviewCommand --base (INT-2552)', () => {
  it('forwards --base as the `since` arg to getChangedFiles (CI committed-diff mode)', async () => {
    getChangedFilesMock.mockClear();
    getChangedFilesMock.mockResolvedValueOnce(['x.ts']);
    const review = vi.fn(async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult);
    await runReviewCommand({ base: 'origin/main' }, { review, log: () => {} });
    expect(getChangedFilesMock).toHaveBeenCalledWith(process.cwd(), 'origin/main');
  });

  it('does not pass a `since` arg without --base (working-tree mode unchanged)', async () => {
    getChangedFilesMock.mockClear();
    getChangedFilesMock.mockResolvedValueOnce(['x.ts']);
    const review = vi.fn(async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult);
    await runReviewCommand({}, { review, log: () => {} });
    expect(getChangedFilesMock).toHaveBeenCalledWith(process.cwd(), undefined);
  });

  it('the no-changes message names the base ref instead of "working-tree"', async () => {
    getChangedFilesMock.mockClear();
    getChangedFilesMock.mockResolvedValueOnce([]);
    const logs: string[] = [];
    const out = await runReviewCommand({ base: 'origin/main' }, { log: (l) => logs.push(l) });
    expect(out).toBeNull();
    expect(logs.join('\n')).toContain('origin/main');
  });
});

describe('runReviewCommand machine-readable output (INT-3102)', () => {
  const reviewed = async () =>
    ({
      decision: 'revise',
      feedback: 'CSRF validation removed',
      issues: ['the session fixture depends on it'],
      recommendedActions: [{ type: 'bug', title: 'Restore the guard', location: 'src/auth.ts:42' }],
    }) as ReviewResult;

  it('--json writes the verdict to stdout and keeps prose off it', async () => {
    // Mixing the human report into stdout would break `review --json | jq`.
    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    const logs: string[] = [];
    try {
      await runReviewCommand(
        { json: true },
        { getChangedFiles: async () => ['x.ts'], review: reviewed, startProgress: () => null, log: (l) => logs.push(l) },
      );
    } finally {
      write.mockRestore();
    }

    const parsed = JSON.parse(stdout.join(''));
    expect(parsed).toMatchObject({ schemaVersion: 1, decision: 'revise', gateRan: true });
    expect(parsed.findings[0]).toMatchObject({ file: 'src/auth.ts', line: 42 });
    // The human verdict block must not have gone to stdout as well.
    expect(logs.join('\n')).not.toContain('Decision: REVISE');
  });

  it('still prints the human report when --json is absent', async () => {
    const logs: string[] = [];
    await runReviewCommand(
      {},
      { getChangedFiles: async () => ['x.ts'], review: reviewed, startProgress: () => null, log: (l) => logs.push(l) },
    );
    expect(logs.join('\n')).toContain('Decision: REVISE');
  });

  it('--sarif writes a report and reports where it went', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'osw-sarif-'));
    const target = join(dir, 'out.sarif');
    const logs: string[] = [];

    await runReviewCommand(
      { sarif: target },
      { getChangedFiles: async () => ['x.ts'], review: reviewed, startProgress: () => null, log: (l) => logs.push(l) },
    );

    const sarif = JSON.parse(await readFile(target, 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/auth.ts');
    expect(logs.join('\n')).toContain('SARIF report written');
  });

  it('an unwritable SARIF path warns instead of failing the gate', async () => {
    // The verdict already exists and must still decide the exit code (INT-3100).
    const logs: string[] = [];
    const result = await runReviewCommand(
      { sarif: '/nonexistent-directory-openswarm/out.sarif' },
      { getChangedFiles: async () => ['x.ts'], review: reviewed, startProgress: () => null, log: (l) => logs.push(l) },
    );
    expect(result?.decision).toBe('revise');
    expect(logs.join('\n')).toContain('Could not write SARIF report');
  });
});
