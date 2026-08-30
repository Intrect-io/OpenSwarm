// ============================================
// OpenSwarm - `openswarm work` (INT-3387)
// ============================================
//
// Pick Linear issues (by id or interactively) and deploy the worker/reviewer
// pipeline per issue into isolated git worktrees, in parallel. Uses the same
// durable run ledger as the daemon (~/.openswarm/automation.db), so a running
// daemon and this command arbitrate ownership through claims instead of
// double-executing, and completion effects survive a crash in the shared
// outbox either process can drain.
//
// Exit codes: 0 = every deployed issue succeeded (superseded issues — owned by
// another process — do not count as failures), 1 = at least one failed,
// 2 = nothing was deployed at all (validation failed / nothing selected),
// 130 = interrupted.

import { buildBranchName } from '../support/branchNaming.js';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import type { LinearIssueInfo, SwarmConfig } from '../core/types.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { linearIssueToTask } from '../orchestration/decisionEngine.js';
import { enrichTaskFromState } from '../taskState/store.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { ITaskSource } from '../automation/taskSource.js';
import {
  executePipeline,
  isValidProjectPath,
  setTaskSource,
  type ExecutionContext,
} from '../automation/runnerExecution.js';
import {
  DurableRunCoordinator,
  type DurableExecuteOptions,
  type ExecutionDurabilityHooks,
  type RepositoryAdmissionPolicy,
} from '../automation/durableRunCoordinator.js';
import type { EffectClaim } from '../automation/runLedger.js';
import { setAutomationDbPath } from '../automation/automationDbPath.js';
import { loadRepoMetadata, type RepoMetadata } from '../support/repoMetadata.js';
import { hasRecoverableWorktree } from '../support/worktreeManager.js';
import { runPool } from '../support/concurrencyPool.js';
import { fileScopesConflict, resolveTaskFileScope } from '../orchestration/conflictDetector.js';
import { buildConflictFreeWaves as partitionConflictFreeWaves } from '../orchestration/conflictAdmission.js';
import { ensureTaskSource } from './reviewCommand.js';
import { filterRepoIssues, selectIssuesInteractive, WORK_SKIP_STATES } from './workSelect.js';
import {
  buildWorkCancellationEffect,
  buildWorkCompletionEffect,
  buildWorkExecutionContext,
  deliverWorkCompletionEffect,
} from './workExecution.js';

export const WORK_EXIT_OK = 0;
export const WORK_EXIT_FAILED = 1;
export const WORK_EXIT_NOT_RUN = 2;
export const WORK_EXIT_INTERRUPTED = 130;

/** The daemon's fan-out admission (autonomousRunner.executeDurably) with the
 *  repository's own openswarm.json automation policy layered in. Worktrees
 *  isolate live edits, while the predicted write set protects later branch
 *  integration across this CLI and a concurrently running daemon. */
export function buildWorkAdmission(
  concurrency: number,
  automation?: RepoMetadata['automation'],
  conflictScope: string[] = [],
): RepositoryAdmissionPolicy {
  return {
    maxConcurrent: automation?.maxConcurrent !== undefined
      ? Math.min(concurrency, automation.maxConcurrent)
      : concurrency,
    conflictScope,
    maxAttemptsPerHour: automation?.maxAttemptsPerHour,
    maxFailuresPerHour: automation?.maxFailuresPerHour ?? 6,
    maxCostUsdPerDay: automation?.maxCostUsdPerDay,
    circuitCooldownMs: (automation?.circuitCooldownMinutes ?? 60) * 60_000,
  };
}

export interface WorkCommandOptions {
  /** Issue ids/identifiers (e.g. INT-123). Empty → interactive picker. */
  issueIds?: string[];
  /** Repository path (default: cwd). */
  path?: string;
  /** Max issues in flight (default: min(selected, autonomous.maxConcurrentTasks ?? 4)). */
  concurrency?: number;
  /** Print the execution plan and exit. */
  dryRun?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Adapter override for the worker/reviewer. */
  adapter?: string;
  /** Emit the final summary as JSON on stdout (progress logs go to stderr). */
  json?: boolean;
}

/** The coordinator surface this command uses — injectable for tests. */
export interface WorkCoordinator {
  execute(
    task: TaskItem,
    projectPath: string,
    executor: (hooks: ExecutionDurabilityHooks, leaseSignal: AbortSignal) => Promise<PipelineResult>,
    options?: DurableExecuteOptions,
  ): Promise<PipelineResult>;
  drainOutbox(deliver: (effect: EffectClaim) => Promise<void>): Promise<unknown>;
  close(): void;
}

