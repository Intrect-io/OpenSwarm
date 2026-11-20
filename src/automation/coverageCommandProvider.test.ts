import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverageRatchetHold, setCoverageProvider, type CoverageBaselineStore } from './coverageRatchetGate.js';
import {
  coverageConfigIdentity,
  parseCoverageConfig,
  registerRepoCommandCoverageProvider,
  repoCommandCoverageProvider,
  runCoverageCommand,
} from './coverageCommandProvider.js';

const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...GIT_ID, ...args], { encoding: 'utf8' });
}

/** A coverage "command": a script that writes the percent in ./pct to the summary. */
const COVER_SCRIPT = `#!/bin/sh
mkdir -p coverage
printf '{"total":{"lines":{"pct":%s},"statements":{"pct":1}}}' "$(cat pct)" > coverage/coverage-summary.json
`;

function coverageJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, coverage: { command: 'sh cover.sh', timeoutMs: 20_000, ...extra } });
}

/**
 * A repo whose main commit declares the coverage command and measures
 * `basePct`, plus a worker worktree on a branch whose change measures `headPct`.
 */
function setup(basePct: number, headPct: number, openswarm: string | null = coverageJson()) {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-cov-cmd-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'cover.sh'), COVER_SCRIPT);
  writeFileSync(join(repo, 'pct'), String(basePct));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  if (openswarm !== null) writeFileSync(join(repo, 'openswarm.json'), openswarm);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'main');
  const base = g(repo, 'rev-parse', 'HEAD').trim();

  const worker = join(root, 'worker');
  g(repo, 'worktree', 'add', '-q', '-b', 'swarm/X-1', worker, 'main');
  writeFileSync(join(worker, 'pct'), String(headPct));
  g(worker, 'commit', '-qam', 'change');
  return { root, repo, worker, base };
}

function memoryStore(): CoverageBaselineStore & { data: Record<string, number> } {
  const data: Record<string, number> = {};
  return { data, get: (k) => data[k], set: async (k, v) => { data[k] = v; } };
}

function workerState(worker: string) {
  return {
    head: g(worker, 'rev-parse', 'HEAD'),
    branch: g(worker, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: g(worker, 'status', '--porcelain', '--untracked-files=all'),
  };
}

function tempBaseDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('openswarm-cov-base-'));
}

