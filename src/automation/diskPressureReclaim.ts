// ============================================
// OpenSwarm - Free disk space by reclaiming pushed, retry-bound worktrees (AGT-4816)
// ============================================
//
// The disk gate (AGT-4785) and preserved worktrees could deadlock. A failed or
// infra_error run goes to RETRY_AT and keeps its worktree_path, which
// getProtectedWorktreePaths shields from pruneWorktrees' age expiry. When free
// space then fell below minFreeDiskGiB the heartbeat returned before fetching,
// so the retries and reconcilers that would finish or abandon those runs never
// ran, and nothing unattended could free the space again.
//
// This is the way out. While the gate pauses dispatch on a measured low
// reading, the heartbeat removes preserved worktrees that are safe to drop:
//   - the run is RETRY_AT or CANCELLED (the ledger has no FAILED state;
//     CANCELLED is its only terminal non-success). NEEDS_HUMAN, NEEDS_SPEC,
//     NEEDS_ENV, NEEDS_RECONCILE and WAITING_EXTERNAL rows are left alone:
//     a person or a reconciler is still expected to look at that tree;
//   - the run holds no owner or lease, and no running task or leased row
//     points at the same tree;
//   - its branch exists on origin. A failed lookup counts as "not pushed".
// Oldest first (ledger updated_at), at most `maxPerHeartbeat` per heartbeat,
// re-measuring before each removal so it stops once space is back over the floor.
//
// Removal goes through removePreservedWorktreeAt: it takes the worktree
// lifecycle lock, re-checks for a live owner, WIP-commits anything uncommitted
// to the local branch, then runs `git worktree remove --force`. The local
// branch survives, and createWorktree resumes a retry from that branch, so
// nothing the run wrote is lost. The ledger row is kept; only its worktree
// pointer is cleared, through the same CAS the missing-worktree reconciler uses.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { removePreservedWorktreeAt } from '../support/worktreeManager.js';
import { ACTIVE_LEASE_STATES, type RunRecord, type RunState } from './runLedgerTypes.js';

const execFileAsync = promisify(execFile);

/** Run states whose preserved worktree may be reclaimed under disk pressure. */
export const RECLAIMABLE_STATES: readonly RunState[] = ['RETRY_AT', 'CANCELLED'];

/** Removals per heartbeat, so one pass cannot spend the heartbeat on cleanup. */
export const DEFAULT_MAX_RECLAIMS_PER_HEARTBEAT = 5;

const LS_REMOTE_TIMEOUT_MS = 30_000;

type ReclaimRun = Pick<RunRecord,
  'issueId' | 'identifier' | 'projectPath' | 'state' | 'stateVersion' | 'worktreePath' | 'branchName'
  | 'ownerInstanceId' | 'leaseToken' | 'updatedAt' | 'lastErrorMessage'>;

export interface DiskPressureReclaimDeps {
  durableRuns: {
    isPrimary: boolean;
    listRuns(states?: readonly RunState[]): ReclaimRun[];
    reconcileMissingWorktree(
      run: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'worktreePath'>,
      disposition: 'clear', reason: string, clearHeadSha: boolean,
    ): boolean;
  };
  /** Configured project roots; a worktree must sit directly under `<project>/worktree/`. */
  projects: readonly string[];
  /** Re-measures free space; true once it is back at or over the floor. */
  spaceRecovered: () => boolean;
  /** Worktree paths of tasks running in this process. */
  runningWorktreePaths?: Iterable<string>;
  /** Defaults to one `git ls-remote --heads origin` per project per pass. */
  lsRemoteHeads?: (projectPath: string) => Promise<string>;
  /** Defaults to {@link removePreservedWorktreeAt}. */
  removeWorktree?: (worktreePath: string) => Promise<void>;
  worktreeExists?: (path: string) => boolean;
  maxPerHeartbeat?: number;
  stopping?: () => boolean;
  log?: (line: string) => void;
}

export interface DiskPressureReclaimResult {
  reclaimed: string[];
  /** True when free space was measured back over the floor during the pass. */
  recovered: boolean;
}

async function defaultLsRemoteHeads(projectPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, 'ls-remote', '--heads', 'origin'], { timeout: LS_REMOTE_TIMEOUT_MS });
  return stdout;
}

/** Branch names on origin, from `ls-remote --heads` output (`<sha>\trefs/heads/<name>`). */
export function parseRemoteHeads(output: string): Set<string> {
  const heads = new Set<string>();
  for (const line of output.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    if (ref?.startsWith('refs/heads/')) heads.add(ref.slice('refs/heads/'.length));
  }
  return heads;
}

/** True when `path` is exactly `<project>/worktree/<one segment>`. */
function isManagedWorktreePath(project: string, path: string): boolean {
  const rel = relative(resolve(project, 'worktree'), resolve(path));
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.includes(sep);
}

type Candidate = ReclaimRun & { worktreePath: string; branchName: string };

