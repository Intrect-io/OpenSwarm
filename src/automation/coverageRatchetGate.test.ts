import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coverageRatchetHold,
  fileBaselineStore,
  setCoverageProvider,
  type CoverageBaselineStore,
  type CoverageMeasurement,
  type CoverageProvider,
} from './coverageRatchetGate.js';

const BASE_SHA = 'b'.repeat(40);
const worktree = mkdtempSync(join(tmpdir(), 'openswarm-cov-gate-'));

/** git seam: a repo with an origin and a merge base, or none. */
function fakeGit(mergeBase: string = BASE_SHA) {
  return async (args: string[]) => {
    if (args[0] === 'merge-base') return mergeBase ? `${mergeBase}\n` : '';
    if (args[0] === 'config') return 'git@github.com:o/r.git\n';
    return '';
  };
}

function memoryStore(initial: Record<string, number> = {}): CoverageBaselineStore & { data: Record<string, number> } {
  const data = { ...initial };
  return { data, get: (k) => data[k], set: async (k, v) => { data[k] = v; } };
}

function provider(base: CoverageMeasurement, head: CoverageMeasurement) {
  return {
    measureBase: vi.fn(async () => base),
    measureHead: vi.fn(async () => head),
  } satisfies CoverageProvider;
}

const resolveBase = async () => ({ ref: 'origin/main' });
const measured = (percent: number): CoverageMeasurement => ({ kind: 'measured', percent });

afterEach(() => setCoverageProvider(null));

describe('coverageRatchetHold (AGT-4898)', () => {
  it('holds a change whose coverage is lower than its main commit', async () => {
    const result = await coverageRatchetHold(worktree, {
      provider: provider(measured(82.5), measured(79.1)),
      store: memoryStore(),
      resolveBase,
      git: fakeGit(),
    });

    expect(result.status).toBe('hold');
    if (result.status !== 'hold') return;
    expect(result.baseline).toBe(82.5);
    expect(result.head).toBe(79.1);
    expect(result.reason).toContain('82.50%');
    expect(result.reason).toContain('79.10%');
  });

  it('passes when coverage is unchanged or higher', async () => {
    for (const head of [82.5, 90]) {
      const result = await coverageRatchetHold(worktree, {
        provider: provider(measured(82.5), measured(head)),
        store: memoryStore(),
        resolveBase,
        git: fakeGit(),
      });
      expect(result).toEqual({ status: 'pass', baseline: 82.5, head });
    }
  });

  it('ignores a drop within rounding tolerance', async () => {
    const result = await coverageRatchetHold(worktree, {
      provider: provider(measured(82.5), measured(82.495)),
      store: memoryStore(),
      resolveBase,
      git: fakeGit(),
    });
    expect(result.status).toBe('pass');
  });

  it('stores the baseline per repository and merge base, and reuses it', async () => {
    const store = memoryStore();
    const p = provider(measured(70), measured(71));
    await coverageRatchetHold(worktree, { provider: p, store, resolveBase, git: fakeGit() });
    await coverageRatchetHold(worktree, { provider: p, store, resolveBase, git: fakeGit() });

    expect(store.data).toEqual({ [`git@github.com:o/r.git@${BASE_SHA}`]: 70 });
    expect(p.measureBase).toHaveBeenCalledTimes(1);
  });

  it('compares a branch with the main it was cut from, not a newer one', async () => {
    const older = 'a'.repeat(40);
    // Newer main measured 90; this branch started from an older main at 60.
    const store = memoryStore({ [`git@github.com:o/r.git@${BASE_SHA}`]: 90, [`git@github.com:o/r.git@${older}`]: 60 });
    const result = await coverageRatchetHold(worktree, {
      provider: provider(measured(0), measured(65)),
      store,
      resolveBase,
      git: fakeGit(older),
    });
    expect(result).toEqual({ status: 'pass', baseline: 60, head: 65 });
  });

  it('skips and says so when the base is not measurable', async () => {
    const store = memoryStore();
    const result = await coverageRatchetHold(worktree, {
      provider: provider({ kind: 'unsupported', why: 'no coverage tool configured' }, measured(10)),
      store,
      resolveBase,
      git: fakeGit(),
    });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') expect(result.reason).toContain('no coverage tool configured');
    expect(store.data).toEqual({});
  });

  it('holds when main was measurable but the change is not (coverage config removed)', async () => {
    const result = await coverageRatchetHold(worktree, {
      provider: provider(measured(80), { kind: 'unsupported', why: 'coverage config missing' }),
      store: memoryStore(),
      resolveBase,
      git: fakeGit(),
    });
    expect(result.status).toBe('hold');
  });

  it('holds when the measurement throws', async () => {
    const failing: CoverageProvider = {
      measureBase: async () => measured(80),
      measureHead: async () => { throw new Error('test runner crashed'); },
    };
    const result = await coverageRatchetHold(worktree, { provider: failing, store: memoryStore(), resolveBase, git: fakeGit() });
    expect(result.status).toBe('hold');
    if (result.status === 'hold') expect(result.reason).toContain('test runner crashed');
  });

  it('skips without a merge base', async () => {
    const result = await coverageRatchetHold(worktree, {
      provider: provider(measured(80), measured(10)),
      store: memoryStore(),
      resolveBase,
      git: fakeGit(''),
    });
    expect(result.status).toBe('skipped');
  });

  it('skips and records it when no provider is configured', async () => {
    const result = await coverageRatchetHold(worktree, { store: memoryStore(), resolveBase, git: fakeGit() });
    expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('no coverage provider') });
  });

  it('uses the registered provider by default', async () => {
    setCoverageProvider(provider(measured(80), measured(50)));
    const result = await coverageRatchetHold(worktree, { store: memoryStore(), resolveBase, git: fakeGit() });
    expect(result.status).toBe('hold');
  });
});

