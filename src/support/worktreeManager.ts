// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getInstanceId } from './healthEndpoint.js';
import { readyReusedPullRequest } from './pullRequestReady.js';
import { isProofCapableSpace, processAppearsAlive, processNamespaceId, sameProcessNamespace, writerProvablyGone } from './processLiveness.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { registerOwnedPR } from '../automation/prOwnership.js';
import { runConventionalCommitGuard } from '../agents/pipelineGuards.js';
import { loadRepoMetadata } from './repoMetadata.js';

const execFileAsync = promisify(execFile);

/** Wall-clock ceiling for a single git invocation (fetch/push/clone included).
 *  Without it a stalled network git op hangs the whole task before the pipeline's
 *  own timeouts can engage. A timed-out git rejects with ETIMEDOUT/"timed out",
 *  which isInfraError classifies → infra_error backoff, not STUCK. (INT-2521) */
const GIT_TIMEOUT_MS = 5 * 60_000;

/** Safe git command execution (no shell), bounded by GIT_TIMEOUT_MS. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Safe gh command execution (no shell). `cwd` must be inside the target repo —
 * gh infers the repository from the working directory, and the daemon's own
 * cwd is typically NOT a git repo (e.g. started from $HOME), which made every
 * `gh pr create` here die with "fatal: not a git repository" while the push
 * (which does pass a cwd) succeeded — completed work stranded on remote
 * branches with no PR. (INT-2321)
 */
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Resolve the base remote + default branch to branch worktrees and PRs from.
 * OpenSwarm hardcoded `origin/main` everywhere, which silently broke every repo that
 * doesn't match BOTH assumptions: a repo whose default branch is `master`
 * (pykiwoom-rest, ArtifactNet) died at `git worktree add … origin/main` with
 * `fatal: invalid reference: origin/main` → creation failed → the issue could NEVER be
 * worked; a repo whose remote isn't named `origin` (vega-agent uses `unohee`) failed
 * the same way. Prefer the remote's own HEAD (`<remote>/HEAD`), fall back to main then
 * master. Works from a repo path or a worktree path (both share the repo's refs).
 * (INT-2545)
 */
export async function resolveBaseRef(gitDir: string): Promise<{ remote: string; branch: string; ref: string }> {
  const remotes = (await git(gitDir, 'remote').catch(() => ''))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] || 'origin');
  let branch = '';
  try {
    const head = (await git(gitDir, 'symbolic-ref', `refs/remotes/${remote}/HEAD`)).trim();
    branch = head.replace(`refs/remotes/${remote}/`, '');
  } catch { /* <remote>/HEAD not set locally — fall through to probing */ }
  if (!branch) {
    for (const cand of ['main', 'master']) {
      if (await git(gitDir, 'rev-parse', '--verify', `${remote}/${cand}`).then(() => true).catch(() => false)) {
        branch = cand;
        break;
      }
    }
  }
  if (!branch) branch = 'main'; // last resort — a bare repo with no fetched default
  return { remote, branch, ref: `${remote}/${branch}` };
}

// Types

export interface WorktreeInfo {
  /** {repoPath}/worktree/{issueId} */
  worktreePath: string;
  /** swarm/INT-XXX-slug */
  branchName: string;
  /** Original repository path */
  originalPath: string;
  issueId: string;
  /** Unique ownership token for this process generation's active marker. */
  activeMarkerToken?: string;
  /** Files already committed by preserveWorktree for this task and resumed now. */
  resumedTaskFiles?: string[];
}

async function getPreservedTaskFiles(worktreePath: string): Promise<string[]> {
  const log = await git(worktreePath, 'log', '--format=%H%x09%s', '-n', '100').catch(() => '');
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
  let preservedCount = 0;
  while (commits[preservedCount]?.subject.startsWith('wip: preserved partial work')) preservedCount += 1;
  if (preservedCount === 0) return [];

  const base = commits[preservedCount]?.hash;
  const diffArgs = base
    ? ['diff', '--name-only', base, 'HEAD']
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'];
  const files = await git(worktreePath, ...diffArgs);
  return [...new Set(files.split('\n').filter((file) => file && file !== PRESERVE_MARKER))];
}

/** Runtime ownership metadata must never be published in a task branch/PR. */
async function stripRuntimeMarkerFromGit(worktreePath: string): Promise<void> {
  const markerPath = join(worktreePath, PRESERVE_MARKER);
  try { rmSync(markerPath, { force: true }); } catch { /* git cleanup below still runs */ }
  await git(worktreePath, 'rm', '--cached', '--ignore-unmatch', '--', PRESERVE_MARKER).catch(() => '');
}

// Branch & Path Utilities

// The naming convention lives in its own module (branchNaming.ts) so the one
// rule that decides "is this branch mine?" is not buried in lifecycle code.
import { isBranchForIssue, isSwarmBranch } from './branchNaming.js';
// Overlap set arithmetic and rendering live in fileOverlap.ts — pure, and this
// file is at the pre-commit LOC cap. Re-exported so callers keep one import.
export { computeFileOverlaps, formatOverlapReport, type BranchScope, type FileOverlap } from './fileOverlap.js';
import { computeFileOverlaps, formatOverlapReport, type BranchScope, type FileOverlap } from './fileOverlap.js';

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function worktreeRoot(repoPath: string): string {
  return resolve(repoPath, 'worktree');
}

function resolveWorktreePath(repoPath: string, issueId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(issueId) || issueId === '.' || issueId === '..') {
    throw new Error(`Invalid worktree issueId path segment: ${issueId}`);
  }

  const root = worktreeRoot(repoPath);
  const path = resolve(join(root, issueId));
  if (!isPathInside(root, path)) {
    throw new Error(`Resolved worktree path escapes ${root}: ${path}`);
  }
  return path;
}

