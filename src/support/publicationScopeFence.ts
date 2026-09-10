// ============================================
// OpenSwarm - Pre-publication branch scope fence
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withoutBookkeeping } from '../agents/siblingWorkFormat.js';
import { filesOutsideWriteScope } from '../orchestration/writeScope.js';
import { isEphemeralWorktreeArtifact } from './worktreeEphemeral.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60_000;

export class PublicationScopeMismatchError extends Error {
  readonly outsideScope: string[];

  constructor(outsideScope: string[]) {
    super(`publication-scope: branch contains files outside reserved write scope: ${outsideScope.join(', ')}`);
    this.name = 'PublicationScopeMismatchError';
    this.outsideScope = outsideScope;
  }
}

/**
 * Check every file changed by the complete base-to-HEAD branch immediately
 * before push. This catches earlier worker commits and resumed/preserved WIP,
 * not only the latest invocation's working-tree delta.
 */
export async function assertBranchWithinWriteScope(
  worktreePath: string,
  baseRef: string,
  fileScope: readonly string[] | undefined,
): Promise<void> {
  if (!fileScope || fileScope.length === 0) return;
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktreePath, 'diff', '--name-only', `${baseRef}...HEAD`],
    { timeout: GIT_TIMEOUT_MS },
  );
  // The graph exporter writes these managed files into every worktree. They
  // are not task-owned source edits and are already ignored by the sibling
  // overlap advisory; apply the same rule before rejecting a branch publish.
  const changed = withoutBookkeeping(stdout.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((file) => !isEphemeralWorktreeArtifact(file));
  const outsideScope = filesOutsideWriteScope(changed, fileScope);
  if (outsideScope.length > 0) throw new PublicationScopeMismatchError(outsideScope);
}
