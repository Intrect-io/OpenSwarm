// ============================================
// OpenSwarm - Repository and worktree names from a filesystem path
// ============================================
//
// A projectPath is either a main checkout or `<repo>/worktree/<id>`. These
// derive the display names for both. Split out of pairPipeline so that file
// stays under the 1500-line pre-commit cap.
//
// The same two helpers are also copied in `src/tui/subagentTree.ts` and
// `src/automation/runnerExecution.ts`. Consolidating all three is worth doing
// but is not this change's job; a caller adopting this module should delete
// its own copy rather than add a fourth.

/** The repository name, with any trailing `/worktree/<id>` stripped first. */
export function repoNameFromPath(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const normalized = projectPath.replace(/\/+$/, '').replace(/\/worktree\/[^/]+$/, '');
  return normalized.split('/').pop();
}

/** The worktree id, or undefined when the path is a main checkout. */
export function worktreeNameFromPath(projectPath?: string): string | undefined {
  return projectPath?.match(/\/worktree\/([^/]+)\/?$/)?.[1];
}