export interface WorkCommandDeps {
  loadConfig?: () => SwarmConfig;
  ensureTaskSource?: () => Promise<ITaskSource | null>;
  /** Registers the source as runnerExecution's module-global task source. */
  registerTaskSource?: (source: ITaskSource) => void;
  isValidProjectPath?: (path: string) => Promise<boolean>;
  isGitRepo?: (path: string) => boolean;
  loadRepoMetadata?: (path: string) => Promise<RepoMetadata | null>;
  getIssue?: (idOrIdentifier: string) => Promise<LinearIssueInfo | null>;
  listIssues?: () => Promise<LinearIssueInfo[]>;
  selectIssues?: (issues: LinearIssueInfo[]) => Promise<LinearIssueInfo[]>;
  confirm?: (message: string) => Promise<boolean>;
  createCoordinator?: (opts: { dbPath?: string; maxActive: number }) => WorkCoordinator;
  executePipeline?: (
    ctx: ExecutionContext,
    task: TaskItem,
    projectPath: string,
    signal?: AbortSignal,
  ) => Promise<PipelineResult>;
  deliverEffect?: (effect: EffectClaim, source: ITaskSource | null) => Promise<void>;
  hasRecoverableWorktree?: (repoPath: string, issueId: string, branchName: string) => Promise<boolean>;
  resolveTaskFileScope?: (task: TaskItem, projectPath: string) => Promise<string[]>;
  /** Installs the SIGINT handler; returns the uninstaller. */
  installSigintHandler?: (onSigint: () => void) => () => void;
  isTTY?: boolean;
  /** Progress/diagnostics — stderr, so `--json | jq` parses. */
  log?: (line: string) => void;
  /** Final summary — stdout. */
  out?: (line: string) => void;
  /** Immediate force-quit on the second Ctrl-C. */
  exit?: (code: number) => never;
}

interface PlanRow {
  task: TaskItem;
  branchName: string;
  /** A preserved worktree or task branch already exists — the run resumes it. */
  resumes: boolean;
}

/**
 * Partition a priority-ordered plan into pairwise-disjoint execution waves.
 * Unknown scopes conflict with everything, so they each get a serial wave.
 * The durable ledger repeats the same check atomically across processes; this
 * local partition prevents siblings from merely losing a claim and being
 * reported as superseded instead of running in the next safe wave.
 */
export function buildConflictFreeWaves<T extends { task: TaskItem }>(rows: readonly T[]): T[][] {
  return partitionConflictFreeWaves(
    rows,
    (left, right) => fileScopesConflict(left.task.fileScope, right.task.fileScope),
  );
}

export interface WorkIssueSummary {
  identifier: string;
  issueId: string;
  title: string;
  /** PipelineResult.finalStatus, or 'error' when the executor threw. */
  status: string;
  success: boolean;
  prUrl?: string;
  worktreePreserved: boolean;
  resumed: boolean;
  note?: string;
}

/** Classify one pool slot into the user-facing summary row. Pure. */
export function summarizeSettled(
  row: PlanRow,
  settled: { value?: PipelineResult; error?: unknown },
): WorkIssueSummary {
  const base = {
    identifier: row.task.issueIdentifier ?? row.task.issueId ?? row.task.id,
    issueId: row.task.issueId ?? row.task.id,
    title: row.task.title,
    resumed: row.resumes,
  };
  if (settled.error !== undefined || !settled.value) {
    return {
      ...base,
      status: 'error',
      success: false,
      worktreePreserved: true,
      note: settled.error instanceof Error ? settled.error.message : String(settled.error),
    };
  }
  const result = settled.value;
  if (result.finalStatus === 'superseded') {
    // The ledger refused the claim: a daemon (or another `work` session) owns
    // this issue, or its failure circuit is open. Not a failure of this run.
    return {
      ...base,
      status: 'superseded',
      success: false,
      worktreePreserved: false,
      note: 'owned by another process (daemon or another session), or awaiting reconciliation',
    };
  }
  if (result.finalStatus === 'deferred') {
    return {
      ...base,
      status: 'deferred',
      success: false,
      // The pipeline never started, so no cleanup ran. Any resumable worktree
      // remains untouched for the later durable retry.
      worktreePreserved: true,
      note: result.retryAt
        ? `durable admission deferred until ${new Date(result.retryAt).toISOString()}`
        : 'durable admission deferred',
    };
  }
  const delivered = result.success && result.finalStatus === 'approved';
  return {
    ...base,
    status: result.finalStatus,
    success: result.success,
    prUrl: result.prUrl,
    // Mirrors executePipeline's keepWorktree: anything short of an approved
    // success preserves the tree so a re-run resumes the partial work.
    worktreePreserved: !delivered,
  };
}