/** True when a task has an on-disk worktree that createWorktree can reconcile/resume. */
export async function hasRecoverableWorktree(repoPath: string, issueId: string, branchName: string): Promise<boolean> {
  try {
    if (existsSync(resolveWorktreePath(repoPath, issueId))) return true;
    return await git(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`)
      .then(() => true)
      .catch(() => false);
  } catch {
    return false;
  }
}

function assertManagedWorktreePath(repoPath: string, worktreePath: string): string {
  const root = worktreeRoot(repoPath);
  const path = resolve(worktreePath);
  if (!isPathInside(root, path)) {
    throw new Error(`Refusing to remove unmanaged worktree path: ${path}`);
  }
  return path;
}

// Shared deps/data linking (INT-2415)
//
// A worktree is created fresh from origin/main, so it has NO node_modules / .venv
// and none of the repo's gitignored real data (db/*.db etc.) — a worker there
// physically cannot run npm/pytest/playwright or real-data verification. We keep
// the worktree isolating CODE, but SHARE the original repo's gitignored deps/data
// into it via symlink. The original repo is itself the installed sandbox, and
// deps/DBs are read-mostly, so parallel workers sharing them is safe.

/** Always-gitignored dependency dirs safe to auto-link without a config. */
const AUTO_SHARED_CANDIDATES = ['node_modules', '.venv-verify', '.venv', 'venv'];

interface SandboxConfig {
  sandbox?: { sharedPaths?: string[] } | null;
}

/**
 * Pure decision: which repo-relative paths should be symlinked into a worktree.
 *
 * - If openswarm.json declares `sandbox.sharedPaths`, trust that list verbatim
 *   (the repo owner opted in — no gitignore check).
 * - Otherwise auto-detect only the always-gitignored dependency dirs
 *   (node_modules/.venv/venv); never a tracked dir.
 *
 * Returns only candidates that actually EXIST at `<repoPath>/<P>` (read-only
 * check). Absolute or parent-escaping (`..`) entries are dropped for safety.
 * The symlink creation itself is the caller's side effect. (INT-2415)
 */
export function resolveSharedPaths(repoPath: string, openswarmJson?: SandboxConfig | null): string[] {
  const configured = openswarmJson?.sandbox?.sharedPaths;
  const candidates = configured && configured.length > 0 ? configured : AUTO_SHARED_CANDIDATES;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) continue; // never escape the repo
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(join(repoPath, p))) out.push(p);
  }
  return out;
}

/**
 * Symlink the original repo's shared gitignored deps/data into a fresh worktree.
 * Best-effort and idempotent: skips paths already present in the worktree (never
 * clobbers a checked-out tracked dir) and swallows per-link failures (a failed
 * symlink degrades to today's no-deps behavior, never breaks worktree creation).
 */
async function linkSharedPaths(repoPath: string, worktreePath: string): Promise<void> {
  let meta: SandboxConfig | null = null;
  try {
    meta = await loadRepoMetadata(repoPath);
  } catch (err) {
    // Malformed openswarm.json must not break worktree creation. (INT-2415)
    console.warn(`[Worktree] openswarm.json unreadable; skipping sharedPaths config:`, err);
  }

  for (const rel of resolveSharedPaths(repoPath, meta)) {
    const target = join(repoPath, rel); // absolute source so the link survives any cwd
    const linkPath = join(worktreePath, rel);
    try {
      if (existsSync(linkPath)) continue; // tracked dir already checked out — do not clobber
      mkdirSync(dirname(linkPath), { recursive: true }); // support nested sharedPaths (e.g. db/x.db)
      symlinkSync(target, linkPath);
      console.log(`[Worktree] Linked shared path: ${rel} -> ${target}`);
    } catch (err) {
      console.warn(`[Worktree] Failed to link shared path ${rel}:`, err);
    }
  }
}

// Worktree Lifecycle

/** Create git worktree + checkout branch */
/**
 * Marker dropped into a failed session's worktree so its partial implementation
 * survives cleanup and the retry RESUMES from it instead of re-implementing from
 * scratch (INT-2503). pruneWorktrees skips marked dirs; createWorktree reuses
 * them; a successful run still removes the worktree as before.
 */
const PRESERVE_MARKER = '.openswarm-preserved';
const ACTIVE_MARKER_DIR = 'openswarm/active-worktrees';
const LIFECYCLE_LOCK_DIR = 'openswarm/worktree-lifecycle-locks';
/** Preserved trees older than this are abandoned (task STUCK or issue closed) — swept. */
const PRESERVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActiveWorktreeMarker {
  issueId: string;
  branchName: string;
  worktreePath: string;
  originalPath: string;
  ownerPid: number;
  /** Missing only on legacy single-file markers written before token fencing. */
  ownerToken?: string;
  /**
   * The process that wrote this marker, as a per-process id.
   *
   * Used in one direction only: a marker whose id matches ours is positively
   * ours, and therefore live. A differing id is NOT evidence of death — every
   * concurrently running OpenSwarm process would fail that comparison too.
   * Missing on markers written before this field existed.
   */
  ownerInstanceId?: string;
  /**
   * The pid space the writer lived in — the scope within which its pid is
   * unique. Two daemons sharing this checkout each have their own pid 1, so a
   * matching pid number means nothing across them.
   *
   * A string identifies the space; `null` records that the writer could not
   * determine its own; absent means the marker predates the field. The three
   * are distinct — collapsing "unknown" into "absent" would let a fail-closed
   * writer be probed as if it had opted into the legacy rule.
   */
  ownerNamespace?: string | null;
  createdAt: string;
}

async function activeMarkerDirectory(repoPath: string): Promise<string> {
  const commonRaw = (await git(repoPath, 'rev-parse', '--git-common-dir')).trim();
  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(repoPath, commonRaw);
  return join(commonDir, ACTIVE_MARKER_DIR);
}

async function activeMarkerPath(repoPath: string, issueId: string, ownerToken: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(issueId) || issueId === '.' || issueId === '..') {
    throw new Error(`Invalid active marker issueId path segment: ${issueId}`);
  }
  return join(await activeMarkerDirectory(repoPath), issueId, `${ownerToken}.json`);
}

/** A `createWorktree()` failure that is a coordination/staleness problem the
 *  daemon resolves on its own reconciliation pass (a concurrent lease holding
 *  the lifecycle lock, a preserved or crash-recovered tree needing
 *  reconciliation) — never the target repository's own disk/git health.
 *  Callers use `instanceof` rather than matching `.message` text, which stays
 *  correct if the wording above ever changes (AGT-4038). */
export class WorktreeCoordinationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorktreeCoordinationError';
  }
}

async function withWorktreeLifecycleLock<T>(
  repoPath: string,
  issueId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9._-]+$/.test(issueId) || issueId === '.' || issueId === '..') {
    throw new Error(`Invalid worktree lifecycle issueId path segment: ${issueId}`);
  }
  const markerDirectory = await activeMarkerDirectory(repoPath);
  const commonDirectory = resolve(markerDirectory, '..', '..');
  const lockDirectory = join(commonDirectory, LIFECYCLE_LOCK_DIR);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDirectory, `${issueId}.db`);
  const lockDb = new Database(lockPath, { timeout: 0 });
  chmodSync(lockPath, 0o600);
  try {
    lockDb.exec('BEGIN IMMEDIATE');
  } catch (error) {
    lockDb.close();
    if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
      throw new WorktreeCoordinationError(`Worktree lifecycle is busy for ${issueId}`, { cause: error });
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    try { lockDb.exec('ROLLBACK'); } finally { lockDb.close(); }
  }
}

async function writeActiveWorktreeMarker(info: WorktreeInfo): Promise<string> {
  const ownerToken = randomUUID();
  const markerPath = await activeMarkerPath(info.originalPath, info.issueId, ownerToken);
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const marker: ActiveWorktreeMarker = {
    ...info,
    ownerPid: process.pid,
    ownerToken,
    ownerInstanceId: getInstanceId(),
    // `?? null` deliberately: an omitted key would be indistinguishable from
    // a pre-field marker, which readers are entitled to probe locally.
    ownerNamespace: processNamespaceId() ?? null,
    createdAt: new Date().toISOString(),
  };
  const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tempPath, markerPath);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
  return ownerToken;
}

async function readActiveWorktreeMarkers(
  repoPath: string,
  worktreePath: string,
): Promise<{ markers: ActiveWorktreeMarker[]; unreadable: boolean }> {
  const issueId = basename(worktreePath.replace(/\/+$/, ''));
  const directory = await activeMarkerDirectory(repoPath);
  const markerPaths: string[] = [];
  try {
    markerPaths.push(...readdirSync(join(directory, issueId))
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(directory, issueId, name)));
  } catch { /* no tokenized markers */ }
  // Backward compatibility with the pre-token single-file marker.
  const legacyPath = join(directory, `${issueId}.json`);
  if (existsSync(legacyPath)) markerPaths.push(legacyPath);

  const markers: ActiveWorktreeMarker[] = [];
  let unreadable = false;
  for (const markerPath of markerPaths) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ActiveWorktreeMarker;
      if (
        marker.issueId !== issueId
        || marker.worktreePath !== worktreePath
        || !Number.isSafeInteger(marker.ownerPid)
      ) {
        unreadable = true;
        continue;
      }
      markers.push(marker);
    } catch {
      unreadable = true;
    }
  }
  markers.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { markers, unreadable };
}

async function clearActiveWorktreeMarker(info: WorktreeInfo): Promise<void> {
  // A tokenless WorktreeInfo cannot prove which process generation owns a
  // marker. Fail closed instead of deleting a newer owner's marker.
  if (!info.activeMarkerToken) return;
  try {
    const markerPath = await activeMarkerPath(info.originalPath, info.issueId, info.activeMarkerToken);
    rmSync(markerPath, { force: true });
  } catch (error) {
    console.warn(`[Worktree] Failed to clear active marker for ${info.worktreePath}:`, error);
  }
}

function preserveMarkerAgeMs(worktreePath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(worktreePath, PRESERVE_MARKER), 'utf8')) as { at?: string };
    const at = raw.at ? Date.parse(raw.at) : NaN;
    return Number.isFinite(at) ? Date.now() - at : null;
  } catch {
    return null; // unreadable marker → retain for manual/durable reconciliation
  }
}

export type WorktreeRecoveryStatus =
  | { state: 'missing'; worktreePath: string }
  | { state: 'preserved'; worktreePath: string }
  | { state: 'active_owner'; worktreePath: string; marker: ActiveWorktreeMarker }
  | { state: 'orphaned'; worktreePath: string; marker: ActiveWorktreeMarker }
  | { state: 'ambiguous'; worktreePath: string };


/** This container assigns the daemon process the same pid every restart, so
 * a marker from a dead prior generation makes `processAppearsAlive` hit the
 * *current* daemon and read "alive" forever (reference_container_pid_reuse_lock.md,
 * occurrence #3). Unlike a ledger lease, this marker is written once at
 * createWorktree() and never touched again by a single in-flight execution,
 * so there's no per-heartbeat renewal to fall back on — the threshold must
 * instead outlast the longest a genuinely still-alive same-generation owner
 * could hold it.
 *
 * `stageTimeoutMs()` only FLOORS an unset/zero stage timeout up to a default
 * ceiling (worker 20min, reviewer/tester/documenter/auditor 6min each —
 * "Never allow 0", INT-2521) — it does not cap a deliberately configured
 * longer value. With defaults and `maxIterations` (default 3), a continuous
 * single-attempt execution is on the order of a couple hours, giving the
 * 24h default here roughly a 10x margin — every *retried* attempt on the
 * same worktree also calls createWorktree()'s resume path, which rewrites
 * this marker (resetting its age) before that attempt starts. A deployment
 * that deliberately configures per-stage timeouts far beyond the defaults
 * can override the default via OPENSWARM_ACTIVE_MARKER_ABANDON_MS. */
const DEFAULT_ACTIVE_MARKER_ABANDON_MS = 24 * 60 * 60 * 1000;

function activeMarkerAbandonMs(): number {
  const parsed = Number(process.env.OPENSWARM_ACTIVE_MARKER_ABANDON_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVE_MARKER_ABANDON_MS;
}

/**
 * Whether a marker's writer can still be running.
 *
 * A marker stamped with a *different* daemon boot is abandoned outright: that
 * process is provably gone, whatever the pid table now says. `ownerPid` alone
 * cannot decide this in a container, where pids repeat and a restarted daemon
 * finds the recorded pid alive again — which left every restart's orphans
 * looking live for the full 24-hour window and wedged the admission cap.
 *
 * Markers from this boot, and legacy markers with no boot recorded, keep the
 * original pid + age test so a live long-running stage is still protected.
 */
/**
 * A marker whose writer is provably gone by the shared pid proof: it carries
 * OUR pid but predates our start, so it belongs to a process that has since
 * exited. Needs no field on the marker, so it also releases the markers a
 * crashed daemon left behind before `ownerInstanceId` existed. (AGT-4067)
 */
function markerWriterIsGone(marker: ActiveWorktreeMarker): boolean {
  // Gated on the recorded pid space, because that is the scope in which a pid
  // is unique. This checkout can be mounted into more than one container, each
  // with its own pid 1, and taking a worktree from a live owner in another one
  // would put two executors on the same tree. A marker from a different space —
  // or one written before the field existed — is not reasoned about by pid at
  // all; it falls back to the age window. (Caught by the commit-gate review.)
  // A machine hint is not enough: "this pid is mine, so its writer exited"
  // needs the pid numbering to be the same numbering, which only a real pid
  // space establishes.
  if (!isProofCapableSpace(marker.ownerNamespace ?? undefined)) return false;
  if (!sameProcessNamespace(marker.ownerNamespace ?? undefined)) return false;
  return writerProvablyGone({
    pid: marker.ownerPid,
    ownerId: marker.ownerInstanceId,
    ourOwnerId: getInstanceId(),
    writtenAtMs: Date.parse(marker.createdAt),
  });
}

/**
 * Whether the marker's writer is *provably* gone — not merely unresponsive.
 *
 * `processAppearsAlive` cannot answer this in a container, where pids are handed
 * out deterministically and a restarted daemon very often finds the recorded pid
 * alive again as something unrelated. The 24-hour age was then the only thing
 * that could ever release such a marker, so every restart left each in-flight
 * run looking active for a full day; a NEEDS_RECONCILE row still occupies an
 * admission slot, so the autonomous loop stopped taking work altogether.
 *
 * Note the asymmetry in how `ownerInstanceId` is read. A *matching* id is
 * positive identification — we wrote it, so its writer is obviously alive. A
 * *differing* id proves nothing at all: a concurrently running OpenSwarm
 * process (`openswarm attach`, a manual `openswarm run`, a second daemon) is
 * equally "not us", and taking its worktree would put two owners on one tree.
 * Only the pid test below is proof, and it holds however many processes run.
 * (Caught by the commit-gate review.)
 */
function markerWriterProvablyGone(marker: ActiveWorktreeMarker): boolean {
  if (marker.ownerInstanceId === getInstanceId()) return false;
  return markerWriterIsGone(marker);
}

/**
 * Whether this marker's pid can be probed at all from here.
 *
 * A pid only means something inside the space it was issued in. Probing a
 * marker that names a *different* space tells us about whatever holds that
 * number locally, and a "not alive" answer from that would authorise taking a
 * worktree a live container still owns. Such a marker is treated as live and
 * left to the age window — or, where there is none, left alone.
 *
 * A marker with no space recorded predates the field and keeps the original
 * pid-probe behaviour, which is no worse than before it existed.
 * (Caught by the commit-gate review.)
 */
function markerPidIsJudgeable(marker: ActiveWorktreeMarker): boolean {
  // Three states, three answers:
  //
  //  - **absent** — predates the field. Keeps the original local probe, which
  //    is the behaviour this module inherited and must not regress.
  //  - **null** — the writer could name no space at all. Fail closed: it is a
  //    Linux process that could not read /proc/self/ns/pid, and probing its pid
  //    here would answer about a different pid table. Costs nothing now that
  //    platforms without pid namespaces record a host hint instead of null.
  //  - **a string** — probe only if it is our space. A different one is another
  //    machine or another container, where our pid table says nothing.
  //
  // KNOWN LIMITATION (AGT-4069, pre-existing): an *absent* record, and a host
  // hint that happens to match, still get the local probe. Two machines sharing
  // a state directory under the same host name can therefore still judge each
  // other's live owner dead — as this code already did. Closing that needs a
  // real OS machine identity, tracked separately.
  if (marker.ownerNamespace === undefined) return true;
  if (marker.ownerNamespace === null) return false;
  return sameProcessNamespace(marker.ownerNamespace);
}

function markerLooksLive(marker: ActiveWorktreeMarker): boolean {
  if (!markerPidIsJudgeable(marker)) return (activeMarkerAgeMs(marker) ?? 0) < activeMarkerAbandonMs();
  if (markerWriterProvablyGone(marker)) return false;
  return processAppearsAlive(marker.ownerPid) && (activeMarkerAgeMs(marker) ?? 0) < activeMarkerAbandonMs();
}

/** Null on an unreadable/unparseable timestamp — callers must treat that as
 * "not provably abandoned" (mirrors preserveMarkerAgeMs's fail-safe null). */
function activeMarkerAgeMs(marker: ActiveWorktreeMarker): number | null {
  const at = Date.parse(marker.createdAt);
  return Number.isFinite(at) ? Date.now() - at : null;
}

/** Fail-closed recovery evidence for an expired run. A live marker owner may
 * still be writing after losing its lease, so only a preserved tree or a dead
 * owner is safe to resume automatically. */
export async function inspectWorktreeRecovery(
  repoPath: string,
  issueId: string,
  recordedPath?: string,
): Promise<WorktreeRecoveryStatus> {
  const worktreePath = recordedPath
    ? assertManagedWorktreePath(repoPath, recordedPath)
    : resolveWorktreePath(repoPath, issueId);
  if (!existsSync(worktreePath)) return { state: 'missing', worktreePath };
  const active = await readActiveWorktreeMarkers(repoPath, worktreePath);
  const liveMarker = active.markers.find(markerLooksLive);
  if (liveMarker) return { state: 'active_owner', worktreePath, marker: liveMarker };
  if (existsSync(join(worktreePath, PRESERVE_MARKER))) {
    return preserveMarkerAgeMs(worktreePath) === null
      ? { state: 'ambiguous', worktreePath }
      : { state: 'preserved', worktreePath };
  }
  if (active.unreadable) return { state: 'ambiguous', worktreePath };
  const marker = active.markers[0];
  if (!marker) return { state: 'ambiguous', worktreePath };
  return { state: 'orphaned', worktreePath, marker };
}

/**
 * Discard a preserved worktree, keeping the partial work reachable: best-effort
 * commit it onto the tree's swarm branch (survives worktree removal, human can
 * inspect), then remove the directory. Used when a task goes terminally STUCK
 * and by the age sweep. Accepts the worktree path itself — the repo root is the
 * segment before `/worktree/<id>`. No-op for paths that don't match. (INT-2506)
 */
async function removePreservedWorktreeAtUnlocked(worktreePath: string): Promise<void> {
  const m = worktreePath.replace(/\/+$/, '').match(/^(.*)\/worktree\/[^/]+$/);
  if (!m || !existsSync(worktreePath)) return;
  const repoRoot = m[1];
  try {
    await stripRuntimeMarkerFromGit(worktreePath);
    await git(worktreePath, 'add', '-A');
    await git(
      worktreePath,
      '-c', 'user.email=swarm@openswarm.local', '-c', 'user.name=OpenSwarm',
      'commit', '--no-verify', '-m', 'wip: preserved partial work (auto, pre-cleanup)',
    );
    console.log(`[Worktree] WIP committed to branch before cleanup: ${worktreePath}`);
  } catch { /* clean tree or commit failure — proceed with removal */ }
  await git(repoRoot, 'worktree', 'remove', '--force', worktreePath).catch(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });
  console.log(`[Worktree] Removed preserved worktree: ${worktreePath}`);
}

export async function removePreservedWorktreeAt(worktreePath: string): Promise<void> {
  const normalized = worktreePath.replace(/\/+$/, '');
  const match = normalized.match(/^(.*)\/worktree\/([^/]+)$/);
  if (!match || !existsSync(normalized)) return;
  await withWorktreeLifecycleLock(match[1], match[2], async () => {
    // The cleanup request may have been queued while an operator reopened the
    // issue. Re-check ownership under the lock; a resumed worker publishes its
    // active marker before releasing this same lock.
    const active = await readActiveWorktreeMarkers(match[1], normalized);
    if (active.unreadable
      || active.markers.some((marker) => (
        // No age escape at this site, so an unjudgeable pid means "keep": a
        // preserved tree still reachable by a live owner elsewhere must not be
        // deleted. pruneWorktrees' preserved-tree expiry is the backstop.
        !markerPidIsJudgeable(marker)
        || (!markerWriterProvablyGone(marker) && processAppearsAlive(marker.ownerPid))
      ))) return;
    await removePreservedWorktreeAtUnlocked(normalized);
  });
}

/**
 * Preserve a failed session's worktree when it holds actual work: drop the
 * marker and leave the tree in place. A clean tree has nothing worth keeping —
 * remove it as before. Returns true when preserved.
 */
export async function preserveWorktree(info: WorktreeInfo, reason: string): Promise<boolean> {
  const worktreePath = assertManagedWorktreePath(info.originalPath, info.worktreePath);
  // Distinguish a genuinely clean tree from a git-status FAILURE (index/ref lock
  // under parallel load, transient corruption). The old `.catch(() => '')` treated
  // an error as "clean" → removeWorktree DELETED trees that may hold real partial
  // work whenever git merely errored, defeating the preserve-for-resume guarantee.
  // On any doubt, PRESERVE — never delete unconfirmed work. (INT-2521)
  let dirty: string | null;
  try {
    dirty = await git(worktreePath, 'status', '--porcelain');
  } catch (err) {
    if (!existsSync(worktreePath)) return false; // tree gone — nothing to preserve or remove
    console.warn(`[Worktree] git status failed — preserving the tree to be safe: ${worktreePath}`, err instanceof Error ? err.message : err);
    dirty = null;
  }
  if (dirty !== null && !dirty.trim()) {
    await removeWorktree(info);
    return false;
  }
  const fileCount = dirty === null ? 0 : dirty.split('\n').filter(Boolean).length;
  // INT-2729: the marker keeps the *directory* around for resume, but the partial
  // work stays UNCOMMITTED — a manual cleanup of the worktree dir (e.g. a migration
  // sweep) then loses it silently, even for a substantial, finished implementation
  // (observed live: STO-1351, a 700+ line service preserved 7 days with zero commits,
  // nearly lost). Capture the dirty work as a WIP commit on the swarm branch now, so
  // it survives dir removal as a reachable git ref a human (or the retry) can recover.
  // This runs BEFORE the marker is written so `git add -A` never stages the internal
  // `.openswarm-preserved` control file into user history. Best-effort and silent: a
  // commit failure just leaves the marker (written below) as the sole protection, as
  // before. NEVER throw — same preserve path the INT-2521 ENOSPC guard exists for.
  // Only meaningful when git status actually reported dirty files.
  if (dirty !== null && fileCount > 0) {
    try {
      await git(worktreePath, 'add', '-A');
      await git(
        worktreePath,
        '-c', 'user.email=swarm@openswarm.local', '-c', 'user.name=OpenSwarm',
        'commit', '--no-verify', '-m', `wip: preserved partial work (auto, ${reason})`,
      );
      console.log(`[Worktree] WIP committed to ${info.branchName} before preserve: ${worktreePath}`);
    } catch (err) {
      console.warn(`[Worktree] WIP commit before preserve failed (marker still protects the tree): ${worktreePath}`, err instanceof Error ? err.message : err);
    }
  }
  // The resume marker lets the next attempt consume this work. The independent
  // active marker in git's common metadata also protects the tree if this write
  // fails halfway through (for example ENOSPC).
  //   1. Never throw. An unguarded writeFileSync threw ENOSPC straight through
  //      executePipeline and crashed the whole daemon under a full disk (observed
  //      live: disk 100% → runner crash-loop). (INT-2521)
  //   2. Never delete unconfirmed work just to reclaim space.
  const markerPath = join(worktreePath, PRESERVE_MARKER);
  try {
    writeFileSync(
      markerPath,
      JSON.stringify({ issueId: info.issueId, branchName: info.branchName, reason, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.warn(`[Worktree] Preserve-marker write failed — quarantining active tree: ${worktreePath}`, err instanceof Error ? err.message : err);
    // A failed write can leave a truncated marker. Drop that file, but keep the
    // active marker and worktree for durable reconciliation.
    try { rmSync(markerPath, { force: true }); } catch { /* read-only/ENOSPC — active marker still keeps it quarantined */ }
    return false;
  }
  await clearActiveWorktreeMarker(info);
  const label = dirty === null ? 'git status unavailable — preserved to be safe' : `${fileCount} dirty files`;
  console.log(`[Worktree] Preserved for retry (${label}, ${reason}): ${worktreePath}`);
  return true;
}

export async function createWorktree(
  repoPath: string,
  issueId: string,
  branchName: string,
  /** Branch from this commit-ish instead of the remote's default branch, skipping
   *  the fetch. Used by `review --max --fix`, which audits the code the user
   *  currently has checked out (its HEAD), not the remote tip. (INT-2905) */
  baseRefOverride?: string,
): Promise<WorktreeInfo> {
  const worktreePath = resolveWorktreePath(repoPath, issueId);
  return withWorktreeLifecycleLock(repoPath, issueId, async () => {

  // Retry of a preserved failure: RESUME from the previous attempt's partial
  // work (and its build caches) instead of wiping it (INT-2503). Consume the
  // marker — if this attempt fails again it gets re-preserved by the runner.
  if (existsSync(worktreePath) && existsSync(join(worktreePath, PRESERVE_MARKER))) {
    const valid = await git(worktreePath, 'status', '--porcelain').then(() => true).catch(() => false);
    const branch = await git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').then((b) => b.trim()).catch(() => '');
    if (valid && branch === branchName) {
      const resumed: WorktreeInfo = {
        worktreePath, branchName, originalPath: repoPath, issueId,
        resumedTaskFiles: await getPreservedTaskFiles(worktreePath),
      };
      resumed.activeMarkerToken = await writeActiveWorktreeMarker(resumed);
      try {
        // Acquire the new generation's ownership marker before consuming the
        // preserve marker. A crash between these operations then leaves at
        // least one recoverable owner/preserve proof instead of an unmarked gap.
        rmSync(join(worktreePath, PRESERVE_MARKER), { force: true });
      } catch (error) {
        await clearActiveWorktreeMarker(resumed);
        throw error;
      }
      console.log(`[Worktree] Resuming preserved worktree: ${worktreePath} (branch: ${branchName})`);
      return resumed;
    }
    throw new WorktreeCoordinationError(`Preserved worktree requires reconciliation (valid=${valid}, branch=${branch}): ${worktreePath}`);
  }

  // Crash recovery: never delete an existing tree before the durable reconciler
  // has inspected it. A valid tree on the expected branch is safe to resume even
  // when the process died before it could write the preserve marker.
  if (existsSync(worktreePath)) {
    const valid = await git(worktreePath, 'status', '--porcelain').then(() => true).catch(() => false);
    const branch = await git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').then((b) => b.trim()).catch(() => '');
    if (!valid || branch !== branchName) {
      throw new WorktreeCoordinationError(`Existing worktree requires reconciliation (valid=${valid}, branch=${branch}): ${worktreePath}`);
    }
    const resumed: WorktreeInfo = {
      worktreePath, branchName, originalPath: repoPath, issueId,
      resumedTaskFiles: await getPreservedTaskFiles(worktreePath),
    };
    resumed.activeMarkerToken = await writeActiveWorktreeMarker(resumed);
    console.log(`[Worktree] Resuming crash-recovered worktree: ${worktreePath} (branch: ${branchName})`);
    return resumed;
  }

  // A previous attempt may have removed its worktree while keeping a WIP branch.
  // Resume that branch; never force-delete recoverable commits.
  const branchExists = await git(repoPath, 'branch', '--list', branchName)
    .then((out) => out.trim().length > 0)
    .catch((e) => { console.warn(`[Worktree] Branch check failed for ${branchName}:`, e); return false; });

  let baseRef = branchName;
  if (branchExists) {
    await git(repoPath, 'worktree', 'add', worktreePath, branchName);
  } else {
    // Resolve the repo's real base ref (remote + default branch) — NOT hardcoded
    // origin/main, which fataled on master-default / non-origin repos. (INT-2545)
    baseRef = baseRefOverride ?? '';
    if (!baseRef) {
      const base = await resolveBaseRef(repoPath);
      await git(repoPath, 'fetch', base.remote, base.branch).catch((e) =>
        console.warn(`[Worktree] Failed to fetch ${base.ref}:`, e)
      );
      baseRef = base.ref;
    }
    await git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, baseRef);
  }
  console.log(`[Worktree] Created: ${worktreePath} (branch: ${branchName}, base: ${baseRef})`);

  const info: WorktreeInfo = {
    worktreePath, branchName, originalPath: repoPath, issueId,
    resumedTaskFiles: branchExists ? await getPreservedTaskFiles(worktreePath) : undefined,
  };
  // Written before dependency setup or worker invocation. A crash anywhere after
  // `git worktree add` is therefore recoverable.
  info.activeMarkerToken = await writeActiveWorktreeMarker(info);

  // Share the original repo's gitignored deps/data into the fresh worktree so the
  // worker can actually install / run tests / verify against real data. (INT-2415)
  await linkSharedPaths(repoPath, worktreePath);

  // Self-heal a broken LFS smudge in the fresh checkout. A failed smudge is what
  // pushes a worker to bypass the clean filter (`-c filter.lfs.clean=`) when `git
  // status` errors on it — the actual trigger for the filter-bypass corruption
  // guardLfsFilterCorruption defends against below. (INT-2430)
  await ensureLfsSmudged(worktreePath);

  return info;
  });
}

