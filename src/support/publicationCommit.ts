// Created: 2026-10-03
// Purpose: the commit that publishes a worker's uncommitted edits, with hooks only where they are the intent (AGT-4677)
// Dependencies: git
// Test Status: publicationCommit.test.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Same ceiling as the other git calls in worktreeManager (INT-2521). */
const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Commit what is staged in `worktreePath` for publication.
 *
 * A reviewed, non-draft publication keeps the repository's hooks: there the repository's
 * own gate is the point. A draft exists so that parked or unfinished work is visible, so a
 * hook that rejects it must not keep the work out of sight; the worker's last edits would
 * otherwise sit in the worktree unpublished, as AX-1797's did when ruff rejected
 * `tests/test_a1_cost_rules.py:236` (SIM114). Every other preservation commit in
 * `worktreeManager.ts` already skips hooks the same way. CI lints the draft on the PR.
 */
export async function commitStagedForPublication(
  worktreePath: string,
  message: string,
  options: { draft?: boolean } = {},
): Promise<void> {
  const args = ['-C', worktreePath, 'commit', ...(options.draft ? ['--no-verify'] : []), '-m', message];
  await execFileAsync('git', args, { timeout: GIT_TIMEOUT_MS });
}
