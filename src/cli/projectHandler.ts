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
      pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
      enabled: Array.isArray(raw.enabled) ? raw.enabled : [],
      basePaths: Array.isArray(raw.basePaths) ? raw.basePaths : [],
      removedConfigPaths: Array.isArray(raw.removedConfigPaths) ? raw.removedConfigPaths : [],
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
  if (!existsSync(path)) {
    console.error(c.red(`✗ Path does not exist: ${path}`));
    return;
  }
  if (!statSync(path).isDirectory()) {
    console.error(c.red(`✗ Not a directory: ${path}`));
    return;
  }

  const cfg = loadRepos();
  if (cfg.enabled.includes(path)) {
    console.log(c.yellow(`⚠ Already registered: ${path}`));
    return;
  }

  saveRepos(addProject(cfg, path));
  console.log(c.green(`✓ Added work repo: ${path}`));

  // Try to auto-map to a Linear project (non-blocking)
  try {
    const meta = await loadRepoMetadata(path);
    if (meta?.linearProjectId) {
      console.log(c.dim(`  → Auto-mapped to Linear project ${meta.linearProjectId}`));
    }
  } catch (err) {
    if (err instanceof RepoMetadataError && err.code === 'NO_OPENSWARM_JSON') {
      console.log(c.dim('  No openswarm.json found — run `openswarm init` to set up Linear mapping.'));
    } else {
      console.warn(c.yellow(`  ⚠ Could not read repo metadata: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

export async function mapRepoToLinear(path: string): Promise<void> {
  const cfg = loadRepos();
  if (!cfg.enabled.includes(path) && !cfg.pinned.includes(path)) {
    console.error(c.red(`✗ Not a registered work repo: ${path}`));
    return;
  }
  // Linear mapping is handled by `openswarm init` — this is a convenience alias
  console.log(c.dim(`  Run \`openswarm init ${path}\` to set up Linear mapping.`));
}

export function handleProjectList(): void {
  const cfg = loadRepos();
  const all = [...new Set([...cfg.pinned, ...cfg.enabled])];
  if (all.length === 0) {
    console.log(c.dim('No work repos registered.'));
    return;
  }
  console.log(c.bold(`Work repos (${all.length}):`));
  for (const p of all) {
    const tags: string[] = [];
    if (cfg.pinned.includes(p)) tags.push('pinned');
    if (cfg.enabled.includes(p)) tags.push('enabled');
    console.log(`  ${p} ${c.dim(`(${tags.join(', ')})`)}`);
  }
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