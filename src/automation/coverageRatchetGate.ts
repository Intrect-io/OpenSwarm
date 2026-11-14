// ============================================
// OpenSwarm — an unattended run may not publish lower coverage than main
// ============================================
//
// testRemovalGate.ts blocks a change that lowers the active test count. A test
// can also be kept and weakened — its assertions loosened, its fixture emptied —
// and that passes the count unchanged. AGT-4190 defence 2: compare the line
// coverage of the change with the coverage of the main commit it branched from,
// and park for a person when it drops. A ratchet, not a target: the baseline is
// whatever that main commit measured.
//
// The baseline is keyed by repository and merge-base SHA, not "latest main": a
// branch cut from an older main is compared with the main it actually started
// from. Support is decided on the base side — a worker that deletes the coverage
// configuration does not switch the gate off; its head then fails to measure and
// the publication is held.
//
// Measurement is a provider seam. The number has to come from something the
// harness ran, never from the worker's own report (tester.ts parses coverage out
// of agent text — the exact evasion this gate exists for). No provider is wired
// in by default yet, so until one is, every repository is recorded as skipped.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFile } from '../support/atomicFile.js';

const exec = promisify(execFile);

/** NEEDS_HUMAN code for a run whose change lowers coverage below its base. */
export const COVERAGE_DROP_PARK_REASON = 'coverage_dropped';

/**
 * Coverage is compared in percentage points; drops smaller than this are
 * rounding noise between two runs of the same tool, not a weakened test.
 */
export const COVERAGE_TOLERANCE_PCT = 0.01;

export type CoverageMeasurement =
  | { kind: 'measured'; percent: number }
  | { kind: 'unsupported'; why: string };

export interface CoverageProvider {
  /** Measure the main commit `baseSha`. `unsupported` here skips the gate. */
  measureBase(worktreePath: string, baseSha: string): Promise<CoverageMeasurement>;
  /** Measure the worktree as it will be published. */
  measureHead(worktreePath: string): Promise<CoverageMeasurement>;
}

export interface CoverageBaselineStore {
  get(key: string): number | undefined;
  set(key: string, percent: number): Promise<void>;
}

export type CoverageRatchetResult =
  | { status: 'pass'; baseline: number; head: number }
  | { status: 'skipped'; reason: string }
  | { status: 'hold'; reason: string; baseline?: number; head?: number };

let registeredProvider: CoverageProvider | null = null;

/**
 * Install the provider the publication path uses. Until something calls this,
 * the gate records every repository as skipped.
 */
export function setCoverageProvider(provider: CoverageProvider | null): void {
  registeredProvider = provider;
}

function defaultBaselinePath(): string {
  return process.env.OPENSWARM_COVERAGE_BASELINES
    ?? join(homedir(), '.openswarm', 'coverage-baselines.json');
}

/** A JSON file of `{ "<repo>@<sha>": percent }`. Unreadable means empty. */
export function fileBaselineStore(path: string = defaultBaselinePath()): CoverageBaselineStore {
  const load = (): Record<string, number> => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
    } catch {
      return {};
    }
  };
  return {
    get(key) {
      const value = load()[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    },
    async set(key, percent) {
      const all = load();
      all[key] = percent;
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      await atomicWriteFile(path, `${JSON.stringify(all, null, 2)}\n`, 0o600);
    },
  };
}

type Git = (args: string[]) => Promise<string>;

function gitIn(worktreePath: string): Git {
  return async (args) => (await exec('git', ['-C', worktreePath, ...args])).stdout;
}

/** The repository identity a baseline belongs to: its origin URL, else its top level. */
async function repoKey(git: Git): Promise<string> {
  const remote = (await git(['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
  if (remote) return remote;
  return (await git(['rev-parse', '--show-toplevel'])).trim();
}

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** The stored baseline for `key`, measuring and storing it on first sight. */
async function baselineFor(
  provider: CoverageProvider,
  store: CoverageBaselineStore,
  key: string,
  worktreePath: string,
  baseSha: string,
): Promise<CoverageMeasurement> {
  const stored = store.get(key);
  if (stored !== undefined) return { kind: 'measured', percent: stored };
  const base = await provider.measureBase(worktreePath, baseSha);
  if (base.kind === 'measured') await store.set(key, base.percent);
  return base;
}

/**
 * Decide whether a reviewed, unattended publication must be held for a drop in
 * coverage. Fails CLOSED once the base is known to be measurable: a head that
 * cannot be measured, or a measurement that throws, holds the publication.
 */
export async function coverageRatchetHold(
  worktreePath: string,
  deps: {
    provider?: CoverageProvider | null;
    store?: CoverageBaselineStore;
    resolveBase?: (path: string) => Promise<{ ref: string }>;
    git?: Git;
  } = {},
): Promise<CoverageRatchetResult> {
  const provider = deps.provider === undefined ? registeredProvider : deps.provider;
  if (!provider) {
    return { status: 'skipped', reason: 'no coverage provider is configured; the coverage ratchet did not run' };
  }
  if (!existsSync(worktreePath)) {
    return { status: 'skipped', reason: `worktree ${worktreePath} does not exist` };
  }
  try {
    const git = deps.git ?? gitIn(worktreePath);
    const resolveBase = deps.resolveBase ?? (async (path: string) => {
      const { resolveBaseRef } = await import('../support/worktreeManager.js');
      return resolveBaseRef(path);
    });
    const { ref } = await resolveBase(worktreePath);
    const baseSha = (await git(['merge-base', ref, 'HEAD']).catch(() => '')).trim();
    if (!baseSha) {
      return { status: 'skipped', reason: `no merge base with ${ref}; nothing to compare coverage against` };
    }

    const store = deps.store ?? fileBaselineStore();
    const base = await baselineFor(provider, store, `${await repoKey(git)}@${baseSha}`, worktreePath, baseSha);
    if (base.kind === 'unsupported') {
      return { status: 'skipped', reason: `coverage is not measurable for this repository at ${baseSha.slice(0, 12)}: ${base.why}` };
    }
    const baseline = base.percent;

    const head = await provider.measureHead(worktreePath);
    if (head.kind === 'unsupported') {
      return {
        status: 'hold',
        baseline,
        reason: `Coverage was measurable on main (${pct(baseline)} at ${baseSha.slice(0, 12)}) but not on this change: ${head.why}. `
          + 'Holding the publication rather than publishing unmeasured.',
      };
    }
    if (head.percent + COVERAGE_TOLERANCE_PCT < baseline) {
      return {
        status: 'hold',
        baseline,
        head: head.percent,
        reason: `This change lowers line coverage from ${pct(baseline)} (main at ${baseSha.slice(0, 12)}) to ${pct(head.percent)}. `
          + 'Weakening a test keeps the count and lowers coverage, so an unattended run does not publish it. '
          + 'Restore the coverage, or have a person review and publish the change.',
      };
    }
    return { status: 'pass', baseline, head: head.percent };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 'hold', reason: `The coverage check could not run (${detail}); holding the publication rather than publishing unmeasured.` };
  }
}
