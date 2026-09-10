// ============================================
// OpenSwarm - work-repo CLI (`openswarm add` / `projects` / `remove`)
// ============================================
//
// Manage the work-repo registry the daemon reads at startup
// (~/.claude/openswarm-repos.json — the same file the web dashboard writes).
// `setWebRunner` (src/support/web.ts) calls runner.enableProject() for each
// enabled repo, which adds it to BOTH the enabled set AND allowedProjects
// (INT-1973) — the latter is required so resolveProjectPath reads the repo's
// openswarm.json mapping. A repo added here is therefore actually worked.
//
// `add` also offers a Linear team/project picker (shared with `openswarm init`
// via ./linearMapping) and writes the repo↔Linear mapping into the repo's
// openswarm.json — registering a path alone wouldn't tell the daemon which
// Linear project's issues belong to it.

import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandPath } from '../core/config.js';
import { c } from '../support/colors.js';
import { loadRepoMetadata, RepoMetadataError } from '../support/repoMetadata.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';

/** Persisted dashboard/CLI repo registry. Mirrors web.ts ReposConfig. */
export interface ReposConfig {
  pinned: string[];
  enabled: string[];
  basePaths: string[];
  removedConfigPaths: string[];
}

export const REPOS_FILE = join(homedir(), '.claude', 'openswarm-repos.json');

export function emptyReposConfig(): ReposConfig {
  return { pinned: [], enabled: [], basePaths: [], removedConfigPaths: [] };
}

export function loadRepos(file: string = REPOS_FILE): ReposConfig {
  if (!existsSync(file)) return emptyReposConfig();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ReposConfig>;
    return {
      pinned: raw.pinned ?? [],
      enabled: raw.enabled ?? [],
      basePaths: raw.basePaths ?? [],
      removedConfigPaths: raw.removedConfigPaths ?? [],
    };
  } catch (error) {
    const recoveryPath = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, recoveryPath); } catch { /* preserve original error below */ }
    throw new Error(`Repository registry is malformed at ${file}; preserved as ${recoveryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveRepos(cfg: ReposConfig, file: string = REPOS_FILE): void {
  atomicWriteFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 0o600);
}

const uniq = (a: string[]): string[] => [...new Set(a)];

/** Pure: register a repo (pinned + enabled) and lift it from the denylist. */
export function addProject(cfg: ReposConfig, path: string): ReposConfig {
  return {
    ...cfg,
    pinned: uniq([...cfg.pinned, path]),
    enabled: uniq([...cfg.enabled, path]),
    removedConfigPaths: cfg.removedConfigPaths.filter((p) => p !== path),
  };
}

/** Pure: unregister a repo and add it to the denylist (matches the dashboard unpin). */
export function removeProject(cfg: ReposConfig, path: string): ReposConfig {
  return {
    ...cfg,
    pinned: cfg.pinned.filter((p) => p !== path),
    enabled: cfg.enabled.filter((p) => p !== path),
    removedConfigPaths: uniq([...cfg.removedConfigPaths, path]),
  };
}

export async function handleProjectAdd(rawPath: string): Promise<void> {
  const path = expandPath(rawPath, true);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(c.red(`✗ Not a directory: ${path}`));
    process.exit(1);
  }
  if (!existsSync(join(path, '.git'))) {
    console.error(c.yellow(`⚠ ${path} is not a git repo — workers run in git worktrees and need one.`));
  }
  saveRepos(addProject(loadRepos(), path));
  console.log(c.green(`✓ Added work repo: ${path}`));

  // Registering the path is not enough: the daemon works Linear issues, which
  // belong to a Linear project. Map this repo to a team/project (written into
  // <repo>/openswarm.json) so it resolves without fuzzy name matching.
  await mapRepoToLinear(path);

  console.log(c.dim('  A running daemon picks this up within a few seconds — otherwise start it with `openswarm start`.'));
}

/**
 * Best-effort interactive Linear mapping for a freshly added repo. Never throws:
 * the path is registered regardless. Skips silently when already mapped, when
 * stdin is not a TTY (scripted/CI), or when Linear isn't configured.
 */
async function mapRepoToLinear(path: string): Promise<void> {
  try {
    const meta = await loadRepoMetadata(path);
    if (meta?.linear?.projectId) {
      const label = meta.linear.projectName ?? meta.linear.projectId;
      console.log(c.dim(`  Linear: already mapped → ${meta.linear.teamKey ?? '?'}/${label}`));
      return;
    }
  } catch (err) {
    if (err instanceof RepoMetadataError) {
      console.error(c.yellow(`  ⚠ ${err.message} — re-mapping.`));
    }
  }

  if (!process.stdin.isTTY) {
    console.log(c.dim('  Linear mapping skipped (non-interactive) — run `openswarm add` in a terminal, or add openswarm.json manually.'));
    return;
  }

  const { resolveLinearCredential, pickAndSaveLinearMapping } = await import('./linearMapping.js');
  const cred = await resolveLinearCredential();
  if (!cred) {
    console.log(c.dim('  Linear not configured — run `openswarm auth login --provider linear` to map this repo, or add openswarm.json manually.'));
    return;
  }

  console.log(c.bold('  Map this repo to a Linear project:'));
  try {
    const result = await pickAndSaveLinearMapping(path, cred);
    if (result.kind === 'no-teams') {
      console.log(c.dim('  No Linear teams visible — skipped. Add openswarm.json manually if needed.'));
    } else if (result.kind === 'skipped') {
      console.log(c.dim('  Repo mapping skipped — add openswarm.json later to pin the Linear project.'));
    }
  } catch (err) {
    // @inquirer throws ExitPromptError on Ctrl-C — treat as a skip, not a crash.
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log(c.dim('  Linear mapping skipped.'));
      return;
    }
    throw err;
  }
}

export function handleProjectList(): void {
  const cfg = loadRepos();
  console.log(c.bold('Work repos (enabled):'));
  if (cfg.enabled.length === 0) console.log('  (none)');
  for (const p of cfg.enabled) console.log(`  ${c.green('✓')} ${p}${cfg.pinned.includes(p) ? c.dim(' (pinned)') : ''}`);
  if (cfg.removedConfigPaths.length > 0) {
    console.log(c.dim('\nExcluded (denylist):'));
    for (const p of cfg.removedConfigPaths) console.log(c.dim(`  ✗ ${p}`));
  }
}

export function handleProjectRm(rawPath: string): void {
  const path = expandPath(rawPath, true);
  const cfg = loadRepos();
  if (!cfg.enabled.includes(path) && !cfg.pinned.includes(path)) {
    console.error(c.yellow(`⚠ Not a registered work repo: ${path} (removing anyway / denylisting)`));
  }
  saveRepos(removeProject(cfg, path));
  console.log(c.green(`✓ Removed work repo: ${path}`));
  console.log(c.dim('  A running daemon applies this within a few seconds.'));
}
