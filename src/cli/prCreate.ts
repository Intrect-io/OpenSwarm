// ============================================
// OpenSwarm - `openswarm pr create` from cwd (INT-3282)
// Reuses commitAndCreatePR with a synthetic WorktreeInfo.
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commitAndCreatePR, type WorktreeInfo } from '../support/worktreeManager.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

export interface PrCreateOptions {
  path?: string;
  /** PR / commit title. Default: first line of latest commit or branch name. */
  title?: string;
  /** Linear (or other) issue id embedded in conventional commit + Closes. */
  issue?: string;
  /** PR body. */
  body?: string;
  /** Run `openswarm fix` before publishing. Default true. */
  fix?: boolean;
  /** Open as draft. */
  draft?: boolean;
}

export interface PrCreateDeps {
  runLocalFix?: (cwd: string) => Promise<{ green: boolean }>;
  commitAndCreate?: (
    info: WorktreeInfo,
    title: string,
    issueIdentifier: string,
    description: string,
  ) => Promise<string>;
  currentBranch?: (cwd: string) => Promise<string>;
  /**
   * When injected, replaces both the dirty/upstream gate and the ahead-of-upstream
   * check (tests). The default path validates dirty + upstream separately, then
   * returns whether HEAD is ahead of `@{u}`.
   */
  hasDirtyOrAhead?: (cwd: string) => Promise<boolean>;
}

async function defaultCurrentBranch(cwd: string): Promise<string> {
  return (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

/**
 * Fail closed on a dirty tree and on a feature branch with no upstream.
 *
 * Both used to be read as "there is work to publish", so `pr create` on an
 * uncommitted tree pushed whatever was already committed and silently left the
 * edits behind, and a never-pushed branch counted as publishable on the strength
 * of any commit existing.
 */
async function assertPublishableFeatureBranch(cwd: string): Promise<void> {
  const dirty = (await git(cwd, 'status', '--porcelain')).trim();
  if (dirty) {
    throw new Error('Uncommitted changes in the working tree — commit or stash before creating a PR');
  }
  try {
    await git(cwd, 'rev-parse', '--abbrev-ref', '@{u}');
  } catch {
    throw new Error('Current branch has no upstream — push the feature branch before creating a PR');
  }
}

async function defaultHasAheadOfUpstream(cwd: string): Promise<boolean> {
  const ahead = (await git(cwd, 'rev-list', '--count', '@{u}..HEAD')).trim();
  return parseInt(ahead, 10) > 0;
}

/**
 * Publish the current working tree as a PR.
 * Optionally runs local `openswarm fix` first so we don't push a red tree.
 */
export async function createPrFromCwd(
  opts: PrCreateOptions = {},
  deps: PrCreateDeps = {},
): Promise<{ url: string; message: string }> {
  const cwd = opts.path ?? process.cwd();
  const runFix = opts.fix !== false;
  const issueId = opts.issue?.trim() || 'local';

  if (runFix) {
    const fix =
      deps.runLocalFix ??
      (async (path) => {
        const { runFixCommand } = await import('./fixCommand.js');
        const report = await runFixCommand({ path });
        return { green: report.green };
      });
    const result = await fix(cwd);
    if (!result.green) {
      throw new Error(
        'Local checks are still red after `openswarm fix`. Pass --no-fix to publish anyway, or fix remaining failures.',
      );
    }
  }

  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const branch = await currentBranch(cwd);
  if (!branch || branch === 'HEAD') {
    throw new Error('Detached HEAD — check out a branch before creating a PR');
  }
  if (branch === 'main' || branch === 'master') {
    throw new Error(
      `Refusing to create a PR from "${branch}". Check out a feature branch first.`,
    );
  }

  const hasWork = deps.hasDirtyOrAhead;
  if (hasWork) {
    if (!(await hasWork(cwd))) {
      throw new Error('Nothing to publish — working tree clean and no commits ahead of upstream');
    }
  } else {
    // Default path: refuse a dirty tree or a branch with no upstream outright,
    // then require at least one commit ahead of @{u}. (AGT-3442)
    await assertPublishableFeatureBranch(cwd);
    if (!(await defaultHasAheadOfUpstream(cwd))) {
      throw new Error('Nothing to publish — working tree clean and no commits ahead of upstream');
    }
  }

  const title =
    opts.title?.trim() ||
    (await git(cwd, 'log', '-1', '--pretty=%s').then((s) => s.trim()).catch(() => branch));

  const description =
    opts.body?.trim() ||
    [
      '## Summary',
      title,
      '',
      issueId !== 'local' ? `Closes ${issueId}` : '',
      opts.draft ? '' : '',
    ]
      .filter(Boolean)
      .join('\n');

  const info: WorktreeInfo = {
    worktreePath: cwd,
    branchName: branch,
    originalPath: cwd,
    issueId,
  };

  const publish = deps.commitAndCreate ?? commitAndCreatePR;
  const url = await publish(info, title, issueId, description);

  // commitAndCreatePR always opens a ready PR; draft flag is best-effort via gh.
  if (opts.draft) {
    try {
      await execFileAsync('gh', ['pr', 'ready', url, '--undo'], { cwd });
    } catch {
      // Non-fatal: URL is still valid; user can mark draft manually.
    }
  }

  return {
    url,
    message: `Created PR: ${url}`,
  };
}
