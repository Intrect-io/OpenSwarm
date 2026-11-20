// ============================================
// OpenSwarm — a repository-declared coverage command for the coverage ratchet
// ============================================
//
// coverageRatchetGate.ts compares a change's line coverage with its main
// commit's, through a provider seam. This is the production provider: opt-in,
// declared by the repository in its openswarm.json —
//
//   { "coverage": {
//       "command": "npx vitest run --coverage --coverage.reporter=json-summary",
//       "summary": "coverage/coverage-summary.json",
//       "timeoutMs": 600000 } }
//
// The command runs under `sh -c` in the tree being measured and must write an
// istanbul json-summary; the provider reads `total.lines.pct` (falling back to
// `total.statements.pct`). A repository without the key is `unsupported`, and
// the gate records it as skipped.
//
// The configuration is always read from the BASE commit, never from the worker
// tree: a worker that rewrote the command to print 100% would otherwise grade
// itself. The base is measured in a temporary detached worktree; the worker
// worktree is never checked out, reset or stashed.

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { setCoverageProvider, type CoverageMeasurement, type CoverageProvider } from './coverageRatchetGate.js';

const exec = promisify(execFile);

/** Provider id; part of the baseline key together with the command hash. */
export const COVERAGE_COMMAND_PROVIDER_ID = 'repo-command';
export const DEFAULT_COVERAGE_TIMEOUT_MS = 600_000;
/** Output kept for an error message: the tail, where a test runner reports. */
const OUTPUT_TAIL_CHARS = 4_000;
const REPORTED_OUTPUT_CHARS = 600;

const CoverageConfigSchema = z.object({
  command: z.string().min(1),
  summary: z.string().min(1).default('coverage/coverage-summary.json'),
  timeoutMs: z.number().int().positive().max(4 * 60 * 60 * 1000).default(DEFAULT_COVERAGE_TIMEOUT_MS),
});

export type CoverageCommandConfig = z.infer<typeof CoverageConfigSchema>;

type ConfigLookup = { config: CoverageCommandConfig } | { why: string };

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** Parse the `coverage` key of an openswarm.json text. */
export function parseCoverageConfig(raw: string): ConfigLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { why: `openswarm.json is not valid JSON (${(err as Error).message})` };
  }
  const coverage = (parsed as { coverage?: unknown } | null)?.coverage;
  if (coverage === undefined) return { why: 'openswarm.json declares no `coverage` command' };
  const result = CoverageConfigSchema.safeParse(coverage);
  if (!result.success) {
    return { why: `openswarm.json \`coverage\` is invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  const summary = normalize(result.data.summary);
  if (isAbsolute(summary) || summary === '..' || summary.startsWith(`..${sep}`)) {
    return { why: `openswarm.json \`coverage.summary\` must be a path inside the repository, not ${result.data.summary}` };
  }
  return { config: { ...result.data, summary } };
}

/**
 * The coverage configuration as the base commit declares it. Some repositories
 * keep openswarm.json untracked in their main checkout (`openswarm add` writes
 * it there); when the base commit has none, that file is read instead. The
 * worker worktree's copy is never read: the worker could have edited it.
 */
export async function coverageConfigAt(worktreePath: string, baseSha: string): Promise<ConfigLookup> {
  try {
    return parseCoverageConfig(await git(worktreePath, ['show', `${baseSha}:openswarm.json`]));
  } catch {
    // not in the base commit; try the main checkout
  }
  try {
    const commonDir = (await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const mainFile = join(dirname(commonDir), 'openswarm.json');
    if (commonDir && existsSync(mainFile) && realpathSync(dirname(commonDir)) !== realpathSync(worktreePath)) {
      return parseCoverageConfig(readFileSync(mainFile, 'utf8'));
    }
  } catch {
    // no readable main checkout
  }
  return { why: `no openswarm.json at ${baseSha.slice(0, 12)} or in the main checkout` };
}

/** Provider id plus a hash of what is measured, for the baseline key. */
export function coverageConfigIdentity(config: CoverageCommandConfig | null): string {
  if (!config) return `${COVERAGE_COMMAND_PROVIDER_ID}:none`;
  const hash = createHash('sha256').update(JSON.stringify([config.command, config.summary])).digest('hex').slice(0, 16);
  return `${COVERAGE_COMMAND_PROVIDER_ID}:${hash}`;
}

export interface CommandRun {
  code: number | null;
  timedOut: boolean;
  /** The last OUTPUT_TAIL_CHARS of stdout and stderr, interleaved. */
  output: string;
}

/**
 * Run `command` under `sh -c` in `cwd`, in its own process group so a timeout
 * kills the test runner it started too, not only the shell.
 */
export function runCoverageCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandRun> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, output: `${output}\n${err.message}`.slice(-OUTPUT_TAIL_CHARS) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Leave nothing behind the shell: a watcher the command forked would
      // otherwise outlive the measurement.
      killGroup();
      resolve({ code, timedOut, output });
    });
  });
}

