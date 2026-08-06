import { describe, it, expect, vi } from 'vitest';
import { parsePRRef } from './prResolve.js';
import {
  classifyBlocker,
  formatPrStatus,
  isCriticalCommentBody,
  summarizeChangesRequested,
  summarizeCriticalComments,
  type PrStatusSnapshot,
} from './prStatus.js';
import { runPrCommand, type PrCommandDeps } from './prCommand.js';

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