describe('repoCommandCoverageProvider (AGT-4898 review)', () => {
  it('holds a change whose real measured coverage drops, measuring main in a temporary worktree', async () => {
    const { repo, worker, base } = setup(80, 60);
    const before = workerState(worker);
    const tmpBefore = tempBaseDirs();

    const result = await coverageRatchetHold(worker, {
      provider: repoCommandCoverageProvider(),
      store: memoryStore(),
      resolveBase: async () => ({ ref: 'main' }),
    });

    expect(result).toMatchObject({ status: 'hold', baseline: 80, head: 60 });
    expect(result.status === 'hold' && result.reason).toContain(base.slice(0, 12));
    // The worker tree is untouched: same commit, branch, and no coverage output left to commit.
    expect(workerState(worker)).toEqual(before);
    expect(existsSync(join(worker, 'coverage'))).toBe(false);
    // The base checkout is gone.
    expect(tempBaseDirs()).toEqual(tmpBefore);
    expect(g(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
  });

  it('passes when coverage holds and keys the baseline by provider and command hash', async () => {
    const { worker } = setup(70, 75);
    const store = memoryStore();
    const result = await coverageRatchetHold(worker, { provider: repoCommandCoverageProvider(), store, resolveBase: async () => ({ ref: 'main' }) });

    expect(result).toEqual({ status: 'pass', baseline: 70, head: 75 });
    const [key] = Object.keys(store.data);
    expect(key).toMatch(/#repo-command:[0-9a-f]{16}$/);
  });

  it('skips a repository that declares no coverage command', async () => {
    for (const openswarm of [null, JSON.stringify({ schemaVersion: 1 })]) {
      const { worker } = setup(80, 10, openswarm);
      const result = await coverageRatchetHold(worker, { provider: repoCommandCoverageProvider(), store: memoryStore(), resolveBase: async () => ({ ref: 'main' }) });
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') expect(result.reason).toMatch(/openswarm\.json/);
    }
  });

  it('takes the command from the base commit, not from the worker tree', async () => {
    const { worker } = setup(80, 60);
    // The worker rewrites its own openswarm.json to a command that claims 100%.
    writeFileSync(join(worker, 'openswarm.json'), JSON.stringify({ schemaVersion: 1, coverage: { command: 'mkdir -p coverage && echo \'{"total":{"lines":{"pct":100}}}\' > coverage/coverage-summary.json' } }));
    g(worker, 'commit', '-qam', 'cheat');

    const head = await repoCommandCoverageProvider().measureHead(worker, g(worker, 'merge-base', 'main', 'HEAD').trim());
    expect(head).toEqual({ kind: 'measured', percent: 60 });
  });

  it('does not count a stale summary the command did not rewrite', async () => {
    const { worker, base } = setup(80, 60, coverageJson({ command: 'true' }));
    mkdirSync(join(worker, 'coverage'));
    writeFileSync(join(worker, 'coverage', 'coverage-summary.json'), '{"total":{"lines":{"pct":99}}}');

    const head = await repoCommandCoverageProvider().measureHead(worker, base);
    expect(head.kind).toBe('unsupported');
    if (head.kind === 'unsupported') expect(head.why).toContain('not rewritten');
  });

  it('reports a failing command as unsupported with its output, and still removes the base checkout', async () => {
    const { repo, worker, base } = setup(80, 60, coverageJson({ command: 'echo boom-output; exit 3' }));
    const tmpBefore = tempBaseDirs();
    const before = workerState(worker);

    const measured = await repoCommandCoverageProvider().measureBase(worker, base);

    expect(measured.kind).toBe('unsupported');
    if (measured.kind === 'unsupported') expect(measured.why).toMatch(/exited with 3.*boom-output/s);
    expect(tempBaseDirs()).toEqual(tmpBefore);
    expect(g(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
    expect(workerState(worker)).toEqual(before);
  });

  it('links the worker node_modules into the base checkout without touching it on removal', async () => {
    const { worker, base } = setup(80, 60, coverageJson({ command: 'test -f node_modules/marker && sh cover.sh' }));
    mkdirSync(join(worker, 'node_modules'));
    writeFileSync(join(worker, 'node_modules', 'marker'), 'x');

    const measured = await repoCommandCoverageProvider().measureBase(worker, base);

    expect(measured).toEqual({ kind: 'measured', percent: 80 });
    expect(existsSync(join(worker, 'node_modules', 'marker'))).toBe(true);
  });

  it('reads an untracked openswarm.json from the main checkout when the base commit has none', async () => {
    const { repo, worker } = setup(80, 60, null);
    writeFileSync(join(repo, 'openswarm.json'), coverageJson());
    const result = await coverageRatchetHold(worker, { provider: repoCommandCoverageProvider(), store: memoryStore(), resolveBase: async () => ({ ref: 'main' }) });
    expect(result).toMatchObject({ status: 'hold', baseline: 80, head: 60 });
  });

  it('keeps the worker\'s own untracked files when it removes the coverage output', async () => {
    const { worker, base } = setup(80, 60);
    writeFileSync(join(worker, 'new-source.ts'), 'export const x = 1;\n');

    const head = await repoCommandCoverageProvider().measureHead(worker, base);

    expect(head).toEqual({ kind: 'measured', percent: 60 });
    expect(existsSync(join(worker, 'new-source.ts'))).toBe(true);
    expect(existsSync(join(worker, 'coverage'))).toBe(false);
  });

  it('kills a command that runs past its timeout', async () => {
    const started = Date.now();
    const run = await runCoverageCommand('sleep 30 & sleep 30', tmpdir(), 300);
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('keeps only the tail of a long output', async () => {
    const run = await runCoverageCommand('i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done', tmpdir(), 20_000);
    expect(run.code).toBe(0);
    expect(run.output.length).toBeLessThanOrEqual(4_000);
    expect(run.output).toContain('line-1999');
  });
});

describe('parseCoverageConfig', () => {
  it('rejects a summary path outside the repository and defaults the rest', () => {
    expect(parseCoverageConfig(JSON.stringify({ coverage: { command: 'x', summary: '../../etc/x.json' } }))).toHaveProperty('why');
    expect(parseCoverageConfig(JSON.stringify({ coverage: { command: 'x', summary: '/abs.json' } }))).toHaveProperty('why');
    expect(parseCoverageConfig(JSON.stringify({ coverage: { command: 'x' } }))).toEqual({
      config: { command: 'x', summary: 'coverage/coverage-summary.json', timeoutMs: 600_000 },
    });
  });

  it('hashes the command into the identity', () => {
    const a = coverageConfigIdentity({ command: 'a', summary: 's', timeoutMs: 1 });
    const b = coverageConfigIdentity({ command: 'b', summary: 's', timeoutMs: 1 });
    expect(a).not.toBe(b);
    expect(coverageConfigIdentity({ command: 'a', summary: 's', timeoutMs: 999 })).toBe(a);
  });
});

describe('registerRepoCommandCoverageProvider', () => {
  afterEach(() => setCoverageProvider(null));

  it('makes the gate measure by default once registered', async () => {
    const { worker } = setup(80, 60);
    const unregistered = await coverageRatchetHold(worker, { store: memoryStore(), resolveBase: async () => ({ ref: 'main' }) });
    expect(unregistered.status).toBe('skipped');

    registerRepoCommandCoverageProvider();
    const result = await coverageRatchetHold(worker, { store: memoryStore(), resolveBase: async () => ({ ref: 'main' }) });
    expect(result).toMatchObject({ status: 'hold', baseline: 80, head: 60 });
  });

  it('installs the provider on the publication path', () => {
    const install = vi.fn();
    const provider = registerRepoCommandCoverageProvider(install);
    expect(install).toHaveBeenCalledWith(provider);
    expect(typeof provider.identity).toBe('function');
  });
});