/** Render the human summary table. Pure. */
export function formatWorkSummary(summaries: WorkIssueSummary[]): string[] {
  const idWidth = Math.max(...summaries.map((s) => s.identifier.length), 5);
  const statusWidth = Math.max(...summaries.map((s) => s.status.length), 6);
  return summaries.map((s) => {
    const parts = [
      s.identifier.padEnd(idWidth),
      s.status.padEnd(statusWidth),
      s.prUrl ?? '-',
      s.worktreePreserved ? 'worktree preserved' : 'worktree removed',
    ];
    if (s.resumed) parts.push('(resumed)');
    if (s.note) parts.push(`— ${s.note}`);
    return parts.join('  ');
  });
}

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message, default: true });
}

/** In --json mode stdout carries one document; reroute pipeline console.log noise. */
function redirectConsoleLogToStderr(): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  return () => {
    console.log = original;
  };
}

function isExitPromptError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

export async function runWorkCommand(
  opts: WorkCommandOptions = {},
  deps: WorkCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const out = deps.out ?? ((line: string) => console.log(line));
  const repoPath = resolve(opts.path ?? process.cwd());

  // In --json mode stdout carries one document. Redirection must cover the
  // WHOLE lifecycle: loadConfig/setTaskSource/getMyIssues all console.log
  // during bootstrap, and any of it ahead of the JSON body breaks `| jq`.
  const restoreConsole = opts.json ? redirectConsoleLogToStderr() : null;
  try {
    return await runWorkCommandInner(opts, deps, { log, out, repoPath });
  } finally {
    restoreConsole?.();
  }
}