/** True if the worktree's .gitattributes declares any LFS-filtered path. */
function repoUsesLfs(worktreePath: string): boolean {
  try {
    return /filter=lfs\b/.test(readFileSync(join(worktreePath, '.gitattributes'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Best-effort: re-pull LFS objects so tracked files are real content on disk, not
 * literal pointer text (a failed/partial smudge). No-op (swallowed) for repos that
 * don't use LFS or when git-lfs isn't installed. (INT-2430)
 */
async function ensureLfsSmudged(worktreePath: string): Promise<void> {
  if (!repoUsesLfs(worktreePath)) return;
  await git(worktreePath, 'lfs', 'pull').catch((e) =>
    console.warn(`[Worktree] git lfs pull self-heal failed (non-fatal): ${worktreePath}`, e instanceof Error ? e.message : e),
  );
}

// File-overlap report (INT-2388 defect #3 / INT-2392)
//
// Parallel swarm branches don't see each other's changes, so two efforts edit
// the same files and diverge (self-demonstrated on INT-2388). When a PR is
// created, surface which open PRs / active swarm/* branches touch the same
// files — advisory only, never blocks PR creation.

export interface OpenPRFileOverlap extends FileOverlap {
  number: number;
  url: string;
}

export interface BranchPullRequest {
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headSha?: string;
}

/** Artifact-truth lookup used by crash reconciliation. Throws when GitHub is
 * unavailable so callers keep the run fail-closed instead of assuming no PR. */
export async function findPullRequestForBranch(
  repoPath: string,
  branchName: string,
): Promise<BranchPullRequest | null> {
  const raw = await gh(
    repoPath,
    'pr', 'list', '--head', branchName, '--state', 'all', '--limit', '10',
    '--json', 'url,state,isDraft,headRefOid',
  );
  const rows = JSON.parse(raw) as Array<{
    url?: string;
    state?: string;
    isDraft?: boolean;
    headRefOid?: string;
  }>;
  const row = rows.find((candidate) => candidate.url && ['OPEN', 'CLOSED', 'MERGED'].includes(candidate.state ?? ''));
  if (!row?.url || !row.state) return null;
  return {
    url: row.url,
    state: row.state as BranchPullRequest['state'],
    isDraft: row.isDraft ?? false,
    headSha: row.headRefOid,
  };
}

/**
 * Check planned files before a worker branch is created. This is intentionally
 * fail-open when GitHub is unavailable, but a successful query lets the runner
 * avoid producing another divergent implementation of the same files.
 */
export async function findOpenPRFileOverlaps(
  repoPath: string,
  plannedFiles: string[],
  /**
   * Which open PRs count as competing work.
   *
   * A PR reserves its files while a worker is editing them, and `publishOnPark`
   * leaves a PR behind long after its worker exits — so an open PR alone is not
   * evidence of anyone editing. Two exclusions follow: the dispatched issue's
   * own PR (AGT-4095), and a `swarm/*` PR whose run no longer holds a lease
   * (AGT-4097).
   *
   * A branch outside the `swarm/` namespace — a human's, another tool's — has
   * no run to consult, so it always reserves.
   *
   * `activeIssueIdentifiers` distinguishes "none are active" from "I cannot
   * tell": an array, **including an empty one**, asserts it is the complete set
   * of held leases; `undefined` means the caller has no ledger to ask, and
   * every `swarm/*` PR keeps reserving. Getting those two confused would empty
   * the gate on any caller that simply never wired the accessor.
   */
  competing: {
    selfIssueIdentifier?: string;
    /** Issues whose runs a worker currently holds; undefined when unknowable. */
    activeIssueIdentifiers?: readonly string[];
  } = {},
): Promise<OpenPRFileOverlap[]> {
  if (plannedFiles.length === 0) return [];
  const planned = new Set(plannedFiles.map((f) => f.replace(/^\.\//, '')));
  try {
    // `files` is available on `gh pr list --json`; fetch every scope in one API
    // request instead of running an unbounded `gh pr diff` loop.
    // gh paginates internally up to the requested limit. 1,000 is a deliberate
    // safety ceiling well above GitHub's practical open-PR queue sizes while
    // keeping one bounded request and covering the former 100-PR blind spot.
    const raw = await gh(repoPath, 'pr', 'list', '--state', 'open', '--json', 'number,url,headRefName,files', '--limit', '1000');
    const prs: { number: number; url: string; headRefName: string; files?: { path: string }[] }[] = JSON.parse(raw || '[]');
    const overlaps: OpenPRFileOverlap[] = [];
    for (const pr of prs) {
      if (competing.selfIssueIdentifier && isBranchForIssue(pr.headRefName, competing.selfIssueIdentifier)) continue;
      const active = competing.activeIssueIdentifiers;
      const heldByAWorker = active === undefined
        || active.some((id) => isBranchForIssue(pr.headRefName, id));
      if (isSwarmBranch(pr.headRefName) && !heldByAWorker) continue;
      const shared = (pr.files ?? []).map((f) => f.path).filter((f) => planned.has(f.replace(/^\.\//, '')));
      if (shared.length > 0) overlaps.push({ number: pr.number, url: pr.url, label: `PR #${pr.number} (${pr.headRefName})`, files: shared });
    }
    return overlaps;
  } catch (err) {
    console.warn('[Worktree] Preflight open-PR overlap check skipped:', err);
    return [];
  }
}

/** Split git/gh newline output into a trimmed, non-empty list. */
function toLines(out: string): string[] {
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

// Unsafe binary staging guard (INT-2430)
//
// When a worker hits a permission error running `git status` on an LFS-tracked
// repo, it can work around it with `-c filter.lfs.clean= -c filter.lfs.smudge=`.
// That makes every already-smudged LFS binary (real content on disk) look
// "modified" against its pointer, and the worker mistakes them for its own
// changes — the subsequent `git add -A` (worker's or ours, right before commit)
// stages them for real. An automated code-change commit has no legitimate reason
// to touch a data dump, so these extensions are excluded outright regardless of
// *why* they ended up staged. Real incident: PR #213/STONKS committed
// nas_data/fnguide/*.duckdb and models/validated_features/*.parquet this way —
// reverted by hand.
const UNSAFE_BINARY_DATA_RE = /\.(duckdb|parquet|pkl|pt)$/i;

/** Unstage any staged file matching an unsafe binary-data extension so it can
 *  never reach the commit. Best-effort — a failed unstage is logged, not thrown,
 *  since letting the binary through would be strictly worse. */
async function guardUnsafeBinaryStaging(worktreePath: string): Promise<void> {
  const staged = toLines(await git(worktreePath, 'diff', '--cached', '--name-only').catch(() => ''));
  const unsafe = staged.filter((f) => UNSAFE_BINARY_DATA_RE.test(f));
  if (unsafe.length === 0) return;

  console.warn(
    `[Worktree] Unstaging ${unsafe.length} binary data file(s) matching .duckdb/.parquet/.pkl/.pt — ` +
    `automated commits never intentionally touch these (INT-2430): ${unsafe.join(', ')}`,
  );
  for (const file of unsafe) {
    await git(worktreePath, 'reset', 'HEAD', '--', file).catch((e) =>
      console.warn(`[Worktree] Failed to unstage ${file}:`, e),
    );
  }
}

/**
 * Collect file scopes of open PRs and active swarm/* branches (excluding self).
 * Each source is independently guarded — a gh/git hiccup drops that source, not
 * the whole report.
 */
async function collectActiveScopes(worktreePath: string, selfBranch: string): Promise<BranchScope[]> {
  const scopes: BranchScope[] = [];
  const prBranches = new Set<string>();

  // Open PRs (exclude self).
  try {
    const raw = await gh(worktreePath, 'pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--limit', '50');
    const prs: { number: number; headRefName: string }[] = JSON.parse(raw || '[]');
    for (const pr of prs) {
      prBranches.add(pr.headRefName);
      if (pr.headRefName === selfBranch) continue;
      try {
        const files = toLines(await gh(worktreePath, 'pr', 'diff', String(pr.number), '--name-only'));
        if (files.length) scopes.push({ label: `PR #${pr.number} (${pr.headRefName})`, files });
      } catch { /* skip this PR */ }
    }
  } catch { /* gh unavailable — skip PR scopes */ }

  // Active swarm/* branches without their own PR yet (exclude self + PR'd branches).
  try {
    const base = await resolveBaseRef(worktreePath);
    const branches = toLines(await git(worktreePath, 'branch', '-r', '--list', `${base.remote}/swarm/*`))
      .map(b => b.replace(new RegExp(`^${base.remote}/`), ''));
    for (const b of branches) {
      if (b === selfBranch || prBranches.has(b)) continue;
      try {
        const files = toLines(await git(worktreePath, 'diff', '--name-only', `${base.ref}...${base.remote}/${b}`));
        if (files.length) scopes.push({ label: `branch ${base.remote}/${b}`, files });
      } catch { /* skip this branch */ }
    }
  } catch { /* git unavailable — skip branch scopes */ }

  // Recently-merged PRs whose fix this branch's history does NOT contain —
  // if it also touches the same files, this branch likely forked before that
  // fix landed and would silently reintroduce it. Real incident: STONKS PR #218
  // called itself a "follow-up" to #215, but #218 had branched before #215
  // merged and never picked up its fix. (INT-2421)
  try {
    const raw = await gh(worktreePath, 'pr', 'list', '--state', 'merged', '--json', 'number,headRefName,mergeCommit', '--limit', '30');
    const merged: { number: number; headRefName: string; mergeCommit?: { oid: string } }[] = JSON.parse(raw || '[]');
    for (const pr of merged) {
      if (pr.headRefName === selfBranch || !pr.mergeCommit?.oid) continue;
      const alreadyIncluded = await git(worktreePath, 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'HEAD')
        .then(() => true).catch(() => false);
      if (alreadyIncluded) continue;
      try {
        const files = toLines(await gh(worktreePath, 'pr', 'diff', String(pr.number), '--name-only'));
        if (files.length) {
          scopes.push({
            label: `⚠️ MERGED PR #${pr.number} (${pr.headRefName}) — not in this branch's history, verify its fix wasn't dropped`,
            files,
          });
        }
      } catch { /* skip this merged PR */ }
    }
  } catch { /* gh unavailable — skip merged-PR staleness check */ }

  return scopes;
}

// Duplicate-issue-PR guard (INT-2544)
//
// Two parallel workers can each independently implement the same Linear issue on
// their own branch and both open PRs — nothing checked whether one already exists.
// Real incident: STONKS STO-1400 (PR #224 merged + PR #226 left open, CONFLICTING)
// and STO-1454 (PR #221 merged + PR #228 left open, CONFLICTING) sat undetected
// until a human noticed the "File overlap with in-flight work" comment and ran
// `git merge-tree` by hand. Every OpenSwarm PR body literally contains
// `Closes <issueIdentifier>`, so a GitHub body search finds siblings regardless of
// branch name or merge state.

/** Other PRs (any state) whose body already closes this Linear issue, excluding
 *  this branch's own PR. Best-effort — any gh failure returns [] rather than
 *  blocking PR creation. */
async function findDuplicateIssuePRs(
  worktreePath: string,
  issueIdentifier: string,
  selfBranch: string,
): Promise<{ number: number; url: string; headRefName: string }[]> {
  try {
    const raw = await gh(
      worktreePath, 'pr', 'list',
      '--search', `"Closes ${issueIdentifier}" in:body`,
      '--state', 'all',
      '--json', 'number,url,headRefName',
      '--limit', '10',
    );
    const prs: { number: number; url: string; headRefName: string }[] = JSON.parse(raw || '[]');
    return prs.filter((pr) => pr.headRefName !== selfBranch);
  } catch (err) {
    console.warn('[Worktree] Duplicate-issue-PR check skipped:', err);
    return [];
  }
}

/** Render the duplicate-PR warning as a PR-body markdown section ('' if none). */
function formatDuplicateIssueSection(issueIdentifier: string, duplicates: { number: number; url: string; headRefName: string }[]): string {
  if (duplicates.length === 0) return '';
  return [
    '## ⚠️ Possible duplicate work',
    '',
    `${duplicates.length} other PR(s) already reference \`Closes ${issueIdentifier}\` — opened as a draft. Verify this isn't redundant with already-merged work before marking ready and merging:`,
    '',
    ...duplicates.map((d) => `- ${d.url} (${d.headRefName})`),
  ].join('\n');
}

/**
 * Build the PR-body overlap section for this worktree branch. Returns '' when
 * there is no overlap or on any error (advisory — must not block PR creation).
 */
async function buildFileOverlapSection(worktreePath: string, selfBranch: string): Promise<string> {
  try {
    const base = await resolveBaseRef(worktreePath);
    const selfFiles = toLines(await git(worktreePath, 'diff', '--name-only', `${base.ref}...HEAD`));
    if (selfFiles.length === 0) return '';
    const others = await collectActiveScopes(worktreePath, selfBranch);
    return formatOverlapReport(computeFileOverlaps(selfFiles, others));
  } catch (err) {
    console.warn('[Worktree] File-overlap report skipped:', err);
    return '';
  }
}

async function findOpenPullRequestUrl(worktreePath: string, branchName: string): Promise<string> {
  return (await gh(
    worktreePath,
    'pr', 'list', '--head', branchName, '--state', 'open',
    '--json', 'url', '--jq', '.[0].url',
  )).trim();
}


/** Commit changes + push + gh pr create */
export async function commitAndCreatePR(
  info: WorktreeInfo,
  title: string,
  issueIdentifier: string,
  description: string,
  options: { draft?: boolean; committedOnly?: boolean } = {},
): Promise<string> {
  const { worktreePath, branchName } = info;

  // Check for uncommitted changes and commit them.
  //
  // `committedOnly` skips this whole phase, and with it every write into the
  // working tree. A run parked for the operator publishes what it has already
  // committed and leaves the tree exactly as the worker left it, so the resume
  // continues from the same place instead of inheriting a commit it never made.
  // (AGT-4076)
  if (!options.committedOnly) {
    await stripRuntimeMarkerFromGit(worktreePath);
    const status = await git(worktreePath, 'status', '--porcelain');

    if (status.trim()) {
      await git(worktreePath, 'add', '-A');
      await guardUnsafeBinaryStaging(worktreePath); // INT-2430

      const stillStaged = await git(worktreePath, 'diff', '--cached', '--name-only');
      if (stillStaged.trim()) {
        const commitMsg = [
          `feat(${issueIdentifier}): ${title.slice(0, 72)}`,
        ].join('\n');

        // Validate conventional commit format (warning only)
        const commitCheck = runConventionalCommitGuard(commitMsg);
        if (!commitCheck.passed) {
          console.warn(`[Worktree] Commit format warning: ${commitCheck.issues.join('; ')}`);
        }

        await git(worktreePath, 'commit', '-m', commitMsg);
        console.log(`[Worktree] Committed uncommitted changes (${branchName})`);
      } else {
        console.log(`[Worktree] Nothing left to commit after unsafe-binary-staging guard stripped all staged changes (${branchName})`);
      }
    }
  }

  // Check if there are any commits ahead of the base ref (including worker-made
  // commits) — resolved, not hardcoded origin/main (INT-2545).
  const base = await resolveBaseRef(worktreePath);
  const commitsAhead = await git(worktreePath, 'rev-list', '--count', `${base.ref}..HEAD`)
    .then((out) => parseInt(out.trim(), 10))
    .catch(() => 0);

  if (commitsAhead === 0) {
    console.log(`[Worktree] No commits ahead of ${base.ref} (${branchName}) - nothing to PR`);
    throw new Error(`No commits to create PR from - branch has no changes compared to ${base.branch}`);
  }

  console.log(`[Worktree] Branch ${branchName} has ${commitsAhead} commit(s) ahead of ${base.ref}`);

  // Push branch to the resolved remote (always push since we have commits ahead)
  await git(worktreePath, 'push', '-u', base.remote, branchName, '--force-with-lease');
  console.log(`[Worktree] Pushed branch ${branchName}`);

  // If PR already exists, just return the URL
  const existing = await findOpenPullRequestUrl(worktreePath, branchName)
    .catch((e) => { console.warn(`[Worktree] PR list check failed for ${branchName}:`, e); return ''; });

  if (existing) {
    console.log(`[Worktree] PR already exists: ${existing}`);
    // Reusing a PR opened while the run was parked must not leave reviewed work
    // sitting as a draft. Only the reviewed caller promotes; a parked publish
    // (`draft: true`) is meant to stay a draft.
    //
    // But `draft` is not the only reason a PR is one. A PR is also opened draft
    // when another branch already closes this issue (INT-2544), deliberately, so
    // a duplicate implementation cannot masquerade as the sole one. Promoting on
    // the caller's option alone would defeat that, so the duplicate condition is
    // re-checked here. (Caught by the commit gate, not self-caught.)
    if (!options.draft) {
      const stillDuplicated = await findDuplicateIssuePRs(worktreePath, issueIdentifier, branchName);
      await readyReusedPullRequest(worktreePath, existing, issueIdentifier, stillDuplicated.length);
    }
    return existing;
  }

  // Compute file overlap vs other in-flight work (advisory; never blocks). (INT-2392)
  const overlapSection = await buildFileOverlapSection(worktreePath, branchName);

  // Another branch may already close this same Linear issue (INT-2544) — never
  // block on it (the work is done and worth keeping visible), but never let it
  // silently masquerade as the sole implementation either: open as draft.
  const duplicates = await findDuplicateIssuePRs(worktreePath, issueIdentifier, branchName);
  const duplicateSection = formatDuplicateIssueSection(issueIdentifier, duplicates);
  if (duplicates.length > 0) {
    console.warn(
      `[Worktree] ${duplicates.length} other PR(s) already close ${issueIdentifier} — opening as draft: ` +
      duplicates.map((d) => d.url).join(', '),
    );
  }

  // Create PR
  const prBody = [
    '## Summary',
    description || `${issueIdentifier}: ${title}`,
    ...(overlapSection ? ['', overlapSection] : []),
    ...(duplicateSection ? ['', duplicateSection] : []),
    '',
    '## Linear',
    `Closes ${issueIdentifier}`,
    '',
    '---',
    '🤖 Generated with [OpenSwarm](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  const createArgs = ['pr', 'create', '--head', branchName, '--base', base.branch, '--title', title, '--body', prBody];
  // Draft when the work never earned a review: a duplicate implementation must
  // not masquerade as the sole one, and work published because a run parked
  // (AGT-4076) never reached a reviewer at all.
  if (options.draft || duplicates.length > 0) createArgs.push('--draft');
  let url: string;
  try {
    url = (await gh(worktreePath, ...createArgs)).trim();
    console.log(`[Worktree] PR created: ${url}`);
  } catch (createError) {
    // Two daemon generations (or a manual operator and the daemon) can both
    // observe "no PR" before either creates it. GitHub accepts one create and
    // rejects the loser. Re-read artifact truth before treating that loser as a
    // publication failure; this also covers a client disconnect after GitHub
    // accepted the request but before `gh` returned the URL.
    const racedUrl = await findOpenPullRequestUrl(worktreePath, branchName).catch(() => '');
    if (!racedUrl) throw createError;
    url = racedUrl;
    console.warn(`[Worktree] PR create raced with another publisher; using existing PR: ${url}`);
    // The winner may have opened it as a draft (a parked run does). Losing the
    // race must not turn a reviewed publication into a hidden draft. Reuses the
    // duplicate set already computed above rather than re-querying.
    if (!options.draft) await readyReusedPullRequest(worktreePath, url, issueIdentifier, duplicates.length);
  }

  // Register PR ownership for conflict auto-resolution
  const prNumberMatch = url.match(/\/pull\/(\d+)/);
  if (prNumberMatch) {
    const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
    const repo = repoMatch ? repoMatch[1] : '';
    if (repo) {
      await registerOwnedPR({
        repo,
        prNumber: parseInt(prNumberMatch[1], 10),
        branch: branchName,
        createdAt: new Date().toISOString(),
        issueIdentifier: issueIdentifier,
      }).catch((err) => console.warn(`[Worktree] Failed to register PR ownership:`, err));
    }
  }

  return url;
}

// Audit-fix PR (INT-2905)
//
// `review --max --fix` runs in its own worktree so the audit's edits never land
// on the branch a worker/human is currently on. Its branch closes an audit issue
// rather than implementing one, so it needs its own commit message and PR body —
// hence a separate entry point from commitAndCreatePR above.

export interface AuditPRRequest {
  /** PR title. */
  title: string;
  /** Full PR body markdown (built by the caller). */
  body: string;
  /** Commit message for the accumulated fixes. */
  commitMessage: string;
  /** Branch the worktree forked from — the PR base when it exists on the remote. */
  forkedFromBranch: string;
  /** Commit the worktree forked from — commits after it are the audit's own. */
  baseSha: string;
}

/**
 * Commit the worktree's accumulated fixes, push the branch, and open a PR.
 * Returns the PR url, or null when the audit changed nothing (no commits past
 * `baseSha`) — the caller then discards the worktree.
 */
export async function commitAndCreateAuditPR(info: WorktreeInfo, req: AuditPRRequest): Promise<string | null> {
  const { worktreePath, branchName } = info;

  const dirty = await git(worktreePath, 'status', '--porcelain');
  if (dirty.trim()) {
    await git(worktreePath, 'add', '-A');
    await guardUnsafeBinaryStaging(worktreePath); // INT-2430
    const staged = await git(worktreePath, 'diff', '--cached', '--name-only');
    if (staged.trim()) {
      // Identity + --no-verify: an unattended audit must not die on an unset
      // user.name or a repo pre-commit hook.
      await git(
        worktreePath,
        '-c', 'user.email=swarm@openswarm.local', '-c', 'user.name=OpenSwarm',
        'commit', '--no-verify', '-m', req.commitMessage,
      );
    }
  }

  // Count against the fork point, not the remote default branch: the worktree
  // branched off the user's HEAD, which may itself be ahead of the default.
  const ahead = await git(worktreePath, 'rev-list', '--count', `${req.baseSha}..HEAD`)
    .then((out) => parseInt(out.trim(), 10))
    .catch(() => 0);
  if (!ahead) return null;

  const base = await resolveBaseRef(worktreePath);
  // PR into the branch we forked from when the remote has it; otherwise the diff
  // would also contain that branch's own unmerged commits.
  const onRemote = await git(worktreePath, 'ls-remote', '--exit-code', '--heads', base.remote, req.forkedFromBranch)
    .then(() => true)
    .catch(() => false);
  const baseBranch = onRemote ? req.forkedFromBranch : base.branch;
  if (!onRemote && req.forkedFromBranch !== base.branch) {
    console.warn(`[Worktree] ${req.forkedFromBranch} is not on ${base.remote} — opening the audit PR against ${base.branch} instead.`);
  }

  // The audit forked from a LOCAL head, which may sit ahead of the PR base —
  // those commits ride along in the PR diff. Say so rather than let a reviewer
  // discover unrelated commits in an "audit fixes" PR.
  const carried = await git(worktreePath, 'rev-list', '--count', `${base.remote}/${baseBranch}..${req.baseSha}`)
    .then((out) => parseInt(out.trim(), 10))
    .catch(() => 0);
  if (carried > 0) {
    console.warn(
      `[Worktree] The audit forked from a HEAD ${carried} commit(s) ahead of ${base.remote}/${baseBranch} — ` +
        'the PR carries those commits too.',
    );
  }

  await git(worktreePath, 'push', '-u', base.remote, branchName, '--force-with-lease');

  const existing = await gh(worktreePath, 'pr', 'list', '--head', branchName, '--state', 'open', '--json', 'url', '--jq', '.[0].url')
    .catch(() => '');
  if (existing.trim()) return existing.trim();

  const url = (await gh(
    worktreePath, 'pr', 'create',
    '--head', branchName, '--base', baseBranch,
    '--title', req.title, '--body', req.body,
  )).trim();
  console.log(`[Worktree] Audit PR created: ${url}`);
  return url;
}

/** Clean up worktree */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  const worktreePath = assertManagedWorktreePath(info.originalPath, info.worktreePath);
  try {
    await git(info.originalPath, 'worktree', 'remove', '--force', worktreePath);
    console.log(`[Worktree] Removed: ${worktreePath}`);
  } catch {
    // fallback: direct removal
    rmSync(worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Force removed: ${worktreePath}`);
  }
  await clearActiveWorktreeMarker(info);
}

/** Clean up dangling worktrees.
 *
 * `git worktree prune` only drops metadata for worktrees whose directory is already gone. A
 * daemon that was hard-killed or crashed mid-run never ran the `finally` cleanup, so its
 * `{repo}/worktree/<issueId>` directories survive as orphans (INT-1810 R4). A
 * restart does not prove they are disposable: they may contain work written
 * immediately before the crash.
 *
 * `activeWorktreePaths` are the worktrees of currently-running tasks — never swept. Pass an
 * `provenOrphanPaths` must come from durable reconciliation (expired fenced
 * lease + no live owner/artifact requiring recovery). Unknown trees are kept. */
export async function pruneWorktrees(
  repoPath: string,
  activeWorktreePaths: Set<string> = new Set(),
  provenOrphanPaths: Set<string> = new Set(),
): Promise<void> {
  await git(repoPath, 'worktree', 'prune').catch((e) => console.warn(`[Worktree] Prune failed for ${repoPath}:`, e));
  try {
    const out = await git(repoPath, 'worktree', 'list', '--porcelain');
    const prefix = `${repoPath}/worktree/`;
    const candidates = out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => p.startsWith(prefix))
      .filter((p) => !activeWorktreePaths.has(p)); // keep worktrees of running tasks
    for (const p of candidates) {
      try {
        await withWorktreeLifecycleLock(repoPath, basename(p), async () => {
          // Revalidate ownership only after acquiring the same lock used by
          // create/resume. This closes the last check-to-delete window: a new
          // owner either writes its marker first (and is retained), or waits
          // until this proven-orphan cleanup has finished.
          const active = await readActiveWorktreeMarkers(repoPath, p);
          const liveMarker = active.markers.find(markerLooksLive);
          if (liveMarker) {
            console.log(`[Worktree] Retaining live owner ${liveMarker.ownerPid}: ${p}`);
            return;
          }
          if (active.unreadable) {
            console.warn(`[Worktree] Active marker unreadable/racing — retaining for reconciliation: ${p}`);
            return;
          }
          const marker = active.markers[0] ?? null;

          // Preserved failed-session worktrees carry the retry's partial work — they
          // survive restarts and sweeps (INT-2503) until they age out (abandoned:
          // task went STUCK or the issue was closed). Expired ones get their work
          // committed to the branch, then removed (INT-2506).
          if (existsSync(join(p, PRESERVE_MARKER))) {
            const age = preserveMarkerAgeMs(p);
            if (age === null) {
              console.warn(`[Worktree] Preserve marker unreadable — retaining for reconciliation: ${p}`);
              return;
            }
            if (age <= PRESERVE_MAX_AGE_MS) return; // still fresh — keep
            console.log(`[Worktree] Preserved worktree expired (${Math.round(age / 3_600_000)}h) — sweeping: ${p}`);
            await removePreservedWorktreeAtUnlocked(p)
              .catch((e) => console.warn(`[Worktree] Expired-preserve sweep failed for ${p}:`, e));
            return;
          }

          if (!provenOrphanPaths.has(p)) {
            console.log(`[Worktree] Retaining unproven ${marker ? 'crash-recovery' : 'legacy'} worktree: ${p}`);
            return;
          }

          const branchName = marker?.branchName
            ?? await git(p, 'rev-parse', '--abbrev-ref', 'HEAD').then((value) => value.trim()).catch(() => 'unknown');
          const info: WorktreeInfo = {
            worktreePath: p,
            branchName,
            originalPath: repoPath,
            issueId: marker?.issueId ?? basename(p),
          };
          await preserveWorktree(info, 'reconciler proved lease orphan')
            .then((preserved) => console.log(`[Worktree] Reconciled orphan worktree (${preserved ? 'preserved' : 'clean removal'}): ${p}`))
            .catch((e) => console.warn(`[Worktree] Orphan reconciliation failed for ${p}:`, e));
        });
      } catch (error) {
        console.warn(`[Worktree] Lifecycle busy/unavailable — retaining for reconciliation: ${p}`, error);
      }
    }
  } catch (e) {
    console.warn(`[Worktree] Orphan sweep skipped for ${repoPath}:`, e);
  }
  console.log(`[Worktree] Pruned stale worktrees for: ${repoPath}`);
}
