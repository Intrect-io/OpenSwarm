// ============================================
// OpenSwarm - `openswarm exec --issue` (INT-3XXX)
// ============================================
//
// Deploy the worker pipeline for ONE Linear issue asynchronously and hand the
// resulting run to an external orchestrator (Claude Code, omp, codex, a script).
// Four commands, one contract:
//
//   exec --issue INT-123          deploy, print the run id, return immediately
//   exec status  <runId>          one read of the durable run's state
//   exec await   <runId>          block until the run elevates or finishes
//   exec answer  <runId> [...]    answer the parked question, redeploy
//
// `await` is the elevation surface: when the worker stops for input the run
// parks (NEEDS_HUMAN/NEEDS_SPEC/NEEDS_ENV/NEEDS_RECONCILE) and this prints the
// structured JSON an external agent resumes its own reasoning from. `answer`
// writes that agent's reply to the coordination board, resumes the ledger row
// and redeploys.
//
// Deploy and answer both leave an exec hold (`src/automation/execHold.ts`) so
// the daemon's idle_fill cannot re-run the parked task out from under the
// orchestrator that is watching for the elevation. Reads here are read-only;
// only `answer` writes, and only the ledger/board writes it needs.
//
// Exit codes: deploy 0 deployed / 1 deploy failed / 2 refused before deploying.
// status 0 read / 2 no durable run. await 0 terminal / 1 elevated / 2 still
// pending (timeout). answer 0 resumed+redeployed / 1 refused / 2 nothing to
// answer.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { expandPath, loadConfig } from '../core/config.js';
import type { LinearIssueInfo, SwarmConfig } from '../core/types.js';
import { setAutomationDbPath, defaultAutomationDbPath } from '../automation/automationDbPath.js';
import { markExecHold } from '../automation/execHold.js';
import { OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
import { resolveQuestionClass, type HumanQuestionClass } from '../coordination/humanQuestions.js';
import { loadRepoMetadata, type RepoMetadata } from '../support/repoMetadata.js';
import { RunLedger } from '../automation/runLedger.js';
import { daemonAuthHeaders, daemonBaseUrl } from './daemonEndpoint.js';
import { WORK_SKIP_STATES } from './workSelect.js';

const DAEMON_PORT = 3847;
const HEALTH_TIMEOUT_MS = 3000;
const SUBMIT_TIMEOUT_MS = 30_000;
const DEFAULT_AWAIT_TIMEOUT_S = 3600;
const AWAIT_POLL_INTERVAL_MS = 5000;

/** States that mean the worker stopped for a decision the orchestrator owns. */
export const AWAIT_ELEVATION_STATES = ['NEEDS_HUMAN', 'NEEDS_SPEC', 'NEEDS_ENV', 'NEEDS_RECONCILE'] as const;
/** States that mean the run is over — nothing left to escalate. */
export const AWAIT_TERMINAL_STATES = ['DONE', 'CANCELLED', 'DECOMPOSED'] as const;

/**
 * States in which `exec answer` may force a resume with NO correlation given.
 *
 * Deliberately narrower than `AWAIT_ELEVATION_STATES`. `NEEDS_RECONCILE` is an
 * elevation — the orchestrator should see it — but it is NOT an input park:
 * the run stopped because an artifact needs reconciling, and `markReady` would
 * admit it back into the pool with that reconciliation skipped, which is a
 * correctness hole rather than a convenience. Reconciling it is the scheduler's
 * job; an orchestrator with an answer for a specific question passes
 * `--correlation`, and that path is allowed regardless of state.
 */
export const ANSWERABLE_STATES = ['NEEDS_HUMAN', 'RETRY_AT', 'NEEDS_SPEC', 'NEEDS_ENV'] as const;

export type AwaitVerdict = 'elevation' | 'terminal' | 'pending';

/**
 * What an `exec await` should do next with this run state.
 *
 * 'pending' covers everything still moving (READY through PUBLISHING) — those
 * are states the orchestrator must keep waiting through, not act on. An
 * unrecognised state is also 'pending': a state this build does not know about
 * is not evidence that the run stopped.
 */
export function classifyRunForAwait(state: string): AwaitVerdict {
  if ((AWAIT_ELEVATION_STATES as readonly string[]).includes(state)) return 'elevation';
  if ((AWAIT_TERMINAL_STATES as readonly string[]).includes(state)) return 'terminal';
  return 'pending';
}

export interface PendingExecQuestion {
  correlationId: string;
  question: string;
  questionClass: HumanQuestionClass;
}

/** The run's durable state, as `exec status`/`await` report it. */
export interface ExecRunRow {
  issueId: string;
  identifier?: string;
  title?: string;
  state: string;
  attemptNo: number;
  branchName?: string;
  worktreePath?: string;
  prUrl?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  retryAt?: number;
  updatedAt: number;
}

/** The elevation document an external orchestrator resumes its reasoning from. */
export interface ExecElevation {
  runId: string;
  identifier?: string;
  title?: string;
  state: string;
  elevation: boolean;
  verdict: AwaitVerdict;
  reason?: string;
  message?: string;
  attemptNo: number;
  branch?: string;
  worktree?: string;
  prUrl?: string;
  pendingQuestions: PendingExecQuestion[];
  hint: string;
}

export type DeployTransport = 'daemon' | 'child';

// ---- Read-only access --------------------------------------------------------

/**
 * Open the automation database read-only, or nothing.
 *
 * Deliberately NOT `new RunLedger()`: that constructor creates the directory,
 * opens read-write, sets WAL and runs a schema migration in an IMMEDIATE
 * transaction (runLedger.ts:95-113). A `status` query must not create a
 * database, migrate a schema, or take a write lock on a live daemon's file —
 * so this mirrors `ledgerOverviewTool` (ledgerOverviewTool.ts:58) and fails if
 * the file does not exist.
 */
function openReadOnly(dbPath: string): Database.Database | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    // Busy beyond the default timeout, unreadable, not a database: all mean
    // "no answer available from here", not "crash the CLI".
    return undefined;
  }
}

