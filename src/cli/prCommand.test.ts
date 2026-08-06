import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePRRef } from './prResolve.js';
import {
  classifyBlocker,
  formatPrStatus,
  isCriticalCommentBody,
  summarizeChangesRequested,
  summarizeCriticalComments,
  type PrStatusSnapshot,
} from './prStatus.js';
import { loadConfig } from '../core/config.js';

const { fixOneImpl, reviewOneImpl, PRProcessorCtor } = vi.hoisted(() => {
  const fixOneImpl = vi.fn(async () => ({ success: true, iterations: 1 }));
  const reviewOneImpl = vi.fn(async () => ({ success: true, iterations: 0 }));
  const PRProcessorCtor = vi.fn().mockImplementation(function PRProcessor(this: unknown) {
    return { fixOne: fixOneImpl, reviewOne: reviewOneImpl };
  });
  return { fixOneImpl, reviewOneImpl, PRProcessorCtor };
});
vi.mock('../automation/prProcessor.js', () => ({ PRProcessor: PRProcessorCtor }));

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({ autonomous: { defaultRoles: { worker: { model: 'x' } } } })),
}));

const { waitForCICompletionImpl } = vi.hoisted(() => ({
  waitForCICompletionImpl: vi.fn(async () => ({ status: 'success' })),
}));
vi.mock('../github/github.js', () => ({ waitForCICompletion: waitForCICompletionImpl }));

const { runPrCommand, resolveNumber, resolveRepoOverride, loadRolesBestEffort, buildProcessorConfig } = await import('./prCommand.js');
type PrCommandDeps = Parameters<typeof runPrCommand>[2];

describe('parsePRRef (INT-3282)', () => {
  it('parses owner/repo#n', () => {
    expect(parsePRRef('intrect/OpenSwarm#42')).toEqual({ repo: 'intrect/OpenSwarm', number: 42 });
  });
  it('parses #n and bare n', () => {
    expect(parsePRRef('#7')).toEqual({ number: 7 });
    expect(parsePRRef('7')).toEqual({ number: 7 });
  });
  it('rejects garbage', () => {
    expect(() => parsePRRef('not-a-pr')).toThrow(/Invalid PR ref/);
  });
});

describe('classifyBlocker (INT-3282)', () => {
  it('orders conflicts > comments > ci > pending > none', () => {
    expect(classifyBlocker({
      hasConflicts: true,
      changesRequestedCount: 1,
      criticalCommentCount: 0,
      ci: { status: 'failure', failedChecks: [{ name: 't', conclusion: 'failure' }] },
    })).toBe('conflicts');

    expect(classifyBlocker({
      hasConflicts: false,
      changesRequestedCount: 1,
      criticalCommentCount: 0,
      ci: { status: 'failure', failedChecks: [{ name: 't', conclusion: 'failure' }] },
    })).toBe('comments');

    expect(classifyBlocker({
      hasConflicts: false,
      changesRequestedCount: 0,
      criticalCommentCount: 0,
      ci: { status: 'failure', failedChecks: [{ name: 't', conclusion: 'failure' }] },
    })).toBe('ci');

    expect(classifyBlocker({
      hasConflicts: false,
      changesRequestedCount: 0,
      criticalCommentCount: 0,
      ci: { status: 'pending' },
    })).toBe('pending_ci');

    expect(classifyBlocker({
      hasConflicts: false,
      changesRequestedCount: 0,
      criticalCommentCount: 0,
      ci: { status: 'success' },
    })).toBe('none');
  });
});

