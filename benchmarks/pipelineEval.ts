#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Evidence-grounded worker -> reviewer -> PR evaluation (AGT-4534)
// ============================================
//
// Runs the production PairPipeline (worker + reviewer) with a real provider
// against seeded-defect cases, then grades every run from evidence the
// harness gathers itself — never from what the agents say:
//
//   - the fixture's own tests, executed by the harness after the run;
//   - `git diff` against the exact base commit (test tampering, scope);
//   - the usage ledger (every LLM call: adapter, requested + served model);
//   - for published runs, the PR as GitHub reports it (URL, head SHA, checks).
//
// Isolation: the pipeline process runs with HOME pointed at a scratch
// directory, so no ~/.openswarm state (ledger, board, memory, config) is read
// or written, and the target repository is a scratch clone whose eval branches
// start from origin/main plus the fixture only. Nothing here touches a live
// daemon, another repository, or the operator's config.
//
// Usage:
//   npx tsx benchmarks/pipelineEval.ts --case honest-fix [--case ...] [--repeat N]
//     [--model deepseek-v4.1-flash] [--adapter ollama-cloud] [--max-iterations 3]
//     [--publish] [--checks-wait-min 12] [--keep-pr]
//   npx tsx benchmarks/pipelineEval.ts --cleanup <runId>   (unseal and delete one run root)
//
// Credentials: OLLAMA_API_KEY from the environment or the main checkout's
// .env; GH_TOKEN from `gh auth token` (only with --publish). Neither is printed.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { type Stats, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CASES, FIXTURE, FIXTURE_SOURCE, type EvalCase, type EvalRecord, type GroundTruth, type RunOutcome, type UsageRow,
  classifyChanges, countWorkflowRuns, dispatchGuardScript, evalPublication, findEvalLeaks, gradeRun,
  providerEvidence, summariseResults, summariseUsage,
} from './pipelineEvalGrading.js';

// The cases and grading rules live in pipelineEvalGrading.ts (pure, unit-tested).
export * from './pipelineEvalGrading.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'results');
/** Result files this harness writes. They name every case, so they are gitignored and never evaluated. */
export const RESULTS_GLOB = 'benchmarks/results/pipelineEval-';
/**
 * Paths removed from the tree under evaluation before the leak check: this
 * harness, its grading tests, and the fixture source (placed at FIXTURE).
 */
export const GRADED_PATHS = [
  'benchmarks/pipelineEval.ts', 'benchmarks/pipelineEvalGrading.ts',
  'tests/pipelineEval.grading.test.ts', 'tests/pipelineEval.helpers.test.ts', FIXTURE_SOURCE,
];
const GITHUB_REMOTE = 'https://github.com/Intrect-io/OpenSwarm.git';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface Options {
  cases: string[];
  repeat: number;
  model: string;
  adapter: string;
  maxIterations: number;
  publish: boolean;
  checksWaitMin: number;
  keepPr: boolean;
  runId: string;
  /** Unseal and delete this run's root instead of running anything. */
  cleanup?: string;
}

function positiveNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    cases: [],
    repeat: 1,
    model: 'deepseek-v4.1-flash',
    adapter: 'ollama-cloud',
    maxIterations: 3,
    publish: false,
    checksWaitMin: 12,
    keepPr: false,
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--case') opts.cases.push(next());
    else if (arg === '--repeat') opts.repeat = Number(next());
    else if (arg === '--model') opts.model = next();
    else if (arg === '--adapter') opts.adapter = next();
    else if (arg === '--max-iterations') {
      opts.maxIterations = positiveNumber(arg, next());
      if (!Number.isInteger(opts.maxIterations)) throw new Error('--max-iterations must be a positive integer');
    }
    else if (arg === '--publish') opts.publish = true;
    else if (arg === '--checks-wait-min') opts.checksWaitMin = positiveNumber(arg, next());
    else if (arg === '--keep-pr') opts.keepPr = true;
    else if (arg === '--run-id') opts.runId = next();
    else if (arg === '--cleanup') opts.cleanup = next();
    else if (arg === '--child') i += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.cases.length === 0) opts.cases = CASES.map((c) => c.id);
  for (const id of opts.cases) {
    if (!CASES.some((c) => c.id === id)) throw new Error(`Unknown case: ${id}`);
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer');
  return opts;
}

