// ============================================
// OpenSwarm — an unattended run may not publish fewer active tests
// ============================================
//
// deletedTestGuard.ts (AGT-4277) only commented on a pull request that removed
// test cases — after it was published. With nobody reading the PR before the
// merge, advisory is the same as absent: a worker that turns a failing
// acceptance test into `it.skip(` gets green CI and a ready PR. Round-1 redteam
// (2026-11-03) confirmed that path. This gate runs before the reviewed
// publication: a change that lowers the active-case count of any test file
// parks for a person unless the issue's DoD contract says
// `"tests": { "allowRemoval": true }`.
//
// Measured on the worktree as it will be committed — tracked edits, untracked
// files and renames included — through a throwaway index, so the worker's own
// index is never touched and a renamed test file is not counted as deleted.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { parseDoDContract } from './dodContract.js';
import { findDeletedTests, testFileKind, type DeletedTestFinding } from './deletedTestGuard.js';

const exec = promisify(execFile);

/** NEEDS_HUMAN code for a run whose change lowers the active test count. */
export const TEST_REMOVAL_PARK_REASON = 'active_tests_removed';

type Git = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

function gitIn(worktreePath: string): Git {
  return async (args, env) => (await exec('git', ['-C', worktreePath, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  })).stdout;
}

/** True when the issue's DoD contract explicitly allows removing tests. */
export function testRemovalAllowed(description: string | undefined): boolean {
  return parseDoDContract(description).contract?.tests?.allowRemoval === true;
}

/**
 * Active-case delta between the merge base with `baseRef` and the worktree as
 * `git add -A` would commit it. Returns null when there is no merge base
 * (nothing to compare against — said out loud, like the PR-time check).
 */
export async function collectWorktreeTestCaseDeltas(
  worktreePath: string,
  baseRef: string,
  git: Git = gitIn(worktreePath),
): Promise<DeletedTestFinding | null> {
  const base = (await git(['merge-base', baseRef, 'HEAD']).catch(() => '')).trim();
  if (!base) {
    console.warn(`[TestRemovalGate] No merge base with ${baseRef} in ${worktreePath}; the gate did not run`);
    return null;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'openswarm-test-gate-'));
  try {
    const indexFile = join(scratch, 'index');
    // Start from the real index so `add -A` reuses its stat cache instead of
    // re-hashing the whole tree; the copy is all this ever writes to.
    const realIndex = (await git(['rev-parse', '--git-path', 'index'])).trim();
    await copyFile(isAbsolute(realIndex) ? realIndex : join(worktreePath, realIndex), indexFile).catch(() => {});
    const env = { GIT_INDEX_FILE: indexFile };
    await git(['add', '-A'], env);
    const status = await git(['diff', '--cached', '--name-status', '-M', base], env);
    const show = async (spec: string) => { try { return await git(['show', spec], env); } catch { return null; } };
    const changed: Array<{ file: string; before: string | null; after: string | null }> = [];
    for (const line of status.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const code = parts[0];
      const from = parts[1];
      const to = code.startsWith('R') || code.startsWith('C') ? parts[2] : parts[1];
      if (!testFileKind(from) && !testFileKind(to)) continue;
      // A copy leaves the original in place; only its new side is a change.
      const before = code.startsWith('C') || code.startsWith('A') ? null : await show(`${base}:${from}`);
      const after = code.startsWith('D') ? null : await show(`:${to}`);
      changed.push({ file: to, before, after });
    }
    return findDeletedTests(changed);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface TestRemovalHold {
  reason: string;
  finding?: DeletedTestFinding;
}

/**
 * Decide whether a reviewed, unattended publication must be held.
 *
 * Fails CLOSED when the measurement itself breaks: a gate that silently stops
 * measuring is the failure it exists to catch. "No merge base" is the one
 * exception, matching the PR-time check — there is no base to have removed from.
 */
export async function testRemovalHold(
  worktreePath: string,
  description: string | undefined,
  deps: {
    resolveBase?: (path: string) => Promise<{ ref: string }>;
    collect?: (path: string, baseRef: string) => Promise<DeletedTestFinding | null>;
  } = {},
): Promise<TestRemovalHold | null> {
  if (testRemovalAllowed(description)) return null;
  // No tree, nothing to commit: the publication fails on its own, with a more
  // precise error than this gate could give.
  if (!existsSync(worktreePath)) return null;
  try {
    const resolveBase = deps.resolveBase ?? (async (path: string) => {
      const { resolveBaseRef } = await import('../support/worktreeManager.js');
      return resolveBaseRef(path);
    });
    const { ref } = await resolveBase(worktreePath);
    const finding = await (deps.collect ?? collectWorktreeTestCaseDeltas)(worktreePath, ref);
    if (!finding || finding.removed === 0) return null;
    const files = finding.files.map(f => `${f.file} (${f.before}→${f.after})`).join(', ');
    return {
      finding,
      reason: `This change lowers the active test count by ${finding.removed}: ${files}. `
        + 'Deleting or skipping a test is the cheapest way to make a suite pass, so an '
        + 'unattended run does not publish it. Restore the tests, or allow it in the '
        + 'issue with an openswarm:dod block containing "tests": { "allowRemoval": true }.',
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `The active-test check could not run (${detail}); holding the publication rather than publishing unmeasured.` };
  }
}
