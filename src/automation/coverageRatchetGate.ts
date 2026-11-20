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
// of agent text — the exact evasion this gate exists for). The daemon registers
// the repo-declared command provider (coverageCommandProvider.ts) at startup; a
// repository that declares no `coverage` command in its openswarm.json is
// recorded as skipped.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFile } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';

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
  /**
   * What this provider measures with for `baseSha` (e.g. its id plus a hash of
   * the command). Part of the baseline key, so a baseline taken with another
   * tool or command is never compared with this one. Optional: without it the
   * key is repository and merge base alone.
   */
  identity?(worktreePath: string, baseSha: string): Promise<string>;
  /**
   * Measure the main commit `baseSha`. `unsupported` here skips the gate.
   *
   * MUST NOT touch the worker worktree at `worktreePath`: no checkout, reset or
   * stash there. That tree holds the change about to be published; measure the
   * base in a separate checkout (e.g. a temporary detached `git worktree`) and
   * use `worktreePath` only to reach the repository.
   */
  measureBase(worktreePath: string, baseSha: string): Promise<CoverageMeasurement>;
  /**
   * Measure the worktree as it will be published. `baseSha` is the main commit
   * it is compared with, so a provider can take its configuration from the
   * base rather than from files the worker could have edited.
   */
  measureHead(worktreePath: string, baseSha?: string): Promise<CoverageMeasurement>;
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
 * Install the provider the publication path uses. The daemon installs the
 * repo-declared command provider at startup (registerRepoCommandCoverageProvider);
 * with none installed the gate records every repository as skipped.
 */
export function setCoverageProvider(provider: CoverageProvider | null): void {
  registeredProvider = provider;
}

function defaultBaselinePath(): string {
  return process.env.OPENSWARM_COVERAGE_BASELINES
    ?? join(homedir(), '.openswarm', 'coverage-baselines.json');
}

/** Baselines older than this are pruned on the next write; main has moved on. */
export const COVERAGE_BASELINE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type BaselineEntry = { percent: number; at: number };

/**
 * A JSON file of `{ "<key>": { percent, at } }` (legacy plain-number entries
 * are read too). Unreadable means empty. Writes are a read-modify-write under a
 * file lock, so two daemons storing baselines at once do not drop each
 * other's entries, and they prune entries older than `maxAgeMs`.
 */
export function fileBaselineStore(
  path: string = defaultBaselinePath(),
  options: { now?: () => number; maxAgeMs?: number } = {},
): CoverageBaselineStore {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? COVERAGE_BASELINE_MAX_AGE_MS;
  const load = (): Record<string, BaselineEntry> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const entries: Record<string, BaselineEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Legacy entry without a timestamp: age it from now.
        entries[key] = { percent: value, at: now() };
      } else if (value && typeof value === 'object') {
        const { percent, at } = value as Partial<BaselineEntry>;
        if (typeof percent === 'number' && Number.isFinite(percent) && typeof at === 'number') entries[key] = { percent, at };
      }
    }
    return entries;
  };
  return {
    get(key) {
      return load()[key]?.percent;
    },
    async set(key, percent) {
      await withFileLock(`${path}.lock`, async () => {
        const cutoff = now() - maxAgeMs;
        const kept: Record<string, BaselineEntry> = {};
        for (const [k, entry] of Object.entries(load())) {
          if (entry.at >= cutoff) kept[k] = entry;
        }
        kept[key] = { percent, at: now() };
        await atomicWriteFile(path, `${JSON.stringify(kept, null, 2)}\n`, 0o600);
      }, { timeoutMs: 15_000 });
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

/** Store a baseline; a failure is logged and never changes the verdict. */
async function saveBaseline(store: CoverageBaselineStore, key: string, percent: number): Promise<void> {
  try {
    await store.set(key, percent);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[CoverageRatchet] Could not store the baseline for ${key}: ${detail}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide whether a reviewed, unattended publication must be held for a drop in
 * coverage.
 *
 * Until the baseline is known, a failure (no base ref, no repository identity,
 * a base measurement that throws) skips the gate and says why: there is
 * nothing to compare with. Once the base is known to be measurable it fails
 * CLOSED: a head that cannot be measured, or a head measurement that throws,
 * holds the publication.
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
  const store = deps.store ?? fileBaselineStore();

  // Stage 1: the baseline. Any failure here skips — it is not known yet.
  let baseSha: string;
  let key: string;
  let baseline: number;
  let fromCache: boolean;
  try {
    const git = deps.git ?? gitIn(worktreePath);
    const resolveBase = deps.resolveBase ?? (async (path: string) => {
      const { resolveBaseRef } = await import('../support/worktreeManager.js');
      return resolveBaseRef(path);
    });
    const { ref } = await resolveBase(worktreePath);
    baseSha = (await git(['merge-base', ref, 'HEAD']).catch(() => '')).trim();
    if (!baseSha) {
      return { status: 'skipped', reason: `no merge base with ${ref}; nothing to compare coverage against` };
    }
    const identity = provider.identity ? await provider.identity(worktreePath, baseSha) : '';
    key = `${await repoKey(git)}@${baseSha}${identity ? `#${identity}` : ''}`;
    const stored = store.get(key);
    fromCache = stored !== undefined;
    if (stored !== undefined) {
      baseline = stored;
    } else {
      const base = await provider.measureBase(worktreePath, baseSha);
      if (base.kind === 'unsupported') {
        return { status: 'skipped', reason: `coverage is not measurable for this repository at ${baseSha.slice(0, 12)}: ${base.why}` };
      }
      baseline = base.percent;
    }
  } catch (err) {
    return { status: 'skipped', reason: `the coverage baseline could not be established (${errorText(err)}); the coverage ratchet did not run` };
  }
  if (!fromCache) await saveBaseline(store, key, baseline);

  // Stage 2: the change. The base is measurable, so a failure here holds.
  let head: CoverageMeasurement;
  try {
    head = await provider.measureHead(worktreePath, baseSha);
  } catch (err) {
    return { status: 'hold', baseline, reason: `The coverage check could not run (${errorText(err)}); holding the publication rather than publishing unmeasured.` };
  }
  if (head.kind === 'unsupported') {
    return {
      status: 'hold',
      baseline,
      reason: `Coverage was measurable on main (${pct(baseline)} at ${baseSha.slice(0, 12)}) but not on this change: ${head.why}. `
        + 'Holding the publication rather than publishing unmeasured.',
    };
  }
  const headPercent = head.percent;
  const drops = (base: number) => headPercent + COVERAGE_TOLERANCE_PCT < base;
  if (drops(baseline) && fromCache) {
    // A cached baseline may come from a flakier run than today's; measure main
    // once more before parking, and compare with the lower of the two.
    try {
      const fresh = await provider.measureBase(worktreePath, baseSha);
      if (fresh.kind === 'measured' && fresh.percent < baseline) {
        baseline = fresh.percent;
        await saveBaseline(store, key, baseline);
      }
    } catch (err) {
      console.warn(`[CoverageRatchet] Re-measuring the base ${baseSha.slice(0, 12)} failed; keeping the stored baseline: ${errorText(err)}`);
    }
  }
  if (drops(baseline)) {
    return {
      status: 'hold',
      baseline,
      head: headPercent,
      reason: `This change lowers line coverage from ${pct(baseline)} (main at ${baseSha.slice(0, 12)}) to ${pct(headPercent)}. `
        + 'Weakening a test keeps the count and lowers coverage, so an unattended run does not publish it. '
        + 'Restore the coverage, or have a person review and publish the change.',
    };
  }
  return { status: 'pass', baseline, head: headPercent };
}