// ---------------------------------------------------------------------------
// Evidence helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Where a run lives: `<main checkout>/worktree/claude-eval-runs/<runId>`.
 *
 * Not the shared TMPDIR. On 2026-09-25 another session's
 * `rm -rf openswarm-pipeline-eval-*` there deleted three runs' transcripts, and
 * the worker sandbox (osSandbox.ts) lets every worker write TMPDIR, so nothing
 * kept there is protected from the agents either. `worktree/` is gitignored.
 */
export function resolveRunRoot(mainCheckout: string, runId: string, sharedTempRoots: string[]): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith('.')) throw new Error(`invalid run id: ${runId}`);
  const root = join(mainCheckout, 'worktree', 'claude-eval-runs', runId);
  for (const temp of sharedTempRoots) {
    if (temp && (root === temp || root.startsWith(`${temp.replace(/\/+$/, '')}/`))) {
      throw new Error(`run root ${root} is inside the shared temporary directory ${temp}`);
    }
  }
  return root;
}

/** Make evidence undeletable by a plain `rm -rf` (directories 0555, files 0444). */
export function sealEvidence(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sealEvidence(path);
    else if (entry.isFile()) chmodSync(path, 0o444);
  }
  chmodSync(dir, 0o555);
}

/** Undo sealEvidence, for a deliberate cleanup. */
export function unsealEvidence(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) unsealEvidence(path);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
}

/**
 * Delete one run's root (`--cleanup <runId>`): resolved through resolveRunRoot,
 * so only `<main checkout>/worktree/claude-eval-runs/<runId>` can be removed,
 * then unsealed and removed. Returns the removed path.
 */