/** `total.lines.pct`, else `total.statements.pct`, from an istanbul json-summary. */
export function readSummaryPercent(path: string): number | undefined {
  try {
    const total = (JSON.parse(readFileSync(path, 'utf8')) as { total?: Record<string, { pct?: unknown }> }).total;
    for (const metric of ['lines', 'statements']) {
      const value = total?.[metric]?.pct;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  } catch {
    // unreadable or not JSON: no number
  }
  return undefined;
}

/** Untracked, non-ignored files; null when git cannot list them. */
async function untrackedFiles(tree: string): Promise<Set<string> | null> {
  try {
    const out = await git(tree, ['ls-files', '--others', '--exclude-standard', '-z']);
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/** Delete the untracked files that appeared since `before`, and the directories they leave empty. */
async function removeNewUntracked(tree: string, before: Set<string>): Promise<void> {
  for (const file of await untrackedFiles(tree) ?? []) {
    if (before.has(file)) continue;
    rmSync(join(tree, file), { force: true });
    removeEmptyParents(tree, file);
  }
}

function removeEmptyParents(tree: string, file: string): void {
  for (let dir = dirname(file); dir !== '.' && dir !== ''; dir = dirname(dir)) {
    try {
      rmdirSync(join(tree, dir)); // refuses a non-empty directory
    } catch {
      return;
    }
  }
}

/**
 * Run the configured command in `tree` and read its summary. Only a summary
 * this run wrote counts: a stale or planted one is `unsupported`. With
 * `removeNewFiles`, untracked files the command created are deleted so the
 * coverage output is not committed with the change.
 */
export async function measureTree(tree: string, config: CoverageCommandConfig, removeNewFiles: boolean): Promise<CoverageMeasurement> {
  const summaryPath = join(tree, config.summary);
  const before = existsSync(summaryPath) ? statSync(summaryPath) : null;
  // Without a listing from before the run there is no telling the command's
  // output from the worker's own new files, so nothing is removed.
  const untrackedBefore = removeNewFiles ? await untrackedFiles(tree) : null;
  try {
    const run = await runCoverageCommand(config.command, tree, config.timeoutMs);
    const tail = run.output.trim().slice(-REPORTED_OUTPUT_CHARS);
    if (run.timedOut) return { kind: 'unsupported', why: `the coverage command timed out after ${config.timeoutMs}ms: ${tail}` };
    if (run.code !== 0) return { kind: 'unsupported', why: `the coverage command exited with ${run.code}: ${tail}` };
    if (!existsSync(summaryPath)) return { kind: 'unsupported', why: `the coverage command wrote no ${config.summary}` };
    // ctime cannot be set from userland (touch moves it to now), so a planted
    // file keeps the ctime it had before this run.
    if (before && statSync(summaryPath).ctimeMs <= before.ctimeMs) {
      return { kind: 'unsupported', why: `${config.summary} was not rewritten by the coverage command` };
    }
    const percent = readSummaryPercent(summaryPath);
    if (percent === undefined) return { kind: 'unsupported', why: `${config.summary} has no total.lines.pct or total.statements.pct` };
    return { kind: 'measured', percent };
  } finally {
    if (untrackedBefore) await removeNewUntracked(tree, untrackedBefore);
  }
}

/**
 * A detached checkout of `baseSha` under the OS temp dir, made from the
 * repository `worktreePath` belongs to, removed again when `run` settles. The
 * worker worktree's node_modules is linked in when it has one.
 */
export async function withBaseCheckout<T>(worktreePath: string, baseSha: string, run: (tree: string) => Promise<T>): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), 'openswarm-cov-base-'));
  const tree = join(parent, 'tree');
  try {
    await git(worktreePath, ['worktree', 'add', '--detach', tree, baseSha]);
    const modules = join(worktreePath, 'node_modules');
    const linked = join(tree, 'node_modules');
    if (existsSync(modules) && !existsSync(linked)) symlinkSync(realpathSync(modules), linked, 'dir');
    return await run(tree);
  } finally {
    // Unlink first so nothing that removes the tree can descend into the
    // worker's real node_modules.
    const linked = join(tree, 'node_modules');
    try {
      if (lstatSync(linked).isSymbolicLink()) unlinkSync(linked);
    } catch {
      // not there
    }
    await git(worktreePath, ['worktree', 'remove', '--force', tree]).catch(() => '');
    rmSync(parent, { recursive: true, force: true });
    await git(worktreePath, ['worktree', 'prune']).catch(() => '');
  }
}

/** The opt-in provider: the command a repository's base openswarm.json declares. */
export function repoCommandCoverageProvider(): CoverageProvider {
  return {
    async identity(worktreePath, baseSha) {
      const lookup = await coverageConfigAt(worktreePath, baseSha);
      return coverageConfigIdentity('config' in lookup ? lookup.config : null);
    },
    async measureBase(worktreePath, baseSha) {
      const lookup = await coverageConfigAt(worktreePath, baseSha);
      if (!('config' in lookup)) return { kind: 'unsupported', why: lookup.why };
      return withBaseCheckout(worktreePath, baseSha, (tree) => measureTree(tree, lookup.config, false));
    },
    async measureHead(worktreePath, baseSha) {
      if (!baseSha) return { kind: 'unsupported', why: 'no base commit to read the coverage command from' };
      const lookup = await coverageConfigAt(worktreePath, baseSha);
      if (!('config' in lookup)) return { kind: 'unsupported', why: lookup.why };
      return measureTree(worktreePath, lookup.config, true);
    },
  };
}

/** Install the repo-command provider on the publication path. Called at daemon startup. */
export function registerRepoCommandCoverageProvider(install: (provider: CoverageProvider) => void = setCoverageProvider): CoverageProvider {
  const provider = repoCommandCoverageProvider();
  install(provider);
  return provider;
}
