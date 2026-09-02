// ============================================
// OpenSwarm - Per-repo metadata (`openswarm.json`)
// ============================================
//
// Each managed repository may ship an `openswarm.json` at its root.
// The file is the source of truth for repo ↔ external-tracker mapping
// (Linear today, GitHub/etc later) and removes the need for fuzzy
// name matching, which silently breaks on renames or ambiguous names.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from './atomicFile.js';

const LinearMappingSchema = z.object({
  teamId: z.string().uuid().optional(),
  teamKey: z.string().optional(),
  projectId: z.string().uuid(),
  projectName: z.string().optional(),
});

const GithubMappingSchema = z.object({
  repo: z.string(),
});

const RepoMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  /** Human-friendly project name. Falls back to the directory basename if absent. */
  projectName: z.string().optional(),
  description: z.string().optional(),
  linear: LinearMappingSchema.optional(),
  github: GithubMappingSchema.optional(),
  /**
   * Objective check commands for `openswarm fix` (key → shell command), e.g.
   * `{"lint": "ruff check .", "test": "pytest -x"}`. Overrides auto-detection —
   * the escape hatch for any language/toolchain. (INT-2303)
   */
  checks: z.record(z.string(), z.string()).optional(),
  /**
   * Sandbox / worktree execution knobs (INT-2415). Autonomous workers run in a
   * fresh git worktree checked out from origin/main — it has no installed deps
   * (node_modules/.venv) and none of the repo's gitignored real data (e.g.
   * db/*.db), so a worker physically cannot run pytest/playwright/real-data
   * verification. These knobs let a repo (a) opt gitignored paths into the
   * worktree (symlinked from the original repo, which is the installed sandbox)
   * and (b) raise the worker bash timeout for slow E2E/backtests/retraining.
   */
  sandbox: z
    .object({
      /** Gitignored dep/data paths to symlink from the original repo into the worktree. */
      sharedPaths: z.array(z.string()).optional(),
      /** Worker bash tool timeout in ms — E2E/backtests need minutes, not 30s. */
      bashTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  /** Fail-closed autonomous admission and spend policy for this repository. */
  automation: z.object({
    /** Explicit kill switch for issue-driven execution in this repository. */
    enabled: z.boolean().default(true),
    /** Same-repository active leases. Default one; raise only with isolated worktrees. */
    maxConcurrent: z.number().int().min(1).max(10).default(1),
    /** Rolling attempt budget. */
    maxAttemptsPerHour: z.number().int().min(1).max(100).default(12),
    /**
     * Rolling circuit breaker threshold: how many attempts in the last hour may
     * end unsuccessfully before this repository is taken out of admission until
     * `circuitCooldownMinutes` passes. "Unsuccessfully" excludes outcomes that
     * are not the repository failing — `waiting_on_operator`, `cancelled`,
     * `rate_limited`, and (as of AGT-4038) an `infra_error` caused by an
     * adapter timeout, tooling failure, or network blip rather than the
     * repository itself (disk full, a stale `.git` lock, a corrupt repo).
     */
    maxFailuresPerHour: z.number().int().min(1).max(100).default(6),
    /** Optional daily model-cost ceiling. */
    maxCostUsdPerDay: z.number().positive().optional(),
    /** How long an admission circuit remains open before reevaluation. */
    circuitCooldownMinutes: z.number().int().min(1).max(24 * 60).default(60),
  }).optional(),
  /**
   * What happens to a pull request the swarm publishes from this repository.
   * Kept outside `automation` so opting in does not pull that block's
   * admission defaults (maxConcurrent 1, …) in with it.
   */
  publication: z.object({
    /**
     * Run the agentic fresh review (`openswarm pr review --fresh`) once, right
     * after the PR is published. Worker attempts stay on deterministic guards
     * and verification; this is the only LLM review in the autonomous loop,
     * and it is per repository — OpenSwarm itself opts in, its target
     * repositories do not (operator decision, 2026-09-02).
     */
    freshReview: z.boolean().default(false),
  }).optional(),
  /** Free-form notes the swarm should keep in mind. */
  notes: z.string().optional(),
});

export type RepoMetadata = z.infer<typeof RepoMetadataSchema>;
export type LinearRepoMapping = z.infer<typeof LinearMappingSchema>;

export const REPO_METADATA_FILENAME = 'openswarm.json';

/**
 * Load `${repoPath}/openswarm.json` if it exists.
 *
 * Returns:
 *  - parsed metadata when the file is present and valid
 *  - `null` when the file does not exist
 *  - throws `RepoMetadataError` when the file exists but is malformed
 *
 * The caller is expected to treat a `null` return as "no explicit mapping" —
 * downstream code may then fall back to fuzzy matching or whatever default it
 * already had.
 */
export async function loadRepoMetadata(repoPath: string): Promise<RepoMetadata | null> {
  const filePath = join(repoPath, REPO_METADATA_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new RepoMetadataError(`Failed to read ${filePath}: ${(err as Error).message}`, filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RepoMetadataError(
      `Invalid JSON in ${filePath}: ${(err as Error).message}`,
      filePath,
    );
  }

  const result = RepoMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new RepoMetadataError(
      `Invalid schema in ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      filePath,
    );
  }
  return result.data;
}

/**
 * Write `${repoPath}/openswarm.json`. Validates against the schema first so we
 * never persist a malformed mapping. Returns the written file path.
 * Used by `openswarm init` to record the repo ↔ Linear team/project mapping the
 * user picked, so the daemon resolves this repo without fuzzy name matching.
 */
export async function saveRepoMetadata(repoPath: string, meta: RepoMetadata): Promise<string> {
  const validated = RepoMetadataSchema.parse(meta);
  const filePath = join(repoPath, REPO_METADATA_FILENAME);
  // Atomic: loadRepoMetadata has many concurrent readers (projectMapper,
  // worktreeManager.linkSharedPaths, the daemon's repo resolution). An in-place
  // rewrite lets them observe a half-written file and fail with
  // RepoMetadataError. 0o644 preserves the mode a plain write produced — this
  // file lives in the repo and is meant to be readable, unlike the 0o600
  // config files under the user's home directory.
  await atomicWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, 0o644);
  return filePath;
}

/**
 * Read `openswarm.json` `sandbox.bashTimeoutMs` from `repoPath`. Best-effort —
 * a missing/malformed file yields `undefined` (the caller then falls back to an
 * effort-derived or default timeout). Never throws. (INT-2415)
 */
/** Whether this repository asked for a fresh review after each published PR. */
export async function loadPublicationFreshReview(repoPath: string): Promise<boolean> {
  try {
    return (await loadRepoMetadata(repoPath))?.publication?.freshReview === true;
  } catch {
    // An unreadable openswarm.json already warns elsewhere; a review is an
    // opt-in extra, so an unparseable file means "not opted in".
    return false;
  }
}

export async function loadSandboxBashTimeoutMs(repoPath: string): Promise<number | undefined> {
  try {
    const meta = await loadRepoMetadata(repoPath);
    return meta?.sandbox?.bashTimeoutMs;
  } catch {
    return undefined;
  }
}

export class RepoMetadataError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(message);
    this.name = 'RepoMetadataError';
  }
}