describe('coverageRatchetHold baseline handling (AGT-4898 review)', () => {
  it('keys the baseline by provider identity, so another command does not reuse it', async () => {
    const store = memoryStore({ [`git@github.com:o/r.git@${BASE_SHA}`]: 99 });
    const p = { ...provider(measured(70), measured(71)), identity: vi.fn(async () => 'repo-command:abc') };
    const result = await coverageRatchetHold(worktree, { provider: p, store, resolveBase, git: fakeGit() });

    expect(result).toEqual({ status: 'pass', baseline: 70, head: 71 });
    expect(store.data[`git@github.com:o/r.git@${BASE_SHA}#repo-command:abc`]).toBe(70);
    expect(p.identity).toHaveBeenCalledWith(worktree, BASE_SHA);
  });

  it('passes the base commit to measureHead', async () => {
    const p = provider(measured(70), measured(71));
    await coverageRatchetHold(worktree, { provider: p, store: memoryStore(), resolveBase, git: fakeGit() });
    expect(p.measureHead).toHaveBeenCalledWith(worktree, BASE_SHA);
  });

  it('re-measures a cached base once before holding and uses a lower fresh value', async () => {
    const key = `git@github.com:o/r.git@${BASE_SHA}`;
    const store = memoryStore({ [key]: 85 });
    const p = provider(measured(79), measured(80));
    const result = await coverageRatchetHold(worktree, { provider: p, store, resolveBase, git: fakeGit() });

    expect(result).toEqual({ status: 'pass', baseline: 79, head: 80 });
    expect(p.measureBase).toHaveBeenCalledTimes(1);
    expect(store.data[key]).toBe(79);
  });

  it('still holds when the fresh base is not lower, and does not re-measure a fresh baseline', async () => {
    const cached = provider(measured(90), measured(80));
    const held = await coverageRatchetHold(worktree, { provider: cached, store: memoryStore({ [`git@github.com:o/r.git@${BASE_SHA}`]: 85 }), resolveBase, git: fakeGit() });
    expect(held).toMatchObject({ status: 'hold', baseline: 85, head: 80 });
    expect(cached.measureBase).toHaveBeenCalledTimes(1);

    const fresh = provider(measured(85), measured(80));
    const heldFresh = await coverageRatchetHold(worktree, { provider: fresh, store: memoryStore(), resolveBase, git: fakeGit() });
    expect(heldFresh.status).toBe('hold');
    expect(fresh.measureBase).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold when re-measuring the base throws', async () => {
    const p: CoverageProvider = {
      measureBase: async () => { throw new Error('base run crashed'); },
      measureHead: async () => measured(80),
    };
    const result = await coverageRatchetHold(worktree, { provider: p, store: memoryStore({ [`git@github.com:o/r.git@${BASE_SHA}`]: 85 }), resolveBase, git: fakeGit() });
    expect(result).toMatchObject({ status: 'hold', baseline: 85 });
  });

  it('skips, not holds, when the baseline cannot be established', async () => {
    const throwingBase: CoverageProvider = { measureBase: async () => { throw new Error('base run crashed'); }, measureHead: async () => measured(1) };
    const cases: Array<Parameters<typeof coverageRatchetHold>[1]> = [
      { provider: provider(measured(80), measured(1)), store: memoryStore(), resolveBase: async () => { throw new Error('no origin'); }, git: fakeGit() },
      {
        provider: provider(measured(80), measured(1)),
        store: memoryStore(),
        resolveBase,
        git: async (args) => {
          if (args[0] === 'merge-base') return `${BASE_SHA}\n`;
          throw new Error('git config exploded');
        },
      },
      { provider: throwingBase, store: memoryStore(), resolveBase, git: fakeGit() },
    ];
    for (const deps of cases) {
      const result = await coverageRatchetHold(worktree, deps);
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') expect(result.reason).toMatch(/no origin|git config exploded|base run crashed/);
    }
  });

  it('does not change the verdict when storing the baseline fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store: CoverageBaselineStore = { get: () => undefined, set: async () => { throw new Error('disk full'); } };
    const pass = await coverageRatchetHold(worktree, { provider: provider(measured(70), measured(71)), store, resolveBase, git: fakeGit() });
    const hold = await coverageRatchetHold(worktree, { provider: provider(measured(70), measured(60)), store, resolveBase, git: fakeGit() });
    expect(pass.status).toBe('pass');
    expect(hold.status).toBe('hold');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    warn.mockRestore();
  });
});