/** Reclaimable rows, oldest first: unowned, managed path, on disk, and not pointed at by a lease or running task. */
function selectCandidates(deps: DiskPressureReclaimDeps, exists: (path: string) => boolean): Candidate[] {
  const projects = new Set(deps.projects.map((p) => normalizeProjectPath(p)));
  const busy = new Set<string>([...(deps.runningWorktreePaths ?? [])].map((p) => resolve(p)));
  for (const run of deps.durableRuns.listRuns(ACTIVE_LEASE_STATES)) if (run.worktreePath) busy.add(resolve(run.worktreePath));
  return deps.durableRuns.listRuns(RECLAIMABLE_STATES)
    .filter((run): run is Candidate => (
      !!run.worktreePath && !!run.branchName && run.branchName !== 'HEAD'
      && !run.ownerInstanceId && !run.leaseToken
      && projects.has(run.projectPath)
      && isManagedWorktreePath(run.projectPath, run.worktreePath)
      && !busy.has(resolve(run.worktreePath))
      && exists(run.worktreePath)
    ))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** One origin lookup per project per pass; a failed lookup means "nothing is pushed". */
function originHeadsLookup(
  lsRemoteHeads: (projectPath: string) => Promise<string>,
  log: (line: string) => void,
): (project: string) => Promise<Set<string>> {
  const cache = new Map<string, Promise<Set<string>>>();
  return (project) => {
    let heads = cache.get(project);
    if (!heads) {
      heads = lsRemoteHeads(project).then(parseRemoteHeads).catch((err: unknown) => {
        log(`Origin lookup failed for ${project}; its worktrees count as unpushed: ${errorText(err).split('\n')[0]}`);
        return new Set<string>();
      });
      cache.set(project, heads);
    }
    return heads;
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remove one candidate and clear its pointer. True when the tree is gone. */
async function reclaimOne(
  candidate: Candidate,
  deps: DiskPressureReclaimDeps,
  exists: (path: string) => boolean,
  log: (line: string) => void,
): Promise<boolean> {
  const { durableRuns } = deps;
  // Re-read the row: it may have been claimed, or its pointer cleared, since the list was taken.
  const fresh = durableRuns.listRuns(RECLAIMABLE_STATES).find((run) => run.issueId === candidate.issueId);
  if (!fresh || fresh.worktreePath !== candidate.worktreePath || fresh.ownerInstanceId || fresh.leaseToken) return false;
  try {
    await (deps.removeWorktree ?? ((path: string) => removePreservedWorktreeAt(path)))(candidate.worktreePath);
  } catch (err) {
    log(`Could not reclaim ${candidate.worktreePath}: ${errorText(err)}`);
    return false;
  }
  // The helper returns quietly when a live owner turned up under its lock.
  if (exists(candidate.worktreePath)) return false;
  const previous = fresh.lastErrorMessage ? `; previous error: ${fresh.lastErrorMessage}` : '';
  const cleared = durableRuns.reconcileMissingWorktree(
    fresh, 'clear', `Worktree reclaimed under disk pressure (branch ${candidate.branchName} is on origin)${previous}`, false,
  );
  log(`Reclaimed ${candidate.worktreePath} (${candidate.identifier ?? candidate.issueId}, ${fresh.state}, branch ${candidate.branchName} on origin)`
    + (cleared ? '' : '; ledger pointer left for the missing-worktree reconciler'));
  return true;
}

/**
 * Remove reclaimable preserved worktrees, oldest first, until free space is back
 * over the floor or the per-heartbeat cap is reached. Never throws.
 */
export async function reclaimWorktreesUnderDiskPressure(deps: DiskPressureReclaimDeps): Promise<DiskPressureReclaimResult> {
  const result: DiskPressureReclaimResult = { reclaimed: [], recovered: false };
  if (!deps.durableRuns.isPrimary) return result;
  const log = deps.log ?? ((line: string) => console.log(`[DiskReclaim] ${line}`));
  const stopping = deps.stopping ?? (() => false);
  const exists = deps.worktreeExists ?? existsSync;
  const cap = deps.maxPerHeartbeat ?? DEFAULT_MAX_RECLAIMS_PER_HEARTBEAT;
  try {
    const headsFor = originHeadsLookup(deps.lsRemoteHeads ?? defaultLsRemoteHeads, log);
    for (const candidate of selectCandidates(deps, exists)) {
      if (stopping() || result.reclaimed.length >= cap) break;
      if (deps.spaceRecovered()) { result.recovered = true; break; }
      if (!(await headsFor(candidate.projectPath)).has(candidate.branchName)) continue;
      if (await reclaimOne(candidate, deps, exists, log)) result.reclaimed.push(candidate.worktreePath);
    }
    if (!result.recovered && result.reclaimed.length > 0 && !stopping()) result.recovered = deps.spaceRecovered();
  } catch (err) {
    log(`Disk-pressure reclamation failed: ${errorText(err)}`);
  }
  return result;
}