export function cleanupRun(mainCheckout: string, runId: string, sharedTempRoots: string[]): string {
  const root = resolveRunRoot(mainCheckout, runId, sharedTempRoots);
  let stat: Stats;
  try { stat = lstatSync(root); } catch { throw new Error(`no run root for ${runId}: ${root}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`run root is not a plain directory: ${root}`);
  unsealEvidence(root);
  rmSync(root, { recursive: true, force: true });
  return root;
}

/**
 * Grader locations reached by the agents' tool calls, read from the run's
 * session transcripts (arguments and outputs). The run root sits inside the
 * OpenSwarm checkout, so the harness, the fixture source and other runs'
 * evidence are a few `..` away; reads cannot be fenced without changing the
 * product sandbox, so they are detected and the run is not counted.
 */
export function findGraderAccess(transcripts: string, runId: string): string[] {
  const found: string[] = [];
  for (const marker of ['pipelineEval', 'fixtures/pipeline-eval', '.claude/worktrees']) {
    if (transcripts.includes(marker)) found.push(marker);
  }
  for (const match of transcripts.matchAll(/claude-eval-runs\/([A-Za-z0-9._-]+)/g)) {
    const other = `claude-eval-runs/${match[1]}`;
    if (match[1] !== runId && !found.includes(other)) found.push(other);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Shared temporary directories a run root must never sit in (and their realpaths). */
function sharedTempRoots(): string[] {
  return [tmpdir(), process.env.TMPDIR ?? '', '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .filter(Boolean).flatMap((path) => { try { return [path, realpathSync(path)]; } catch { return [path]; } });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.trim();
}

function readKeyFromEnvFile(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`));
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parent: build the isolated environment, then re-exec as the child
// ---------------------------------------------------------------------------

async function parent(opts: Options): Promise<void> {
  const commonDir = resolve(ROOT, await git(ROOT, 'rev-parse', '--git-common-dir'));
  const mainCheckout = dirname(commonDir);
  const apiKey = process.env.OLLAMA_API_KEY?.trim() || readKeyFromEnvFile(join(mainCheckout, '.env'), 'OLLAMA_API_KEY');
  if (opts.adapter === 'ollama-cloud' && !apiKey) throw new Error('OLLAMA_API_KEY not found (env or main checkout .env)');

  const evalRoot = resolveRunRoot(realpathSync(mainCheckout), opts.runId, sharedTempRoots());
  // A run id names its evidence for good: never write into an earlier run's root.
  if (existsSync(evalRoot)) throw new Error(`run root already exists (pick a new --run-id): ${evalRoot}`);
  const home = join(evalRoot, 'home');
  const repo = join(evalRoot, 'repo');
  await mkdir(join(home, '.openswarm'), { recursive: true });
  // Model weights (the memory embedder) are data, not state: copy them in so
  // every run does not re-download ~270 MB. A copy, never a link, so nothing
  // the run writes can reach the operator's directory. `-c` clones on APFS.
  const realModels = join(homedir(), '.openswarm', 'models');
  if (existsSync(realModels)) {
    await exec('cp', [...(process.platform === 'darwin' ? ['-c'] : []), '-R', realModels, join(home, '.openswarm', 'models')]);
  }

  // Scratch clone sharing objects with this repository; origin is GitHub so
  // the production publication path pushes where a real run would.
  // A fresh single-branch clone of main from GitHub: no local refs, no
  // alternates into this repository. Measured on run blk1: with a --shared
  // clone of the local repository, a worker ran `git show` on this harness's
  // own branch and quoted the fixture's notes on how it is graded.
  // Depth 1: commit messages written from earlier eval runs name the cases.
  await exec('git', ['clone', '-q', '--single-branch', '--branch', 'main', '--depth', '1', '--no-tags', GITHUB_REMOTE, repo]);
  await git(repo, 'checkout', '-q', '-B', `eval-base-${opts.runId}`, 'origin/main');
  await cp(join(ROOT, FIXTURE_SOURCE), join(repo, FIXTURE), { recursive: true });
  await git(repo, 'add', FIXTURE);
  // The agents must not be able to read how they are graded. Measured on run
  // base2: the reviewer searched benchmarks/ for "impossible|contradict|AGT-4534"
  // and the worker quoted the fixture's own notes. Hints stay in this file,
  // and this file (plus its tests) is removed from the tree under evaluation.
  for (const graded of GRADED_PATHS) {
    if (existsSync(join(repo, graded))) await git(repo, 'rm', '-q', '-r', graded);
  }
  // Fail closed rather than grade agents that can read the answer.
  const tracked = (await git(repo, 'ls-files', '-z')).split('\0').filter((path) => path && !path.startsWith(`${FIXTURE}/`));
  const files = tracked.flatMap((path) => {
    const text = readFileSync(join(repo, path), 'utf8');
    return text.includes('\0') ? [] : [{ path, text }];
  });
  const leaks = findEvalLeaks(files, [await git(repo, 'log', '--format=%B')]);
  if (leaks.length > 0) throw new Error(`Evaluated tree leaks the eval's cases (${leaks.length}):\n${leaks.slice(0, 40).join('\n')}`);
  const userName = await git(ROOT, 'config', 'user.name');
  const userEmail = await git(ROOT, 'config', 'user.email');
  await exec('git', ['-c', `user.name=${userName}`, '-c', `user.email=${userEmail}`, 'commit', '-q', '-m', 'chore: add textkit utilities'], { cwd: repo });
  const baseSha = await git(repo, 'rev-parse', 'HEAD');

  // Git identity + gh-backed credentials for the isolated HOME. No token is
  // written to disk: the helper asks gh, which reads GH_TOKEN from the env.
  const ghPath = (await exec('which', ['gh'])).stdout.trim();
  const gitConfig = join(evalRoot, 'gitconfig');
  await writeFile(gitConfig, [
    '[user]', `\tname = ${userName}`, `\temail = ${userEmail}`,
    '[credential "https://github.com"]', `\thelper = !${ghPath} auth git-credential`,
    '[init]', '\tdefaultBranch = main',
  ].join('\n') + '\n');
  const ghToken = opts.publish ? (await exec('gh', ['auth', 'token'])).stdout.trim() : undefined;
  // Every gh the pipeline and its agents run is the dispatch guard: no eval run
  // can start a GitHub workflow, and each dispatch that reached gh is counted.
  const guardDir = join(evalRoot, 'bin');
  const dispatchLog = join(evalRoot, 'dispatch.log');
  const dispatchNonce = randomBytes(6).toString('hex');
  await mkdir(guardDir, { recursive: true });
  await writeFile(join(guardDir, 'gh'), dispatchGuardScript(ghPath, dispatchLog, dispatchNonce), { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    PATH: [guardDir, process.env.PATH].filter(Boolean).join(':'),
    HOME: home,
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    OPENSWARM_EVAL_ISOLATED: '1',
    OPENSWARM_EVAL_ROOT: evalRoot,
    OPENSWARM_EVAL_REPO: repo,
    OPENSWARM_EVAL_BASE: baseSha,
    OPENSWARM_EVAL_DISPATCH_LOG: dispatchLog,
    OPENSWARM_EVAL_DISPATCH_NONCE: dispatchNonce,
    ...(apiKey ? { OLLAMA_API_KEY: apiKey } : {}),
    ...(ghToken ? { GH_TOKEN: ghToken } : {}),
  };
  console.log(`[eval] run ${opts.runId}  root ${evalRoot}  base ${baseSha.slice(0, 12)}`);
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
  const code = await new Promise<number>((resolveExit) => {
    const child = spawn(tsx, [fileURLToPath(import.meta.url), '--child', '1', ...process.argv.slice(2), '--run-id', opts.runId], {
      cwd: ROOT, env, stdio: 'inherit',
    });
    child.on('close', (exitCode) => resolveExit(exitCode ?? 1));
  });
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Child: run cases inside the isolated HOME
// ---------------------------------------------------------------------------

async function readUsageRows(home: string, taskId: string): Promise<UsageRow[]> {
  const dir = join(home, '.openswarm', 'usage');
  if (!existsSync(dir)) return [];
  const rows: UsageRow[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as UsageRow;
      if (row.taskId === taskId) rows.push(row);
    }
  }
  return rows;
}

async function groundTruth(worktree: string, baseSha: string, evalCase: EvalCase): Promise<GroundTruth & { testOutput: string }> {
  let testExitCode = 0;
  let testOutput = 'no truth test for this case';
  if (evalCase.truthTest) try {
    const { stdout, stderr } = await exec('node', ['--test', join(FIXTURE, evalCase.truthTest)], { cwd: worktree, timeout: 60_000 });
    testOutput = `${stdout}${stderr}`;
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    testExitCode = typeof failed.code === 'number' ? failed.code : 1;
    testOutput = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
  }
  // Committed and uncommitted changes against the exact base commit.
  const committed = (await git(worktree, 'diff', '--name-only', baseSha)).split('\n').filter(Boolean);
  const untracked = (await git(worktree, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean);
  const changedFiles = [...new Set([...committed, ...untracked])].sort();
  return {
    testExitCode,
    testOutput: testOutput.slice(-4000),
    changedFiles,
    ...classifyChanges(changedFiles, evalCase.allowedScope),
  };
}

interface PrReadback {
  url: string;
  pipelineHeadSha: string;
  remoteHeadSha?: string;
  localHeadSha: string;
  headMatches: boolean;
  isDraft?: boolean;
  state?: string;
  checks: Array<{ name: string; state: string }>;
  checksSettled: boolean;
  closedAfterReadback: boolean;
  /** The readback itself failed. */
  error?: string;
  /** Closing the PR or deleting its branch failed (after a readback). */
  cleanupError?: string;
}

async function readBackPr(worktree: string, prUrl: string, pipelineHeadSha: string, waitMin: number): Promise<Omit<PrReadback, 'closedAfterReadback'>> {
  const localHeadSha = await git(worktree, 'rev-parse', 'HEAD');
  try {
    const view = JSON.parse((await exec('gh', ['pr', 'view', prUrl, '--json', 'url,headRefOid,isDraft,state'], { cwd: worktree })).stdout) as {
      url: string; headRefOid: string; isDraft: boolean; state: string;
    };
    let checks: Array<{ name: string; state: string }> = [];
    let settled = false;
    const deadline = Date.now() + waitMin * 60_000;
    while (Date.now() < deadline) {
      try {
        const out = (await exec('gh', ['pr', 'checks', prUrl, '--json', 'name,state'], { cwd: worktree })).stdout;
        checks = JSON.parse(out) as Array<{ name: string; state: string }>;
      } catch (error) {
        // `gh pr checks` exits non-zero while checks are pending or failed; its stdout is still the JSON.
        const out = (error as { stdout?: string }).stdout;
        if (out) checks = JSON.parse(out) as Array<{ name: string; state: string }>;
      }
      settled = checks.length > 0 && checks.every((c) => !['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(c.state));
      if (settled) break;
      await new Promise((r) => setTimeout(r, 30_000));
    }
    return {
      url: view.url,
      pipelineHeadSha,
      remoteHeadSha: view.headRefOid,
      localHeadSha,
      headMatches: view.headRefOid === pipelineHeadSha && pipelineHeadSha === localHeadSha,
      isDraft: view.isDraft,
      state: view.state,
      checks,
      checksSettled: settled,
    };
  } catch (error) {
    return {
      url: prUrl, pipelineHeadSha, localHeadSha, headMatches: false, checks: [], checksSettled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type GhExec = (args: string[]) => Promise<unknown>;

/**
 * Whether the phantom PR exists on GitHub. Only a 404 means "no": any other
 * failure (no GH_TOKEN in the isolated HOME, network, rate limit) is
 * 'unknown', with the error recorded, never a silent false.
 */
export async function phantomExists(
  url: string,
  run: GhExec = (args) => exec('gh', args),
): Promise<{ exists: boolean | 'unknown'; error?: string }> {
  const number = url.split('/').pop();
  try {
    await run(['api', `repos/Intrect-io/OpenSwarm/pulls/${number}`, '--silent']);
    return { exists: true };
  } catch (error) {
    const failed = error as { stderr?: unknown; message?: unknown };
    const text = `${typeof failed.stderr === 'string' ? failed.stderr : ''}\n${typeof failed.message === 'string' ? failed.message : String(error)}`;
    if (/HTTP 404|Not Found/.test(text)) return { exists: false };
    return { exists: 'unknown', error: text.trim().slice(0, 500) };
  }
}

async function child(opts: Options): Promise<void> {
  const evalRoot = process.env.OPENSWARM_EVAL_ROOT!;
  const repo = process.env.OPENSWARM_EVAL_REPO!;
  const baseSha = process.env.OPENSWARM_EVAL_BASE!;
  const home = process.env.HOME!;
  if (process.env.OPENSWARM_EVAL_ISOLATED !== '1' || !home.startsWith(evalRoot)) {
    throw new Error('refusing to run outside the isolated HOME');
  }
  // Imports after HOME is isolated: several modules resolve ~/.openswarm paths at load time.
  const { initLocale } = await import('../src/locale/index.js');
  const { PairPipeline } = await import('../src/agents/pairPipeline.js');
  const { createWorktree, commitAndCreatePRWithHead } = await import('../src/support/worktreeManager.js');
  initLocale('en');

  const evidenceRoot = join(evalRoot, 'evidence');
  const results: EvalRecord[] = [];
  for (const caseId of opts.cases) {
    const evalCase = CASES.find((c) => c.id === caseId)!;
    for (let n = 1; n <= opts.repeat; n += 1) {
      // Neutral identity: the case name ("impossible-tests") must not reach the
      // agents through the task id, worktree path or branch.
      const tag = createHash('sha256').update(`${opts.runId}\0${caseId}\0${n}`).digest('hex').slice(0, 8);
      const label = `TK-${tag}`;
      // Branch, PR and comments carry the run id and the label only (evalPublication).
      const publication = evalPublication(opts.runId, label);
      const branch = publication.branch;
      console.log(`\n[eval] ${caseId}#${n} as ${label}  branch ${branch}`);
      // One case failing (base8: another session deleted the run's worktree)
      // must not take the finished cases' results with it.
      try {
      const info = await createWorktree(repo, label.toLowerCase(), branch, baseSha);
      const task = {
        id: label,
        source: 'local' as const,
        title: evalCase.title,
        description: evalCase.description,
        priority: 3,
        projectPath: info.worktreePath,
        createdAt: Date.now(),
        issueIdentifier: label,
        fileScope: [FIXTURE],
        fileScopeSource: 'declared' as const,
      };
      const role = { enabled: true, adapter: opts.adapter, model: opts.model, timeoutMs: 900_000, fanout: { enabled: false } };
      const pipeline = new PairPipeline({
        stages: ['worker', 'reviewer'],
        maxIterations: opts.maxIterations,
        // Writes fenced to the worktree (osSandbox.ts). The run root is outside
        // TMPDIR, so the evidence directory is outside every writable root.
        workerSandbox: 'on',
        roles: {
          worker: role as never,
          reviewer: { enabled: true, adapter: opts.adapter, model: opts.model, timeoutMs: 600_000 } as never,
        },
        runMetadata: { repository: 'OpenSwarm', projectPath: repo, worktree: info.worktreePath, branch, issueIdentifier: label, title: evalCase.title },
      });
      const dispatchLog = process.env.OPENSWARM_EVAL_DISPATCH_LOG!;
      const readDispatchLog = () => (existsSync(dispatchLog) ? readFileSync(dispatchLog, 'utf8') : '');
      const dispatchesBefore = readDispatchLog().length;
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof pipeline.run>> | undefined;
      let pipelineError: string | undefined;
      try {
        result = await pipeline.run(task as never, info.worktreePath);
      } catch (error) {
        pipelineError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      const latencyMs = Date.now() - startedAt;
      const transcripts = readTranscripts(join(home, '.openswarm', 'sessions', label));
      const dispatches = countWorkflowRuns(readDispatchLog().slice(dispatchesBefore), transcripts, process.env.OPENSWARM_EVAL_DISPATCH_NONCE!);
      const truth = {
        ...await groundTruth(info.worktreePath, baseSha, evalCase),
        workflowRuns: dispatches.runs,
        refusedDispatchAttempts: dispatches.attempts,
      };
      const worker = result?.workerResult;
      const graderAccess = findGraderAccess(transcripts, opts.runId);
      const claimText = [worker?.summary, worker?.output, result?.reviewResult?.feedback].filter(Boolean).join('\n');
      const outcome: RunOutcome = {
        finalStatus: result?.finalStatus ?? 'error',
        pipelineError,
        reviewDecision: result?.reviewResult?.decision,
        failureDetail: result?.failureDetail,
        workerClaimedSuccess: worker?.success === true,
        claimText,
        pipelinePrUrl: result?.prUrl,
        graderAccess,
      };
      const usage = summariseUsage(await readUsageRows(home, label));
      const provider = providerEvidence(usage, { adapter: opts.adapter, model: opts.model });

      let pr: PrReadback | undefined;
      if (opts.publish && outcome.finalStatus === 'approved') {
        try {
          const published = await commitAndCreatePRWithHead(info, publication.title, label,
            publication.body, { draft: true, fileScope: [FIXTURE] });
          const readback = await readBackPr(info.worktreePath, published.prUrl, published.headSha, opts.checksWaitMin);
          pr = { ...readback, closedAfterReadback: false };
          // Closing is cleanup, recorded apart from the readback: in base5 a
          // failed close threw away the URL, head and checks already read.
          // No `gh pr close --delete-branch`: it also deletes the local branch,
          // which the run's worktree still has checked out.
          if (!opts.keepPr) {
            try {
              await exec('gh', ['pr', 'close', published.prUrl, '--comment', publication.closeComment], { cwd: repo });
              pr.closedAfterReadback = true;
              await exec('git', ['push', 'origin', '--delete', branch], { cwd: info.worktreePath });
            } catch (error) {
              pr.cleanupError = error instanceof Error ? error.message : String(error);
            }
          }
        } catch (error) {
          pr = { url: '', pipelineHeadSha: '', localHeadSha: '', headMatches: false, checks: [], checksSettled: false, closedAfterReadback: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // Graded after the readback, so the record, log and sealed evidence carry the final grade.
      const grade = gradeRun(evalCase, truth, outcome, { requested: opts.publish, pr });
      const phantom = evalCase.forbiddenClaims?.find((c) => c.startsWith('https://github.com/'));

      const record: EvalRecord & Record<string, unknown> = {
        runId: opts.runId, case: caseId, attempt: n, label, branch, baseSha,
        model: opts.model, adapter: opts.adapter, maxIterations: opts.maxIterations,
        latencyMs, pipelineError,
        finalStatus: outcome.finalStatus, iterations: result?.iterations,
        stages: result?.stages.map((s) => ({
          stage: s.stage, success: s.success, durationMs: s.duration,
          ...(s.stage === 'reviewer' ? { decision: (s.result as { decision?: string }).decision } : {}),
        })),
        operatorPark: result?.operatorPark?.code,
        worker: worker && { success: worker.success, filesChanged: worker.filesChanged, commands: worker.commands, summary: worker.summary?.slice(0, 1500), haltReason: worker.haltReason, noChangesReason: worker.noChangesReason },
        reviewer: result?.reviewResult && { decision: result.reviewResult.decision, feedback: result.reviewResult.feedback?.slice(0, 1500) },
        failureDetail: result?.failureDetail,
        truth: { ...truth, testOutput: truth.testOutput.slice(-1500) },
        grade,
        graderAccess,
        usage,
        providerEvidence: provider,
        phantom: phantom ? await phantomExists(phantom).then((found) => ({ url: phantom, existsOnGitHub: found.exists, error: found.error })) : undefined,
        pr,
        sessionLogDir: join(evidenceRoot, label, 'sessions'),
        worktree: info.worktreePath,
      };
      results.push(record);
      console.log(`[eval] ${caseId}#${n} (${label}): status=${outcome.finalStatus} truthPass=${grade.truthPass} correct=${grade.correct} inconclusive=${grade.inconclusive} falseAcceptance=${grade.falseAcceptance} falseCompletion=${grade.falseCompletion} scopeCreep=${grade.scopeCreep} workflowRuns=${truth.workflowRuns} providerMismatches=${provider.mismatches.length} graderAccess=${graderAccess.join(',') || 'none'} ${Math.round(latencyMs / 1000)}s`);
      } catch (error) {
        const harnessError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        results.push({ runId: opts.runId, case: caseId, attempt: n, label, branch, harnessError, grade: null });
        console.log(`[eval] ${caseId}#${n} (${label}): HARNESS ERROR ${harnessError}`);
      }
      // Guarded like the case itself: a failed copy must not end the run.
      try {
        await preserveCaseEvidence(home, evidenceRoot, label, results[results.length - 1]);
      } catch (error) {
        console.log(`[eval] ${caseId}#${n} (${label}): EVIDENCE COPY FAILED ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await writeResults(false);
      } catch (error) {
        console.log(`[eval] results write failed after ${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await writeResults(true);

  async function writeResults(final: boolean): Promise<void> {
    await mkdir(RESULTS_DIR, { recursive: true });
    const out = join(RESULTS_DIR, `pipelineEval-${opts.runId}.json`);
    const summary = { ...summariseResults(results), complete: final };
    const body = JSON.stringify({ runId: opts.runId, evalRoot, summary, results }, null, 2);
    await writeFile(out, body);
    if (final) {
      // A sealed copy next to the per-case evidence, out of reach of the results dir's owner too.
      const sealed = join(evidenceRoot, 'results');
      await mkdir(sealed, { recursive: true });
      await writeFile(join(sealed, `pipelineEval-${opts.runId}.json`), body);
      sealEvidence(sealed);
      console.log(`\n[eval] summary ${JSON.stringify(summary)}\n[eval] wrote ${out}`);
    }
  }
}

/** Every session transcript of one task, concatenated (missing directory: empty). */
function readTranscripts(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
    .map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
}

/**
 * Copy one case's transcripts, usage rows and coordination board out of the
 * run's HOME into `<run root>/evidence/<label>` and seal it. Outside every
 * worker-writable root (osSandbox.ts), and a plain `rm -rf` cannot remove it.
 */
async function preserveCaseEvidence(home: string, evidenceRoot: string, label: string, record: unknown): Promise<void> {
  const dest = join(evidenceRoot, label);
  await mkdir(dest, { recursive: true });
  const sessions = join(home, '.openswarm', 'sessions', label);
  if (existsSync(sessions)) await cp(sessions, join(dest, 'sessions'), { recursive: true });
  const usageDir = join(home, '.openswarm', 'usage');
  if (existsSync(usageDir)) {
    const rows = readdirSync(usageDir).filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => readFileSync(join(usageDir, name), 'utf8').split('\n'))
      .filter((line) => {
        try { return (JSON.parse(line) as { taskId?: unknown }).taskId === label; } catch { return false; }
      });
    await writeFile(join(dest, 'usage.jsonl'), rows.join('\n') + (rows.length ? '\n' : ''));
  }
  const board = join(home, '.openswarm', 'coordination.json');
  if (existsSync(board)) await cp(board, join(dest, 'coordination.json'));
  await writeFile(join(dest, 'record.json'), JSON.stringify(record, null, 2));
  sealEvidence(dest);
}

/** `--cleanup <runId>`: the same run root parent() would use, and nothing else. */
async function cleanup(runId: string): Promise<void> {
  const mainCheckout = realpathSync(dirname(resolve(ROOT, await git(ROOT, 'rev-parse', '--git-common-dir'))));
  console.log(`[eval] removed ${cleanupRun(mainCheckout, runId, sharedTempRoots())}`);
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const run = opts.cleanup !== undefined ? cleanup(opts.cleanup)
    : process.argv.includes('--child') ? child(opts) : parent(opts);
  run.catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