/**
 * The `automation_runs` columns this command reads, snake-cased as SQLite
 * returns them. A declared interface rather than an inline cast, so the one
 * unchecked read at the database boundary is named and reviewable — the same
 * shape `runLedgerRows.ts`'s `RunRow` uses for the write-bound ledger.
 */
interface ExecRunRowDb {
  issue_id: string;
  identifier: string | null;
  title: string | null;
  state: string;
  attempt_no: number;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  retry_at: number | null;
  updated_at: number;
}

/** The run row, or undefined when no durable run is recorded under that id. */
export function readExecRunRow(dbPath: string, issueId: string): ExecRunRow | undefined {
  const db = openReadOnly(dbPath);
  if (!db) return undefined;
  try {
    const row = db.prepare(`
      SELECT issue_id, identifier, title, state, attempt_no, branch_name, worktree_path,
             pr_url, last_error_code, last_error_message, retry_at, updated_at
      FROM automation_runs WHERE issue_id = ?
    `).get(issueId) as ExecRunRowDb | undefined;
    if (!row) return undefined;
    return {
      issueId: row.issue_id,
      identifier: row.identifier ?? undefined,
      title: row.title ?? undefined,
      state: row.state,
      attemptNo: row.attempt_no,
      branchName: row.branch_name ?? undefined,
      worktreePath: row.worktree_path ?? undefined,
      prUrl: row.pr_url ?? undefined,
      lastErrorCode: row.last_error_code ?? undefined,
      lastErrorMessage: row.last_error_message ?? undefined,
      retryAt: row.retry_at ?? undefined,
      updatedAt: row.updated_at,
    };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * The questions this run is stopped on, read straight from the durable trace.
 *
 * Not `findQuestion`/`getCoordinationStore`: that answers "is this correlation
 * open" from a board merged with the trace, while what an orchestrator needs is
 * "which questions on this task have no completed answer yet". The trace is the
 * same file as the ledger, so one read-only handle answers both. A database
 * without the trace table (a run that never published an event) reads as no
 * questions rather than an error.
 */
export function readPendingExecQuestions(dbPath: string, issueId: string): PendingExecQuestion[] {
  const db = openReadOnly(dbPath);
  if (!db) return [];
  try {
    const present = db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'coordination_trace'
    `).get() as { present: number } | undefined;
    if (!present) return [];
    const rows = db.prepare(`
      SELECT correlation_id, summary, metadata_json
      FROM coordination_trace
      WHERE task_id = ? AND kind = 'human-question' AND status IN ('waiting', 'running')
        AND correlation_id NOT IN (
          SELECT correlation_id FROM coordination_trace
          WHERE task_id = ? AND kind = 'human-answer' AND status = 'completed'
        )
      ORDER BY id
    `).all(issueId, issueId) as Array<{ correlation_id: string; summary: string; metadata_json: string | null }>;
    return rows.map((row) => ({
      correlationId: row.correlation_id,
      question: row.summary,
      // Fail closed, exactly as the answer-side gate does: a question with no
      // class (every ask minted before classes existed) is an approval.
      questionClass: resolveQuestionClass(parseMetadata(row.metadata_json)?.questionClass),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function parseMetadata(value: string | null): { questionClass?: unknown } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as { questionClass?: unknown } : undefined;
  } catch {
    return undefined;
  }
}

/** Assemble the elevation document from the two reads. */
export function buildExecElevation(runId: string, row: ExecRunRow, questions: PendingExecQuestion[]): ExecElevation {
  const verdict = classifyRunForAwait(row.state);
  const hint = questions.length > 0
    ? `openswarm exec answer ${runId} --correlation ${questions[0].correlationId} --text "..."`
    : `openswarm exec answer ${runId} --text "..."`;
  return {
    runId,
    identifier: row.identifier,
    title: row.title,
    state: row.state,
    elevation: verdict === 'elevation',
    verdict,
    reason: row.lastErrorCode,
    message: row.lastErrorMessage,
    attemptNo: row.attemptNo,
    branch: row.branchName,
    worktree: row.worktreePath,
    prUrl: row.prUrl,
    pendingQuestions: questions,
    hint,
  };
}

// ---- Shared plumbing ---------------------------------------------------------

interface ResolvedContext {
  config: SwarmConfig;
  dbPath: string;
}

/**
 * The real stdout writer, bound at module load.
 *
 * `--json` mode reroutes `console.log` to stderr for the whole lifecycle
 * (below), and every writer here is resolved lazily at call time — so a writer
 * that says `console.log` would follow the reroute and put the JSON document on
 * stderr, where `| jq` cannot see it. Binding the function object now, before
 * any redirect is installed, keeps the one document on the one stream.
 */
const stdoutLog = console.log.bind(console) as (line: string) => void;

/**
 * `--json` mode: stdout carries exactly one document, and `loadConfig()` logs
 * its config path (and any config warnings) to stdout on the way in. Same
 * contract and same reason as `workCommand`'s own redirect (workCommand.ts:261).
 */
function redirectConsoleLogToStderr(): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  return () => {
    console.log = original;
  };
}

export interface ExecCommandDeps {
  loadConfig?: () => SwarmConfig;
  setAutomationDbPath?: (path: string | undefined) => void;
  isGitRepo?: (path: string) => boolean;
  loadRepoMetadata?: (path: string) => Promise<RepoMetadata | null>;
  getIssue?: (idOrIdentifier: string) => Promise<LinearIssueInfo | null>;
  ensureTaskSource?: () => Promise<unknown>;
  markHold?: (issueId: string, actor: string) => void;
  clearHold?: (issueId: string) => void;
  daemonHealthy?: () => Promise<boolean>;
  /** Precise probe: distinguishes a reachable-but-refusing daemon from an absent one. */
  daemonProbe?: () => Promise<DaemonProbeResult>;
  postWork?: (repoPath: string, identifier: string) => Promise<{ status: number; body: unknown }>;
  spawnWorkChild?: (repoPath: string, identifier: string) => { ok: boolean; reason?: string };
  openLedger?: (dbPath: string) => AnswerLedger;
  answerQuestion?: (correlationId: string, text: string, actor: string) => Promise<{ accepted: boolean; reason?: string }>;
  /** The task a pending question belongs to — the correlation→run binding check. */
  findQuestionTask?: (correlationId: string) => string | undefined | Promise<string | undefined>;
  actor?: string;
  log?: (line: string) => void;
  out?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ledger surface `exec answer` drives — injectable for tests. */
export interface AnswerLedger {
  resumeNeedsHumanForQuestions(issueId: string): string | null;
  readmitParkedRun(issueId: string, parkCode: string): boolean;
  markReady(issueId: string): boolean;
  close(): void;
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function execActor(deps: ExecCommandDeps): string {
  return deps.actor ?? process.env.OPENSWARM_EXEC_ACTOR ?? 'external:cli';
}

/**
 * Resolve a question's owning task id from the coordination board. Kept as a
 * lazy dynamic import — the board module pulls the automation database and the
 * trace store, and `exec status`/`await` must not pay for that just to read a
 * run row.
 */
async function defaultFindQuestionTask(correlationId: string): Promise<string | undefined> {
  const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
  return getCoordinationStore().findQuestion(correlationId)?.taskId;
}

async function resolveContext(deps: ExecCommandDeps): Promise<ResolvedContext | undefined> {
  let config: SwarmConfig;
  try {
    config = (deps.loadConfig ?? loadConfig)();
  } catch (err) {
    console.error(`Could not load config: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  // The ledger and the coordination trace must be the same file, and the exec
  // hold has to live beside the run it protects — otherwise this process reads
  // and writes a different database than the daemon it is deploying to.
  (deps.setAutomationDbPath ?? setAutomationDbPath)(config.autonomous?.automationDbPath);
  return { config, dbPath: defaultAutomationDbPath() };
}

/**
 * `INT-123` or a raw Linear UUID -> the issue record.
 *
 * Resolution is Linear's `getIssue`, which accepts both spellings. A caller
 * that passes a UUID needs no Linear lookup, but the identifier spelling is
 * what a person and an orchestrator both have; going through the tracker keeps
 * one path instead of two.
 */
async function resolveIssueRecord(
  deps: ExecCommandDeps,
  idOrIdentifier: string,
): Promise<LinearIssueInfo | null> {
  await (deps.ensureTaskSource ?? (async () => (await import('./reviewCommand.js')).ensureTaskSource()))();
  const getIssue = deps.getIssue ?? (async (id: string) => (await import('../linear/linear.js')).getIssue(id));
  return getIssue(idOrIdentifier);
}

// ---- Deploy -----------------------------------------------------------------

interface DeployOutcome {
  transport: DeployTransport;
  ok: boolean;
  detail?: string;
  /** The command's exit code when this outcome fails: 2 refused-before-deploying, 1 failed. */
  exitCode: number;
}

/**
 * Put the issue on the daemon, or start a detached worker for it.
 *
 * A daemon that answers but refuses is never retried as a local child: a 403
 * here is the daemon's `allowedProjects` boundary (workRunner.ts:151-158), and
 * falling back would be this CLI quietly going around the deployment's own
 * allow-list. Only an unreachable daemon falls back — a reachable daemon that
 * answers 401/403/503 on its own health probe is refusal, not absence.
 */
async function deployResolvedIssue(
  deps: ExecCommandDeps,
  repoPath: string,
  identifier: string,
): Promise<DeployOutcome> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const probe = await resolveDaemonProbe(deps);
  if (probe.kind === 'refused') {
    return {
      transport: 'daemon',
      ok: false,
      exitCode: 2,
      detail: `the daemon is up but refused its own health probe (/api/stats HTTP ${probe.status ?? '?'}) — not retried as a local child, since that would go around the refusal; add ${repoPath} to autonomous.allowedProjects or check the daemon auth token`,
    };
  }
  if (probe.kind === 'up') {
    const post = deps.postWork ?? postWorkToDaemon;
    let response: { status: number; body: unknown };
    try {
      response = await post(repoPath, identifier);
    } catch (err) {
      return { transport: 'daemon', ok: false, exitCode: 1, detail: `daemon request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (response.status !== 202) {
      return { transport: 'daemon', ok: false, exitCode: 1, detail: `daemon refused the dispatch (HTTP ${response.status}): ${describeBody(response.body)}` };
    }
    const result = response.body as { items?: Array<{ reason?: string }>; queued?: number } | undefined;
    if ((result?.queued ?? 0) === 0) {
      // 202, but nothing was queued: the daemon accepted the request and
      // declined the issue (already running, not deployable, filtered). That is
      // a refusal before deploying, not a deploy that failed.
      return { transport: 'daemon', ok: false, exitCode: 2, detail: result?.items?.[0]?.reason ?? 'the daemon queued nothing' };
    }
    return { transport: 'daemon', ok: true, exitCode: 0 };
  }

  log('Daemon unreachable — deploying via a detached worker instead.');
  const spawnChild = deps.spawnWorkChild ?? spawnWorkChildProcess;
  const spawned = spawnChild(repoPath, identifier);
  return spawned.ok
    ? { transport: 'child', ok: true, exitCode: 0 }
    : { transport: 'child', ok: false, exitCode: 1, detail: spawned.reason };
}

/** Whether a daemon is there, and whether it will take our work. */
interface DaemonProbeResult {
  kind: 'up' | 'refused' | 'down';
  status?: number;
}

async function resolveDaemonProbe(deps: ExecCommandDeps): Promise<DaemonProbeResult> {
  if (deps.daemonProbe) return deps.daemonProbe();
  // `daemonHealthy` is the older boolean knob: true means the probe saw a 2xx.
  if (deps.daemonHealthy) return { kind: (await deps.daemonHealthy()) ? 'up' : 'down' };
  return daemonProbe();
}

function describeBody(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) return String((body as { error: unknown }).error);
  return JSON.stringify(body ?? null);
}

/**
 * Probe `/api/stats`, keeping "unreachable" distinct from "refused".
 *
 * `res.ok` alone would fold 401/403/503 into "unreachable" and send the caller
 * into the local-child fallback — which is exactly the daemon's allow-list being
 * routed around. Only a fetch/connect failure or timeout is `down`.
 */
async function daemonProbe(): Promise<DaemonProbeResult> {
  // Resolved before the try: a malformed host, or a token this build refuses to
  // send in plaintext to a remote host, is a configuration error — answering
  // "unhealthy" would send the caller into the local-child fallback instead.
  const url = `${daemonBaseUrl(DAEMON_PORT)}/api/stats`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: daemonAuthHeaders(), signal: controller.signal });
    return res.ok ? { kind: 'up' } : { kind: 'refused', status: res.status };
  } catch {
    return { kind: 'down' };
  } finally {
    clearTimeout(timer);
  }
}

async function postWorkToDaemon(repoPath: string, identifier: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${daemonBaseUrl(DAEMON_PORT)}/api/work`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...daemonAuthHeaders() },
    body: JSON.stringify({ issueIds: [identifier], projectPath: repoPath }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function spawnWorkChildProcess(repoPath: string, identifier: string): { ok: boolean; reason?: string } {
  const entry = resolve(projectRoot(), 'dist', 'cli.js');
  if (!existsSync(entry)) {
    return { ok: false, reason: `dist/cli.js not found at ${projectRoot()} — run \`npm run build\` first` };
  }
  const child = spawn(process.execPath, [entry, 'work', identifier, '--yes', '--path', repoPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true };
}

// ---- `exec --issue` ----------------------------------------------------------

export interface ExecDeployOptions {
  issue: string;
  path?: string;
  json?: boolean;
}

export async function runExecDeployCommand(
  opts: ExecDeployOptions,
  deps: ExecCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const out = deps.out ?? stdoutLog;
  const restoreConsole = opts.json ? redirectConsoleLogToStderr() : null;
  try {
    const repoPath = resolve(expandPath(opts.path ?? process.cwd(), true));
    if (!(deps.isGitRepo ?? ((p: string) => existsSync(join(p, '.git'))))(repoPath)) {
      log(`Not a git repository (worktree fan-out requires one): ${repoPath}`);
      return 2;
    }

    const context = await resolveContext(deps);
    if (!context) return 2;

    const issue = await resolveIssueRecord(deps, opts.issue);
    if (!issue) {
      log(`Issue not found: ${opts.issue} (is Linear configured? see \`openswarm auth login --provider linear\`)`);
      return 2;
    }

    const meta = await (deps.loadRepoMetadata ?? loadRepoMetadata)(repoPath).catch(() => null);
    const projectId = meta?.linear?.projectId;
    if (!projectId) {
      log(`This repo has no Linear project mapping (openswarm.json) — run \`openswarm add ${repoPath}\` once to map it.`);
      return 2;
    }
    if (issue.project?.id !== projectId) {
      log(`${issue.identifier} belongs to a different Linear project than this repo's mapping — refusing to run it here.`);
      return 2;
    }
    if ((WORK_SKIP_STATES as readonly string[]).includes(issue.state)) {
      log(`${issue.identifier} is ${issue.state} — nothing to deploy.`);
      return 2;
    }

    // The hold goes in BEFORE the run exists. Reversed, a heartbeat that lands
    // between the deploy and the park could idle-fill a run this orchestrator is
    // supposed to own, which is the whole failure this hold exists to stop. A
    // hold that cannot be written aborts the deploy rather than shipping a run
    // nobody is protecting.
    const actor = execActor(deps);
    try {
      (deps.markHold ?? ((issueId: string, who: string) => markExecHold(issueId, who)))(issue.id, actor);
    } catch (err) {
      log(`Could not record the exec hold: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const deploy = await deployResolvedIssue(deps, repoPath, issue.identifier);
    if (!deploy.ok) {
      log(`Deploy failed (${deploy.transport}): ${deploy.detail ?? 'unknown reason'}`);
      if (opts.json) out(JSON.stringify({ runId: issue.id, identifier: issue.identifier, transport: deploy.transport, deployed: false, error: deploy.detail }));
      return deploy.exitCode;
    }

    if (opts.json) {
      out(JSON.stringify({ runId: issue.id, identifier: issue.identifier, transport: deploy.transport, deployed: true }));
    } else {
      out(`Deployed ${issue.identifier} as async exec run ${issue.id} (transport: ${deploy.transport}).`);
      out(`Next: openswarm exec await ${issue.id}`);
    }
    return 0;
  } finally {
    restoreConsole?.();
  }
}

// ---- `exec status` ----------------------------------------------------------

export interface ExecStatusOptions {
  path?: string;
  json?: boolean;
}

export async function runExecStatusCommand(
  runId: string,
  opts: ExecStatusOptions = {},
  deps: ExecCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? stdoutLog;
  const restoreConsole = opts.json ? redirectConsoleLogToStderr() : null;
  try {
    const context = await resolveContext(deps);
    if (!context) return 2;
    const issueId = await resolveRunId(deps, runId);
    const row = readExecRunRow(context.dbPath, issueId);
    if (!row) {
      const unknown = { runId: issueId, state: 'UNKNOWN', hint: 'no durable run recorded for this issue — deploy it with `openswarm exec --issue`' };
      if (opts.json) out(JSON.stringify(unknown));
      else out(`${issueId}: no durable run recorded (has it ever been dispatched?)`);
      return 2;
    }
    const elevation = buildExecElevation(issueId, row, readPendingExecQuestions(context.dbPath, issueId));
    if (opts.json) {
      out(JSON.stringify(elevation));
    } else {
      out(`${elevation.identifier ?? issueId}: ${elevation.state} (attempt ${elevation.attemptNo})`);
      if (elevation.reason) out(`  reason: ${elevation.reason} — ${elevation.message ?? ''}`);
      if (elevation.prUrl) out(`  pr: ${elevation.prUrl}`);
      for (const question of elevation.pendingQuestions) {
        out(`  question [${question.questionClass}] ${question.correlationId}: ${question.question}`);
      }
      out(`  next: ${elevation.hint}`);
    }
    return 0;
  } finally {
    restoreConsole?.();
  }
}

/**
 * `runId` is documented as the Linear UUID, but every caller has the identifier
 * (`INT-123`). Resolve through the tracker when it is spelled that way; a UUID
 * is used as-is so status/await still work with Linear unconfigured.
 */
async function resolveRunId(deps: ExecCommandDeps, runId: string): Promise<string> {
  if (!/^[A-Z]+-\d+$/.test(runId)) return runId;
  const issue = await resolveIssueRecord(deps, runId).catch(() => null);
  return issue?.id ?? runId;
}

// ---- `exec await` -----------------------------------------------------------

export interface ExecAwaitOptions {
  path?: string;
  timeout?: number;
  json?: boolean;
}

export async function runExecAwaitCommand(
  runId: string,
  opts: ExecAwaitOptions = {},
  deps: ExecCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? stdoutLog;
  const log = deps.log ?? ((line: string) => console.error(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const restoreConsole = opts.json ? redirectConsoleLogToStderr() : null;
  try {
    const context = await resolveContext(deps);
    if (!context) return 2;
    const issueId = await resolveRunId(deps, runId);
    const timeoutMs = (opts.timeout ?? DEFAULT_AWAIT_TIMEOUT_S) * 1000;
    const deadline = now() + timeoutMs;

    for (;;) {
      const row = readExecRunRow(context.dbPath, issueId);
      if (!row) {
        // A deploy is asynchronous: the child resolves config, Linear, and its
        // project mapping before it registers the ledger row, so the first read
        // after a successful `exec --issue` can legitimately miss. Polling
        // through that gap is the whole point of `await`; returning immediately
        // would make `exec --issue && exec await` unable to wait. No database is
        // created by this read (`readExecRunRow` opens { readonly: true }).
        if (now() < deadline) {
          log(`[exec] ${runId}: no durable run recorded yet — waiting…`);
          await sleep(AWAIT_POLL_INTERVAL_MS);
          continue;
        }
        const unknown = { runId: issueId, state: 'UNKNOWN', verdict: 'pending' as const, elevation: false, attemptNo: 0, pendingQuestions: [], hint: 'no durable run recorded for this issue — deploy it with `openswarm exec --issue`' };
        if (opts.json) out(JSON.stringify(unknown));
        else out(`${issueId}: no durable run recorded`);
        return 2;
      }
      const elevation = buildExecElevation(issueId, row, readPendingExecQuestions(context.dbPath, issueId));
      if (elevation.verdict !== 'pending') {
        if (opts.json) out(JSON.stringify(elevation));
        else printElevation(elevation, out);
        return elevation.verdict === 'terminal' ? 0 : 1;
      }
      if (now() >= deadline) {
        // Not a failure of the run — the pipeline simply outlasted this call.
        // The run keeps going; an orchestrator re-invokes `await`.
        const timedOut = {
          ...elevation,
          state: row.state,
          hint: `still ${row.state} after ${Math.round(timeoutMs / 1000)}s — re-run \`openswarm exec await ${issueId}\` to keep waiting`,
        };
        if (opts.json) out(JSON.stringify(timedOut));
        else out(`${elevation.identifier ?? issueId}: still ${row.state}; ${timedOut.hint}`);
        return 2;
      }
      log(`[exec] ${elevation.identifier ?? issueId} ${row.state} (attempt ${row.attemptNo}) — waiting…`);
      await sleep(AWAIT_POLL_INTERVAL_MS);
    }
  } finally {
    restoreConsole?.();
  }
}

function printElevation(elevation: ExecElevation, out: (line: string) => void): void {
  const label = elevation.identifier ?? elevation.runId;
  if (elevation.verdict === 'terminal') {
    out(`${label}: ${elevation.state} — the run has finished.`);
    if (elevation.prUrl) out(`  pr: ${elevation.prUrl}`);
    return;
  }
  out(`${label}: ${elevation.state} — needs the orchestrator.`);
  if (elevation.reason) out(`  reason: ${elevation.reason} — ${elevation.message ?? ''}`);
  if (elevation.branch) out(`  branch: ${elevation.branch}${elevation.worktree ? ` (worktree ${elevation.worktree})` : ''}`);
  for (const question of elevation.pendingQuestions) {
    out(`  question [${question.questionClass}] ${question.correlationId}: ${question.question}`);
  }
  out(`  next: ${elevation.hint}`);
}

// ---- `exec answer` ----------------------------------------------------------

export interface ExecAnswerOptions {
  path?: string;
  correlation?: string;
  text?: string;
  json?: boolean;
}

export async function runExecAnswerCommand(
  runId: string,
  opts: ExecAnswerOptions = {},
  deps: ExecCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const out = deps.out ?? stdoutLog;
  const restoreConsole = opts.json ? redirectConsoleLogToStderr() : null;
  try {
    const context = await resolveContext(deps);
    if (!context) return 2;
    const issueId = await resolveRunId(deps, runId);
    const row = readExecRunRow(context.dbPath, issueId);
    if (!row) {
      log(`No durable run recorded for ${issueId} — nothing to answer.`);
      return 2;
    }

    const actor = execActor(deps);
    const answerable = (ANSWERABLE_STATES as readonly string[]).includes(row.state);
    if (!answerable && !opts.correlation) {
      const message = `${row.identifier ?? issueId} is ${row.state}; nothing to answer.`;
      if (opts.json) out(JSON.stringify({ runId: issueId, answerAccepted: null, resumed: null, transport: null, error: message }));
      else log(message);
      return 2;
    }

    let answerAccepted: boolean | null = null;
    if (opts.correlation) {
      // Bind the correlation to THIS run before any write. `answerHumanQuestion`
      // settles every sibling ask in the correlation, and this command then
      // resumes and redeploys the run — so a correlation belonging to a
      // different issue must be refused here, not written and then deployed
      // against the wrong run. Compared case-insensitively because a Linear
      // identifier may be typed either way; the UUID the ledger stores is exact.
      const owner = await (deps.findQuestionTask ?? defaultFindQuestionTask)(opts.correlation);
      if (owner !== undefined && owner !== issueId
        && owner.toLowerCase() !== (row.identifier ?? '').toLowerCase()) {
        const message = `${opts.correlation} belongs to ${owner}, not ${row.identifier ?? issueId} — refusing to answer it through this run.`;
        if (opts.json) out(JSON.stringify({ runId: issueId, answerAccepted: false, resumed: null, transport: null, error: message }));
        else log(message);
        return 2;
      }
      const answer = deps.answerQuestion
        ?? (async (correlationId: string, text: string, who: string) => {
          const { answerHumanQuestion } = await import('../coordination/humanQuestions.js');
          // 'orchestrator' is the role OpenSwarm's own supervisor answers with:
          // the operator delegated that authority to it. An external main agent
          // driving this run stands in the same place, so it carries the same
          // authority — including approval-class questions. A deployment that
          // wants the narrower reading (clarification only) can pass
          // `answerQuestion` here and gate on `questionClass` itself.
          return answerHumanQuestion(correlationId, text, who, 'orchestrator');
        });
      const result = await answer(opts.correlation, opts.text ?? '', actor);
      answerAccepted = result.accepted;
      if (!result.accepted) {
        log(`Answer refused: ${result.reason ?? 'unknown reason'}`);
        if (opts.json) out(JSON.stringify({ runId: issueId, answerAccepted: false, resumed: null, transport: null, error: result.reason }));
        return 1;
      }
    }

    const ledger: AnswerLedger = deps.openLedger
      ? deps.openLedger(context.dbPath)
      : new RunLedger(context.dbPath);
    let resumed: string | null = null;
    try {
      // An ask_human park is released only by its own exact-correlation
      // contract (runLedger.ts:378 refuses every other trigger), and the answer
      // written above is what that contract reads. Try that first, then the
      // generic operator-park promotion, then the plain reopen.
      if (row.lastErrorCode === OPERATOR_QUESTION_PARK_REASON) {
        resumed = ledger.resumeNeedsHumanForQuestions(issueId);
      }
      if (!resumed && ledger.readmitParkedRun(issueId, row.lastErrorCode ?? '')) resumed = 'READY';
      if (!resumed && ledger.markReady(issueId)) resumed = 'READY';
    } finally {
      ledger.close();
    }
    if (!resumed) {
      log(`Could not resume ${row.identifier ?? issueId} from ${row.state} (park: ${row.lastErrorCode ?? 'none'}).`);
      if (opts.json) out(JSON.stringify({ runId: issueId, answerAccepted, resumed: null, transport: null, error: `could not resume from ${row.state}` }));
      return 1;
    }

    // Re-marked, not cleared: a hold belongs to the deploy session, and clearing
    // it here would hand the NEXT park back to idle_fill — the elevation after
    // this one would be silently ignored. Re-marking also extends the TTL.
    try {
      (deps.markHold ?? ((issueId2: string, who: string) => markExecHold(issueId2, who)))(issueId, actor);
    } catch (err) {
      log(`Could not refresh the exec hold: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const repoPath = resolve(expandPath(opts.path ?? process.cwd(), true));
    const identifier = row.identifier ?? issueId;
    const deploy = await deployResolvedIssue(deps, repoPath, identifier);
    if (!deploy.ok) {
      log(`Resumed ${identifier} (${resumed}) but the redeploy failed (${deploy.transport}): ${deploy.detail ?? 'unknown reason'}`);
      if (opts.json) out(JSON.stringify({ runId: issueId, answerAccepted, resumed, transport: deploy.transport, error: deploy.detail }));
      return deploy.exitCode;
    }

    if (opts.json) {
      out(JSON.stringify({ runId: issueId, answerAccepted, resumed, transport: deploy.transport }));
    } else {
      out(`${identifier} resumed (${resumed}) and redeployed via ${deploy.transport}.`);
      out(`Next: openswarm exec await ${issueId}`);
    }
    return 0;
  } finally {
    restoreConsole?.();
  }
}