async function runWorkCommandInner(
  opts: WorkCommandOptions,
  deps: WorkCommandDeps,
  io: { log: (line: string) => void; out: (line: string) => void; repoPath: string },
): Promise<number> {
  const { log, out, repoPath } = io;

  // ---- Bootstrap -----------------------------------------------------------
  const validate = deps.isValidProjectPath ?? isValidProjectPath;
  if (!(await validate(repoPath))) {
    log(`Not a project directory (needs .git, package.json, or pyproject.toml): ${repoPath}`);
    return WORK_EXIT_NOT_RUN;
  }
  // Worktree mode is this command's contract, and worktrees need a real git
  // repository — a bare package.json/pyproject.toml directory would pass the
  // generic check, then resolve issues, claim durable runs, and spend model
  // budget on draft analysis before createWorktree inevitably fails.
  if (!(deps.isGitRepo ?? ((p: string) => existsSync(join(p, '.git'))))(repoPath)) {
    log(`Not a git repository (worktree fan-out requires one): ${repoPath}`);
    return WORK_EXIT_NOT_RUN;
  }

  let config: SwarmConfig;
  try {
    config = (deps.loadConfig ?? loadConfig)();
  } catch (err) {
    log(`Could not load config: ${err instanceof Error ? err.message : String(err)}`);
    return WORK_EXIT_NOT_RUN;
  }

  const source = await (deps.ensureTaskSource ?? ensureTaskSource)();
  if (!source) {
    log('Linear is not configured — `openswarm work` picks issues from your tracker.');
    log('Run `openswarm auth login --provider linear` (or set linearApiKey + linearTeamId in config.yaml), then re-run.');
    return WORK_EXIT_NOT_RUN;
  }
  // executePipeline routes In Progress transitions and audit comments through
  // runnerExecution's module-global task source — registration is mandatory.
  (deps.registerTaskSource ?? setTaskSource)(source);

  let meta: RepoMetadata | null = null;
  try {
    meta = await (deps.loadRepoMetadata ?? loadRepoMetadata)(repoPath);
  } catch (err) {
    log(`Unreadable openswarm.json in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    return WORK_EXIT_NOT_RUN;
  }
  const projectId = meta?.linear?.projectId;

  // Repository automation policy is authoritative here too — `openswarm work`
  // spends model budget and publishes PRs exactly like the daemon does, and
  // openswarm.json's kill switch / spend limits exist to bound that.
  if (meta?.automation?.enabled === false) {
    log(`Automation is disabled for this repository (openswarm.json automation.enabled: false) — remove that setting to allow \`openswarm work\`.`);
    return WORK_EXIT_NOT_RUN;
  }

  // ---- Issue resolution ----------------------------------------------------
  const directIds = [...new Set((opts.issueIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const skipped: Array<{ identifier: string; reason: string }> = [];
  let picked: LinearIssueInfo[] = [];

  if (directIds.length > 0) {
    const getIssue = deps.getIssue
      ?? (async (id: string) => (await import('../linear/linear.js')).getIssue(id));
    const resolved = await Promise.all(
      directIds.map(async (id) => ({ id, issue: await getIssue(id) })),
    );
    const missing = resolved.filter((entry) => !entry.issue);
    if (missing.length > 0) {
      for (const entry of missing) log(`Issue not found: ${entry.id}`);
      log('Nothing started — every listed issue must resolve before deploying (fail-fast).');
      return WORK_EXIT_NOT_RUN;
    }
    const seen = new Set<string>();
    for (const { issue } of resolved as Array<{ id: string; issue: LinearIssueInfo }>) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      if ((WORK_SKIP_STATES as readonly string[]).includes(issue.state)) {
        skipped.push({ identifier: issue.identifier, reason: `state is ${issue.state}` });
      } else if (projectId && issue.project?.id !== projectId) {
        // An authoritative repo mapping exists and this issue belongs to a
        // different Linear project — running it here would edit the wrong
        // codebase, publish a PR from it, and mark the foreign issue Done.
        // (Repos without a mapping keep the explicit-id escape hatch.)
        skipped.push({
          identifier: issue.identifier,
          reason: `belongs to a different Linear project than this repo's mapping`,
        });
      } else {
        picked.push(issue);
      }
    }
  } else {
    if (!projectId) {
      log('This repo has no Linear project mapping (openswarm.json) — the picker cannot scope the issue list.');
      log(`Run \`openswarm add ${repoPath}\` once to map it, or pass issue ids explicitly.`);
      return WORK_EXIT_NOT_RUN;
    }
    const list = deps.listIssues
      ?? (async () => (await import('../linear/linear.js')).getMyIssues({ slim: true }));
    let candidates: LinearIssueInfo[];
    try {
      candidates = filterRepoIssues(await list(), projectId);
    } catch (err) {
      log(`Could not fetch issues: ${err instanceof Error ? err.message : String(err)}`);
      return WORK_EXIT_NOT_RUN;
    }
    if (candidates.length === 0) {
      log('No selectable issues (Todo / Backlog / In Progress) for this repo.');
      return WORK_EXIT_NOT_RUN;
    }
    try {
      picked = await (deps.selectIssues ?? selectIssuesInteractive)(candidates);
    } catch (err) {
      if (isExitPromptError(err)) return WORK_EXIT_NOT_RUN;
      throw err;
    }
  }

  // Blocked-by gate: a dependent fanned out concurrently with (or before) its
  // blocker runs from the base branch without the blocker's changes and can
  // publish prematurely. Any unresolved blocker skips the issue — including
  // one selected in this same batch (it isn't finished either).
  if (picked.some((issue) => (issue.blockedBy?.length ?? 0) > 0)) {
    const getIssueForBlockCheck = deps.getIssue
      ?? (async (id: string) => (await import('../linear/linear.js')).getIssue(id));
    const blockerStates = new Map<string, string | null>();
    const blockerIds = [...new Set(picked.flatMap((issue) => issue.blockedBy ?? []))];
    await Promise.all(blockerIds.map(async (id) => {
      const blocker = await getIssueForBlockCheck(id).catch(() => null);
      blockerStates.set(id, blocker?.state ?? null);
    }));
    const blockerDone = (state: string | null): boolean =>
      state === null // unknown/deleted blocker — don't dead-lock on stale relations
      || ['done', 'canceled', 'cancelled'].includes(state.toLowerCase());
    picked = picked.filter((issue) => {
      const open = (issue.blockedBy ?? []).filter((id) => !blockerDone(blockerStates.get(id) ?? null));
      if (open.length === 0) return true;
      skipped.push({ identifier: issue.identifier, reason: `blocked by ${open.length} unresolved issue(s)` });
      return false;
    });
  }

  for (const skip of skipped) log(`Skipping ${skip.identifier}: ${skip.reason}`);
  if (picked.length === 0) {
    log('No issues selected — nothing to deploy.');
    return WORK_EXIT_NOT_RUN;
  }

  const tasks = picked.map((issue) => {
    const task = enrichTaskFromState(linearIssueToTask({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      labels: issue.labels,
      blockedBy: issue.blockedBy,
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : undefined,
    }));
    task.explicitDispatch = true;
    // Real issue age, not Date.now(): duplicate grooming keeps the OLDER of
    // two overlapping issues as canonical, and fabricated timestamps let
    // selection order cancel the genuinely older issue.
    if (issue.createdAt) {
      const created = Date.parse(issue.createdAt);
      if (Number.isFinite(created)) task.createdAt = created;
    }
    return task;
  });

  const concurrency = opts.concurrency
    ?? Math.min(tasks.length, config.autonomous?.maxConcurrentTasks ?? 4);

  // ---- Plan ----------------------------------------------------------------
  const recoverable = deps.hasRecoverableWorktree ?? hasRecoverableWorktree;
  const plan: PlanRow[] = await Promise.all(tasks.map(async (task) => {
    const branchName = buildBranchName(task.issueIdentifier ?? task.issueId ?? task.id, task.title);
    const resumes = await recoverable(repoPath, task.issueId ?? task.id, branchName)
      .catch(() => false);
    return { task, branchName, resumes };
  }));

  if (opts.dryRun) {
    if (opts.json) {
      out(JSON.stringify({
        repoPath,
        dryRun: true,
        concurrency,
        plan: plan.map((row) => ({
          identifier: row.task.issueIdentifier,
          issueId: row.task.issueId,
          title: row.task.title,
          state: row.task.linearState,
          branch: row.branchName,
          resumes: row.resumes,
        })),
        skipped,
      }, null, 2));
    } else {
      out(`Plan: ${plan.length} issue(s) → isolated worktrees of ${repoPath} (concurrency ${concurrency})`);
      for (const row of plan) {
        const marks = [row.resumes ? 'resume' : 'fresh'];
        if (row.task.linearState === 'In Progress') marks.push('in progress');
        out(`  ${row.task.issueIdentifier}  ${row.branchName}  [${marks.join(', ')}]`);
      }
    }
    return WORK_EXIT_OK;
  }

  // ---- Confirmation --------------------------------------------------------
  // The interactive picker is its own confirmation; only directly-addressed
  // runs prompt. Headless without --yes fails closed: this command spends
  // model budget and publishes PRs.
  if (!opts.yes && directIds.length > 0) {
    const isTTY = deps.isTTY ?? !!process.stdin.isTTY;
    if (!isTTY) {
      log('Refusing to deploy without confirmation on a non-interactive stdin — pass --yes.');
      return WORK_EXIT_NOT_RUN;
    }
    let confirmed: boolean;
    try {
      confirmed = await (deps.confirm ?? defaultConfirm)(
        `Deploy ${tasks.length} agent pipeline(s) into isolated worktrees of ${repoPath}?`,
      );
    } catch (err) {
      if (isExitPromptError(err)) return WORK_EXIT_NOT_RUN;
      throw err;
    }
    if (!confirmed) return WORK_EXIT_NOT_RUN;
  }

  // ---- Execution -----------------------------------------------------------
  const resolveScope = deps.resolveTaskFileScope ?? resolveTaskFileScope;
  await Promise.all(plan.map((row) => resolveScope(row.task, repoPath)));
  const waves = buildConflictFreeWaves(plan);
  if (waves.length > 1) {
    log(`Conflict preflight split ${plan.length} issue(s) into ${waves.length} non-overlapping wave(s).`);
  }

  // Same file for the ledger and the coordination trace — see setAutomationDbPath.
  setAutomationDbPath(config.autonomous?.automationDbPath);
  const coordinator = (deps.createCoordinator
    ?? ((o: { dbPath?: string; maxActive: number }) => new DurableRunCoordinator({
      mode: 'primary',
      dbPath: o.dbPath,
      maxActiveForProject: o.maxActive,
    })))({ dbPath: config.autonomous?.automationDbPath, maxActive: concurrency });

  const exec = deps.executePipeline ?? executePipeline;

  const sigint = new AbortController();
  let interrupts = 0;
  const forceExit = deps.exit ?? ((code: number) => process.exit(code));
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts > 1) forceExit(WORK_EXIT_INTERRUPTED);
    log('Interrupted — aborting running pipelines. Worktrees holding work are preserved; re-run the same command to resume. (Ctrl-C again to force quit)');
    sigint.abort(new Error('SIGINT'));
  };
  const uninstallSigint = (deps.installSigintHandler ?? ((handler: () => void) => {
    process.on('SIGINT', handler);
    return () => process.removeListener('SIGINT', handler);
  }))(onSigint);

  let settledRows: Array<{ value?: PipelineResult; error?: unknown }>;
  try {
    const settledByRow = new Map<PlanRow, { value?: PipelineResult; error?: unknown }>();
    for (const wave of waves) {
      const waveSettled = await runPool(wave, Math.min(concurrency, wave.length), async (row) => {
        // Ctrl-C: runPool keeps pulling queued rows — skip them outright instead
        // of entering coordinator.execute, which would still claim the issue and
        // run comment refresh + draft analysis before the abort lands.
        if (sigint.signal.aborted) {
          return {
            success: false,
            sessionId: `work-interrupted-${Date.now()}`,
            stages: [],
            finalStatus: 'cancelled',
            totalDuration: 0,
            iterations: 0,
            taskContext: {
              issueIdentifier: row.task.issueIdentifier,
              projectPath: repoPath,
              taskTitle: row.task.title,
            },
          } satisfies PipelineResult;
        }
        log(`[${row.task.issueIdentifier}] deploying${row.resumes ? ' (resume)' : ''}…`);
        return coordinator.execute(
          row.task,
          repoPath,
          (durability, leaseSignal) => exec(
            buildWorkExecutionContext({
              autonomous: config.autonomous,
              repoPath,
              peerIssues: tasks,
              durability,
              adapter: opts.adapter as import('../core/types.js').AgentAdapterName | undefined,
              log,
            }),
            row.task,
            repoPath,
            AbortSignal.any([sigint.signal, leaseSignal]),
          ),
          {
            admission: buildWorkAdmission(concurrency, meta?.automation, row.task.fileScope ?? []),
            successEffect: (result, claim) => buildWorkCompletionEffect(row.task, result, claim.attemptNo),
            cancelEffect: (_result, claim) => buildWorkCancellationEffect(row.task, claim.attemptNo),
            // Interruptions are resumable — never turn Ctrl-C into a tracker cancel.
            retryCancellation: () => true,
          },
        );
      }, (settled) => {
        const row = wave[settled.index];
        if (settled.error !== undefined) {
          log(`[${row.task.issueIdentifier}] error: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`);
        } else if (settled.value) {
          const prNote = settled.value.prUrl ? ` → ${settled.value.prUrl}` : '';
          log(`[${row.task.issueIdentifier}] ${settled.value.finalStatus}${prNote}`);
        }
      });
      for (const [index, settled] of waveSettled.entries()) {
        settledByRow.set(wave[index], settled);
      }
    }
    settledRows = plan.map((row) => settledByRow.get(row) ?? {
      error: new Error('work plan row was not executed'),
    });

    // Deliver queued completion effects (Done transition + completion comment)
    // now instead of leaving them for the next daemon start. drainOutbox's
    // default batch is 20 — loop until a pass applies nothing, or issues past
    // the twentieth would report success while still In Progress on Linear.
    try {
      const deliver = (effect: EffectClaim) =>
        (deps.deliverEffect ?? deliverWorkCompletionEffect)(effect, source);
      for (let pass = 0; pass < 50; pass++) {
        const drained = await coordinator.drainOutbox(deliver) as { applied?: number } | undefined;
        if (!drained || (drained.applied ?? 0) === 0) break;
      }
    } catch (err) {
      log(`Completion delivery failed — the shared outbox retains it for retry (daemon or next run): ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    uninstallSigint();
    coordinator.close();
  }

  // ---- Summary -------------------------------------------------------------
  const summaries = plan.map((row, index) => summarizeSettled(row, settledRows[index] ?? {}));
  const failed = summaries.some((s) => !s.success && s.status !== 'superseded');
  const exitCode = interrupts > 0
    ? WORK_EXIT_INTERRUPTED
    : failed ? WORK_EXIT_FAILED : WORK_EXIT_OK;

  if (opts.json) {
    out(JSON.stringify({
      repoPath,
      concurrency,
      interrupted: interrupts > 0,
      results: summaries,
      skipped,
      exitCode,
    }, null, 2));
  } else {
    out('');
    out(`Results (${summaries.length} issue(s)):`);
    for (const line of formatWorkSummary(summaries)) out(`  ${line}`);
  }
  return exitCode;
}