describe('fileBaselineStore', () => {
  it('round-trips baselines through a JSON file and treats a missing file as empty', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openswarm-cov-store-')), 'nested', 'baselines.json');
    const store = fileBaselineStore(path);
    expect(store.get('r@x')).toBeUndefined();
    await store.set('r@x', 81.25);
    await store.set('r@y', 50);
    expect(fileBaselineStore(path).get('r@x')).toBe(81.25);
    expect(fileBaselineStore(path).get('r@y')).toBe(50);
  });

  it('prunes entries older than the max age on write and reads legacy numbers', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openswarm-cov-store-')), 'baselines.json');
    const day = 24 * 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify({ legacy: 42, old: { percent: 10, at: 0 }, recent: { percent: 20, at: 95 * day } }));
    const store = fileBaselineStore(path, { now: () => 100 * day, maxAgeMs: 90 * day });
    expect(store.get('legacy')).toBe(42);
    expect(store.get('old')).toBe(10);

    await store.set('new', 30);

    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { percent: number }>;
    expect(Object.keys(stored).sort()).toEqual(['legacy', 'new', 'recent']);
    expect(stored.new.percent).toBe(30);
  });

  it('keeps every entry when separate stores write at once', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openswarm-cov-store-')), 'baselines.json');
    await Promise.all(Array.from({ length: 12 }, (_, i) => fileBaselineStore(path).set(`r@${i}`, i)));
    const store = fileBaselineStore(path);
    for (let i = 0; i < 12; i += 1) expect(store.get(`r@${i}`)).toBe(i);
  });
});
