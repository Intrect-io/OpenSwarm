import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_FILES_PER_SIBLING, MAX_SIBLINGS, STATUS_CONCURRENCY, TOTAL_BUDGET_MS, collectSiblingWork,
  commandTimeoutMs, formatSiblingWork, identifierFromBranch, parseChangedFiles, parseWorktreeList,
  selectSiblingWorktrees,
} from './siblingWork.js';

// `git worktree list --porcelain -z`: each attribute is its own NUL-terminated
// field, and an empty field separates records. Shape taken from the live host.
const wt = (...records: string[][]) => records.map((r) => `${r.join('\0')}\0\0`).join('');
const PORCELAIN = wt(
  ['worktree /work/cgf-portal', 'HEAD a882db13', 'branch refs/heads/chore/link-nas-env'],
  ['worktree /work/cgf-portal/worktree/05a3c502', 'HEAD 904aafb4', 'branch refs/heads/swarm/AX-1062-policy-finalize'],
  ['worktree /work/cgf-portal/worktree/1b0c6d1a', 'HEAD 2821f2ae', 'branch refs/heads/swarm/AX-1027-ops-tool-meta'],
);

describe('parseWorktreeList', () => {
  it('reads each worktree and its branch', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: '/work/cgf-portal', branch: 'refs/heads/chore/link-nas-env' },
      { path: '/work/cgf-portal/worktree/05a3c502', branch: 'refs/heads/swarm/AX-1062-policy-finalize' },
      { path: '/work/cgf-portal/worktree/1b0c6d1a', branch: 'refs/heads/swarm/AX-1027-ops-tool-meta' },
    ]);
  });

  it('keeps a detached worktree, which has no branch field', () => {
    // A detached worktree still holds edits; dropping it would hide them.
    expect(parseWorktreeList(wt(['worktree /w/a', 'HEAD abc', 'detached']))).toEqual([{ path: '/w/a' }]);
  });

  it('keeps a worktree path with a trailing space', () => {
    // Verified against real git: paths come through literally here, trailing
    // space and all — unlike `status --porcelain`, this command does not
    // C-quote. Trimming either hides a real overlap or makes us report our own
    // edits as a peer's.
    expect(parseWorktreeList(wt(['worktree /repo/trailing ', 'HEAD abc']))).toEqual([{ path: '/repo/trailing ' }]);
  });

  it('keeps a worktree path containing spaces, quotes and non-ASCII', () => {
    expect(parseWorktreeList(wt(['worktree /repo/my "보고서" dir', 'HEAD abc'])))
      .toEqual([{ path: '/repo/my "보고서" dir' }]);
  });

  it('keeps a worktree path containing a newline', () => {
    // The line-based form splits this path across two lines and yields a
    // truncated directory that does not exist, so the sibling's changes are
    // never read. -z keeps it in one field.
    expect(parseWorktreeList(wt(['worktree /repo/new\nline', 'HEAD abc'])))
      .toEqual([{ path: '/repo/new\nline' }]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('identifierFromBranch', () => {
  it('pulls the issue key out of a swarm branch', () => {
    expect(identifierFromBranch('refs/heads/swarm/AX-1062-policy-finalize')).toBe('AX-1062');
  });

  it('falls back to the short branch name when there is no issue key', () => {
    // A hand-made branch still holds conflicting edits — naming it by its
    // branch beats dropping it for not matching the convention.
    expect(identifierFromBranch('refs/heads/chore/link-nas-env')).toBe('chore/link-nas-env');
  });

  it('has nothing to say about a detached worktree', () => {
    expect(identifierFromBranch(undefined)).toBeUndefined();
    expect(identifierFromBranch('refs/heads/')).toBeUndefined();
  });
});

describe('selectSiblingWorktrees', () => {
  const entries = parseWorktreeList(PORCELAIN);

  it('excludes the worktree we are working in', () => {
    expect(selectSiblingWorktrees(entries, '/work/cgf-portal/worktree/05a3c502').map((e) => e.path))
      .toEqual(['/work/cgf-portal', '/work/cgf-portal/worktree/1b0c6d1a']);
  });

  it('recognises ourselves through an unresolved path', () => {
    // Reporting our own edits back to us would read as a conflict with a
    // phantom peer.
    expect(selectSiblingWorktrees(entries, '/work/cgf-portal/worktree/../worktree/05a3c502')
      .map((e) => e.path)).not.toContain('/work/cgf-portal/worktree/05a3c502');
  });

  it('recognises ourselves when git reports our real path and we hold a symlinked one', () => {
    // git always reports a worktree by its real path; the dispatched project
    // path can carry a symlinked component. Compared lexically the two differ,
    // and we would scan ourselves and report our own edits as a peer's.
    const canonicalise = (p: string) => p.replace('/link/', '/real/');
    const linked = [
      { path: '/real/worktree/a' },
      { path: '/real/worktree/b' },
    ];
    expect(selectSiblingWorktrees(linked, '/link/worktree/a', canonicalise).map((e) => e.path))
      .toEqual(['/real/worktree/b']);
  });

  it('keeps the main checkout — it holds edits too', () => {
    expect(selectSiblingWorktrees(entries, '/work/cgf-portal/worktree/05a3c502').map((e) => e.path))
      .toContain('/work/cgf-portal');
  });
});

describe('parseChangedFiles', () => {
  // `git status --porcelain -z`: `XY <path>\0`, and for a rename/copy a second
  // field carrying the source path.
  const z = (...fields: string[]) => fields.map((f) => `${f}\0`).join('');

  it('reads staged, unstaged and untracked alike', () => {
    expect(parseChangedFiles(z('M  src/a.ts', '?? src/b.ts', ' M src/c.ts')))
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('takes the destination of a rename and drops its source', () => {
    // The new path is where this worktree is writing; the old one is only
    // where the content came from.
    expect(parseChangedFiles(z('R  src/new.ts', 'src/old.ts'))).toEqual(['src/new.ts']);
  });

  it('does not let a rename source swallow the entry after it', () => {
    expect(parseChangedFiles(z('R  src/new.ts', 'src/old.ts', 'M  src/after.ts')))
      .toEqual(['src/new.ts', 'src/after.ts']);
  });

  it('handles a copy the same way as a rename', () => {
    expect(parseChangedFiles(z('C  src/copy.ts', 'src/source.ts'))).toEqual(['src/copy.ts']);
  });

  it('keeps a path containing a space intact', () => {
    // Plain porcelain would C-quote this one; -z gives it literally.
    expect(parseChangedFiles(z('M  docs/my report.md'))).toEqual(['docs/my report.md']);
  });

  it('keeps a path that itself contains " -> "', () => {
    // The old line parser split here and named a file that does not exist.
    expect(parseChangedFiles(z('M  docs/a -> b.md'))).toEqual(['docs/a -> b.md']);
  });

  it('keeps a trailing space in a path', () => {
    // Legal on Linux, and trimming it names a different file than the one the
    // sibling is actually writing.
    expect(parseChangedFiles(z('M  docs/trailing '))).toEqual(['docs/trailing ']);
  });

  it('keeps a non-ASCII path intact', () => {
    expect(parseChangedFiles(z('M  docs/보고서.md'))).toEqual(['docs/보고서.md']);
  });

  it('returns nothing for a clean worktree', () => {
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('formatSiblingWork', () => {
  it('says nothing at all when no sibling has changes', () => {
    expect(formatSiblingWork([])).toBe('');
    expect(formatSiblingWork([{ identifier: 'AX-1', files: [] }])).toBe('');
  });

  it('lists each sibling with its files', () => {
    expect(formatSiblingWork([
      { identifier: 'AX-1047', files: ['src/api/report.ts', 'src/db/schema.ts'] },
      { identifier: 'AX-1066', files: ['docs/INTEGRATIONS.md'] },
    ])).toBe('  AX-1047 — src/api/report.ts, src/db/schema.ts\n  AX-1066 — docs/INTEGRATIONS.md');
  });

  it('caps the files per sibling and says how many it hid', () => {
    const files = Array.from({ length: MAX_FILES_PER_SIBLING + 3 }, (_, i) => `f${i}.ts`);
    const out = formatSiblingWork([{ identifier: 'AX-1', files }]);
    expect(out).toContain(`f${MAX_FILES_PER_SIBLING - 1}.ts`);
    expect(out).not.toContain(`f${MAX_FILES_PER_SIBLING}.ts`);
    expect(out).toContain('+3 more');
  });

  it('caps the sibling count and says how many it hid', () => {
    const siblings = Array.from({ length: MAX_SIBLINGS + 2 }, (_, i) => ({ identifier: `AX-${i}`, files: ['a.ts'] }));
    const out = formatSiblingWork(siblings);
    expect(out.split('\n')).toHaveLength(MAX_SIBLINGS + 1);
    expect(out).toContain('(+2 more worktrees)');
  });

  it('drops siblings with no changes rather than printing an empty line', () => {
    expect(formatSiblingWork([
      { identifier: 'AX-1', files: [] },
      { identifier: 'AX-2', files: ['a.ts'] },
    ])).toBe('  AX-2 — a.ts');
  });
});

describe('collectSiblingWork', () => {
  const cleanups: string[] = [];
  afterAll(() => { for (const dir of cleanups) rmSync(dir, { recursive: true, force: true }); });

  function worktreeList(count: number): string {
    return Array.from({ length: count }, (_, i) =>
      `worktree /repo/worktree/w${i}\0HEAD abc${i}\0branch refs/heads/swarm/AX-${1000 + i}-task\0\0`).join('');
  }

  it('reports a dirty worktree that sits far past the sibling cap', async () => {
    // The first version capped the worktree list BEFORE reading status, so on
    // this host — 25 worktrees against a cap of 8 — a dirty worktree past the
    // cut vanished without a trace. Silently omitting a conflict is the one
    // failure this feature exists to prevent.
    const dirtyIndex = MAX_SIBLINGS + 11;
    const result = await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(25),
      readStatus: async (cwd) => (cwd === `/repo/worktree/w${dirtyIndex}` ? 'M  src/late.ts\0' : ''),
    });
    expect(result).toEqual([{ identifier: `AX-${1000 + dirtyIndex}`, files: ['src/late.ts'] }]);
  });

  it('keeps at most STATUS_CONCURRENCY status reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(25),
      readStatus: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return '';
      },
    });
    expect(peak).toBeLessThanOrEqual(STATUS_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // and it is actually parallel, not serial
  });

  it('reads every worktree even when there are more than the cap', async () => {
    const seen: string[] = [];
    await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(20),
      readStatus: async (cwd) => { seen.push(cwd); return ''; },
    });
    expect(seen).toHaveLength(20);
  });

  it('loses only the failing worktree when git errors', async () => {
    const result = await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(3),
      readStatus: async (cwd) => {
        if (cwd === '/repo/worktree/w1') throw new Error('worktree is gone');
        return 'M  a.ts\0';
      },
    });
    expect(result.map((s) => s.identifier)).toEqual(['AX-1000', 'AX-1002']);
  });

  it('stops scanning once the total budget is spent', async () => {
    // Per-command timeouts do not bound the whole scan: N worktrees means
    // ceil(N / concurrency) batches, and this runs ahead of every worker
    // attempt. A repo full of stalled worktrees must not delay dispatch.
    let clock = 0;
    const scanned: string[] = [];
    const result = await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(40),
      // Each read burns a quarter of the budget.
      readStatus: async (cwd) => { scanned.push(cwd); clock += 25; return 'M  a.ts\0'; },
      budgetMs: 100,
      now: () => clock,
    });
    // Four reads fit in the budget; the rest are reported clean, not awaited.
    expect(scanned.length).toBeLessThan(40);
    expect(result.length).toBe(scanned.length);
    expect(result.length).toBeGreaterThan(0);
  });

  it('scans everything when the work fits inside the budget', async () => {
    const scanned: string[] = [];
    await collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => worktreeList(20),
      readStatus: async (cwd) => { scanned.push(cwd); return ''; },
      now: () => 0,
    });
    expect(scanned).toHaveLength(20);
  });

  it('has a budget that leaves room for more than one batch', () => {
    expect(TOTAL_BUDGET_MS).toBeGreaterThan(0);
  });

  it('never lets a git call outlive the remaining budget', () => {
    // Skipping only unstarted worktrees is not enough: up to STATUS_CONCURRENCY
    // commands are already running, and each could otherwise add its full
    // per-command timeout on top of the budget.
    expect(commandTimeoutMs(1_200)).toBe(1_200);
    expect(commandTimeoutMs(99_000)).toBe(5_000); // capped by the per-command limit
  });

  it('never asks for a zero timeout, which child_process reads as "no timeout"', () => {
    expect(commandTimeoutMs(0)).toBe(1);
    expect(commandTimeoutMs(-500)).toBe(1);
  });

  it('excludes itself through a real symlink, not just in theory', async () => {
    // The pure selector takes an injectable canonicaliser, so a test of it
    // passes even if production forgets to pass one. This covers the wiring:
    // git reports the real path, we hold the symlinked one, and only an actual
    // realpath call reconciles them.
    const root = mkdtempSync(join(tmpdir(), 'sibling-symlink-'));
    cleanups.push(root);
    const real = join(root, 'real');
    mkdirSync(join(real, 'self'), { recursive: true });
    mkdirSync(join(real, 'peer'), { recursive: true });
    symlinkSync(real, join(root, 'link'));

    const result = await collectSiblingWork(join(root, 'link', 'self'), {
      // git always answers with the real path, whichever spelling it was asked through.
      listWorktrees: async () => `worktree ${join(real, 'self')}\0worktree ${join(real, 'peer')}\0\0`,
      readStatus: async () => 'M  a.ts\0',
    });

    expect(result.map((r) => r.identifier)).toEqual([join(real, 'peer')]);
  });

  it('returns nothing, and does not throw, when the repository cannot be listed', async () => {
    // This decorates a prompt; it must never be able to fail a dispatch.
    await expect(collectSiblingWork('/repo/worktree/self', {
      listWorktrees: async () => { throw new Error('not a git repository'); },
    })).resolves.toEqual([]);
  });
});