describe('comment helpers (INT-3282)', () => {
  it('detects critical bodies', () => {
    expect(isCriticalCommentBody('must fix this bug')).toBe(true);
    expect(isCriticalCommentBody('looks fine')).toBe(false);
  });

  it('summarizes CHANGES_REQUESTED from latest review per author', () => {
    const out = summarizeChangesRequested([
      { id: 1, author: 'a', body: 'old', createdAt: '2026-01-01T00:00:00Z', state: 'CHANGES_REQUESTED' },
      { id: 2, author: 'a', body: 'new', createdAt: '2026-01-02T00:00:00Z', state: 'APPROVED' },
      { id: 3, author: 'b', body: 'fix pls', createdAt: '2026-01-02T00:00:00Z', state: 'CHANGES_REQUESTED' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].author).toBe('b');
  });

  it('filters critical issue comments', () => {
    expect(summarizeCriticalComments([
      { author: 'bot', body: 'critical: null deref' },
      { author: 'bot', body: 'nit: naming' },
    ])).toHaveLength(1);
  });
});

describe('formatPrStatus (INT-3282)', () => {
  it('renders ready and blocked states', () => {
    const ready: PrStatusSnapshot = {
      repo: 'o/r',
      number: 1,
      title: 't',
      branch: 'feat',
      url: 'https://example/pr/1',
      mergeable: true,
      hasConflicts: false,
      ci: { status: 'success' },
      changesRequested: [],
      criticalComments: [],
      blocker: 'none',
      mergeReady: true,
    };
    expect(formatPrStatus(ready)).toMatch(/ready:\s+yes/);
    expect(formatPrStatus({ ...ready, blocker: 'ci', mergeReady: false, ci: { status: 'failure', failedChecks: [{ name: 'lint', conclusion: 'failure' }] } }))
      .toMatch(/FAIL \(lint\)/);
  });
});

const resolved = {
  repo: 'o/r',
  number: 9,
  title: 'Ship it',
  branch: 'feat/x',
  url: 'https://example/pr/9',
};

function mkDeps(over: Partial<PrCommandDeps> = {}): PrCommandDeps {
  return {
    resolve: vi.fn(async () => resolved),
    gatherStatus: vi.fn(async () => ({
      ...resolved,
      mergeable: true,
      hasConflicts: false,
      ci: { status: 'success' as const },
      changesRequested: [],
      criticalComments: [],
      blocker: 'none' as const,
      mergeReady: true,
    })),
    fixOne: vi.fn(async () => ({ success: true, iterations: 1 })),
    reviewOne: vi.fn(async () => ({ success: true, iterations: 1 })),
    waitCI: vi.fn(async () => ({ status: 'success' })),
    create: vi.fn(async () => ({ url: resolved.url, message: `Created PR: ${resolved.url}` })),
    log: vi.fn(),
    loadRoles: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  fixOneImpl.mockClear().mockResolvedValue({ success: true, iterations: 1 });
  reviewOneImpl.mockClear().mockResolvedValue({ success: true, iterations: 0 });
  PRProcessorCtor.mockClear();
  waitForCICompletionImpl.mockClear().mockResolvedValue({ status: 'success' });
});

describe('resolveNumber / resolveRepoOverride (INT-3282)', () => {
  it('passes a numeric --number through unchanged', () => {
    expect(resolveNumber({ number: 9 })).toBe(9);
  });
  it('parses a string --number', () => {
    expect(resolveNumber({ number: '9' })).toBe(9);
  });
  it('is undefined when no --number is given', () => {
    expect(resolveNumber({})).toBeUndefined();
  });

  it('prefers an explicit --repo', () => {
    expect(resolveRepoOverride({ repo: 'o/r' })).toBe('o/r');
  });
  it('infers repo from an owner/repo#n --number string', () => {
    expect(resolveRepoOverride({ number: 'o/r#9' })).toBe('o/r');
  });
  it('is undefined when neither is present', () => {
    expect(resolveRepoOverride({ number: 9 })).toBeUndefined();
  });
});

describe('loadRolesBestEffort / buildProcessorConfig (INT-3282)', () => {
  it('reads defaultRoles from config', () => {
    expect(loadRolesBestEffort()).toEqual({ worker: { model: 'x' } });
  });

  it('enables the conflict resolver by default', () => {
    const config = buildProcessorConfig({});
    expect(config.conflictResolver?.enabled).toBe(true);
    expect(config.maxIterations).toBe(3);
    expect(config.maxRetries).toBe(3);
  });

  it('omits the conflict resolver when --no-conflicts is set', () => {
    const config = buildProcessorConfig({ noConflicts: true });
    expect(config.conflictResolver).toBeUndefined();
  });

  it('honors explicit maxIterations/maxRetries', () => {
    const config = buildProcessorConfig({ maxIterations: 5, maxRetries: 1 });
    expect(config.maxIterations).toBe(5);
    expect(config.maxRetries).toBe(1);
  });

  it('falls back to undefined when loadConfig throws', () => {
    vi.mocked(loadConfig).mockImplementationOnce(() => {
      throw new Error('no config file');
    });
    expect(loadRolesBestEffort()).toBeUndefined();
  });
});

describe('runPrCommand default fix/review wiring (INT-3282)', () => {
  // These omit deps.fixOne/deps.reviewOne so the real defaultFixOne/defaultReviewOne
  // run against a mocked PRProcessor — the only way to exercise that wiring, since
  // every other test in this file injects fixOne/reviewOne directly.
  it('fix builds a PRProcessor and calls its fixOne when not overridden', async () => {
    const result = await runPrCommand('fix', {}, { resolve: async () => resolved, log: vi.fn() });
    expect(PRProcessorCtor).toHaveBeenCalledTimes(1);
    expect(fixOneImpl).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'o/r', number: 9 }),
      expect.any(String),
    );
    expect(result.exitCode).toBe(0);
  });

  it('review builds a PRProcessor and calls its reviewOne when not overridden', async () => {
    const result = await runPrCommand('review', {}, { resolve: async () => resolved, log: vi.fn() });
    expect(PRProcessorCtor).toHaveBeenCalledTimes(1);
    expect(reviewOneImpl).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'o/r', number: 9 }),
      expect.any(String),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe('runPrCommand (INT-3282)', () => {
  it('status returns formatted report and exit 0 when ready', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('status', {}, deps);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('o/r#9');
    expect(deps.gatherStatus).toHaveBeenCalled();
  });

  it('status exits 1 when blocked', async () => {
    const deps = mkDeps({
      gatherStatus: vi.fn(async () => ({
        ...resolved,
        mergeable: false,
        hasConflicts: true,
        ci: { status: 'pending' as const },
        changesRequested: [],
        criticalComments: [],
        blocker: 'conflicts' as const,
        mergeReady: false,
      })),
    });
    const result = await runPrCommand('status', {}, deps);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/conflicts/);
  });

  it('status --json emits JSON', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('status', { json: true }, deps);
    const parsed = JSON.parse(result.message);
    expect(parsed.number).toBe(9);
    expect(parsed.mergeReady).toBe(true);
  });

  it('fix delegates to fixOne', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('fix', {}, deps);
    expect(deps.fixOne).toHaveBeenCalledWith(resolved, expect.any(String), expect.any(Object));
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/fix completed/);
  });

  it('fix reports failure', async () => {
    const deps = mkDeps({
      fixOne: vi.fn(async () => ({ success: false, error: 'CI still red', iterations: 2 })),
    });
    const result = await runPrCommand('fix', {}, deps);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/CI still red/);
  });

  it('review delegates to reviewOne', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('review', {}, deps);
    expect(deps.reviewOne).toHaveBeenCalledWith(resolved, expect.any(String), expect.any(Object));
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/review feedback addressed/);
  });

  it('review reports failure', async () => {
    const deps = mkDeps({
      reviewOne: vi.fn(async () => ({ success: false, error: 'pipeline failed', iterations: 1 })),
    });
    const result = await runPrCommand('review', {}, deps);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/pipeline failed/);
  });

  it('watch returns immediately when already merge-ready', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('watch', { rounds: 3 }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/Merge-ready/);
    expect(deps.fixOne).not.toHaveBeenCalled();
  });

  it('watch fixes then rechecks until ready', async () => {
    let calls = 0;
    const deps = mkDeps({
      gatherStatus: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ...resolved,
            mergeable: true,
            hasConflicts: false,
            ci: { status: 'failure' as const, failedChecks: [{ name: 'test', conclusion: 'failure' }] },
            changesRequested: [],
            criticalComments: [],
            blocker: 'ci' as const,
            mergeReady: false,
          };
        }
        return {
          ...resolved,
          mergeable: true,
          hasConflicts: false,
          ci: { status: 'success' as const },
          changesRequested: [],
          criticalComments: [],
          blocker: 'none' as const,
          mergeReady: true,
        };
      }),
    });
    const result = await runPrCommand('watch', { rounds: 3 }, deps);
    expect(deps.fixOne).toHaveBeenCalledTimes(1);
    expect(deps.waitCI).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('watch waits out a pending_ci blocker instead of running a fix pass', async () => {
    let calls = 0;
    const deps = mkDeps({
      waitCI: undefined,
      gatherStatus: vi.fn(async () => {
        calls += 1;
        return {
          ...resolved,
          mergeable: false,
          hasConflicts: false,
          ci: { status: 'pending' as const },
          changesRequested: [],
          criticalComments: [],
          blocker: calls === 1 ? ('pending_ci' as const) : ('none' as const),
          mergeReady: calls > 1,
        };
      }),
    });
    const result = await runPrCommand('watch', { rounds: 3 }, deps);
    expect(waitForCICompletionImpl).toHaveBeenCalled();
    expect(deps.fixOne).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('watch reports a blocked message with exit 1 when the fix pass fails', async () => {
    const deps = mkDeps({
      fixOne: vi.fn(async () => ({ success: false, error: 'still red', iterations: 1 })),
      gatherStatus: vi.fn(async () => ({
        ...resolved,
        mergeable: false,
        hasConflicts: false,
        ci: { status: 'failure' as const, failedChecks: [{ name: 'test', conclusion: 'failure' }] },
        changesRequested: [],
        criticalComments: [],
        blocker: 'ci' as const,
        mergeReady: false,
      })),
    });
    const result = await runPrCommand('watch', { rounds: 3 }, deps);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/Blocked on round 1: still red/);
  });

  it('watch gives up and reports the last blocker after exhausting all rounds', async () => {
    const deps = mkDeps({
      gatherStatus: vi.fn(async () => ({
        ...resolved,
        mergeable: false,
        hasConflicts: false,
        ci: { status: 'failure' as const, failedChecks: [{ name: 'test', conclusion: 'failure' }] },
        changesRequested: [],
        criticalComments: [],
        blocker: 'ci' as const,
        mergeReady: false,
      })),
    });
    const result = await runPrCommand('watch', { rounds: 2 }, deps);
    expect(deps.fixOne).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/Gave up after 2 round\(s\)\. Last blocker: ci/);
  });

  it('watch uses the default fixOne/waitCI wiring when neither is injected', async () => {
    let calls = 0;
    const deps = mkDeps({
      fixOne: undefined,
      waitCI: undefined,
      gatherStatus: vi.fn(async () => {
        calls += 1;
        return {
          ...resolved,
          mergeable: calls > 1,
          hasConflicts: false,
          ci: { status: calls > 1 ? ('success' as const) : ('failure' as const), failedChecks: calls > 1 ? undefined : [{ name: 'test', conclusion: 'failure' }] },
          changesRequested: [],
          criticalComments: [],
          blocker: calls > 1 ? ('none' as const) : ('ci' as const),
          mergeReady: calls > 1,
        };
      }),
    });
    const result = await runPrCommand('watch', { rounds: 3 }, deps);
    expect(fixOneImpl).toHaveBeenCalled();
    expect(waitForCICompletionImpl).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('create delegates to createPrFromCwd wrapper', async () => {
    const deps = mkDeps();
    const result = await runPrCommand('create', { title: 'feat: x', noFix: true }, deps);
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'feat: x',
      fix: false,
    }));
    expect(result.exitCode).toBe(0);
  });

  it('rejects unknown actions', async () => {
    await expect(runPrCommand('frob', {}, mkDeps())).rejects.toThrow(/Unknown pr action/);
  });
});
