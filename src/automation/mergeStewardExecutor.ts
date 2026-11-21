// Created: 2026-11-21
// Purpose: merge steward executor, default off — the one place a factory PR merge is written (AGT-4803)
// Dependencies: ./stewardConfig, ./mergeGrant, ./mergeStewardSnapshot, ./mergeStewardGuards, node:child_process, node:fs, node:os, node:path
// Test Status: mergeStewardExecutor.test.ts

/**
 * The only PR merge write in the codebase (a repo-wide static test holds that).
 * Order, every step fail-closed and audited:
 * 1. load the operator's steward config;
 * 2. gates: `mergeEnabled === true`, the steward token env set (never GH_TOKEN,
 *    GITHUB_TOKEN or a gh login), the operator merge grant for the repo;
 * 3. a fresh read-only snapshot, automation accounts from the config only;
 * 4. every guard in `STEWARD_GUARDS` must pass (`evaluateMergeSteward` keeps
 *    refusing `dryRun: false`; this module applies the guards itself);
 * 5. an intent audit line (no write without it);
 * 6. exactly one write: the merge REST call pinned to the snapshot head SHA,
 *    through a separate write runner, with no retry, force, admin or auto-merge;
 * 7. a result audit line.
 * A refusal appends one audit line. A write appends two (intent, result).
 */

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isAmbientGithubTokenEnv, loadStewardConfig, type StewardConfig, type StewardConfigLoad } from './stewardConfig.js';
import { readMergeGrant, type MergeGrantResult } from './mergeGrant.js';
import {
  buildStewardSnapshot,
  createLedgerLookup,
  createVerdictLookup,
  type GhRunner,
  type StewardLedgerLookup,
  type StewardSnapshotResult,
  type StewardVerdictLookup,
} from './mergeStewardSnapshot.js';
import {
  applyStewardGuards,
  formatStewardAudit,
  STEWARD_GUARDS,
  type StewardDecision,
  type StewardGuardResult,
} from './mergeStewardGuards.js';
import { defaultAutomationDbPath } from './automationDbPath.js';

export type StewardMergeStatus = 'merged' | 'refused' | 'infra';

export interface StewardMergeResult {
  status: StewardMergeStatus;
  reason: string;
  repo: string;
  prNumber: number;
  /** Head the write was pinned to; null when no snapshot was taken. */
  headSha: string | null;
  /** `formatStewardAudit` line for this outcome. */
  audit: string;
  /** Guard results, when the guards ran. */
  results?: readonly StewardGuardResult[];
  /** Set when an audit line could not be appended after the outcome was fixed. */
  auditError?: string;
}

/** One JSONL line in the merge audit log. Never carries the token. */
export interface StewardMergeAuditEntry {
  at: string;
  event: 'refused' | 'infra' | 'intent' | 'result';
  repo: string;
  prNumber: number;
  headSha: string | null;
  reason: string;
  audit: string;
  outcome?: 'merged' | 'failed' | 'unknown';
  mergeMethod?: string;
  results?: readonly StewardGuardResult[];
  blockedBy?: readonly string[];
  error?: string;
}

/** Runs one gh write with the steward token; resolves stdout. */
export type StewardWriteRunner = (args: readonly string[], token: string) => Promise<string>;

export interface StewardSnapshotRequest {
  repo: string;
  prNumber: number;
  automationAccounts: readonly string[];
  readGrant: (repo: string) => MergeGrantResult;
}

export interface StewardMergeDeps {
  loadConfig?: () => StewardConfigLoad;
  env?: NodeJS.ProcessEnv;
  readGrant?: (repo: string) => MergeGrantResult;
  /** Read-only gh runner for the default snapshot builder (wrapped in `readOnlyGh` there). */
  gh?: GhRunner;
  ledger?: StewardLedgerLookup;
  verdictLookup?: StewardVerdictLookup;
  /** Replaces the default `buildStewardSnapshot` call. */
  buildSnapshot?: (request: StewardSnapshotRequest) => Promise<StewardSnapshotResult>;
  /** The single merge write; defaults to `runStewardGhWrite`. */
  writeRunner?: StewardWriteRunner;
  appendAudit?: (entry: StewardMergeAuditEntry) => void;
  now?: () => Date;
}

export interface StewardMergeInput {
  repo: string;
  prNumber: number;
  deps?: StewardMergeDeps;
}

/** Context a pre-snapshot gate judges. */
export interface StewardMergeGateContext {
  repo: string;
  config: StewardConfig;
  env: NodeJS.ProcessEnv;
  readGrant: (repo: string) => MergeGrantResult;
}

export interface StewardMergeGate {
  name: 'merge-enabled' | 'steward-token' | 'merge-grant';
  /** Null to pass, else the refusal reason. */
  check(ctx: StewardMergeGateContext): string | null;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The steward token, or null. Only `config.tokenEnv` is read, and never when it
 * names an ambient GitHub token variable (GH_TOKEN, GITHUB_TOKEN, ...): the config
 * loader already rejects those, this holds even for a config built in code.
 */
export function stewardToken(config: StewardConfig, env: NodeJS.ProcessEnv): string | null {
  if (isAmbientGithubTokenEnv(config.tokenEnv)) return null;
  const value = env[config.tokenEnv];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Pre-snapshot gates, in order. `executeStewardMerge` always applies all of them. */
export const STEWARD_MERGE_GATES: readonly StewardMergeGate[] = Object.freeze([
  {
    name: 'merge-enabled',
    check: (ctx: StewardMergeGateContext) =>
      ctx.config.mergeEnabled === true ? null : 'merge steward is disabled (mergeEnabled is not true in the steward config)',
  },
  {
    name: 'steward-token',
    check: (ctx: StewardMergeGateContext) => {
      if (isAmbientGithubTokenEnv(ctx.config.tokenEnv)) {
        return `steward token env ${ctx.config.tokenEnv} is an ambient GitHub token variable; a dedicated steward variable is required`;
      }
      return stewardToken(ctx.config, ctx.env) !== null ? null : `steward token env ${ctx.config.tokenEnv} is unset or empty; there is no ambient fallback`;
    },
  },
  {
    name: 'merge-grant',
    check: (ctx: StewardMergeGateContext) => {
      const grant = ctx.readGrant(ctx.repo);
      return grant.granted === true ? null : `no operator merge grant: ${grant.reason}`;
    },
  },
] satisfies StewardMergeGate[]);

/** The steward merge audit log; `OPENSWARM_STEWARD_MERGE_LOG` overrides. */
export function stewardMergeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENSWARM_STEWARD_MERGE_LOG;
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.openswarm', 'steward', 'merges.jsonl');
}

/** Append one JSONL line; throws when it cannot be written. */
export function appendStewardMergeAudit(entry: StewardMergeAuditEntry, path: string = stewardMergeLogPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * The write runner's env, built from scratch: PATH, HOME, the steward token, an
 * empty gh config dir and no prompts. No inherited GH_* / GITHUB_* variable survives.
 */
export function buildStewardGhEnv(token: string, configDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: base.HOME ?? homedir(),
    GH_TOKEN: token,
    GH_CONFIG_DIR: configDir,
    GH_PROMPT_DISABLED: '1',
  };
}

/** Default write runner: `gh` via execFile (no shell), scratch env, fresh config dir removed after. */
export const runStewardGhWrite: StewardWriteRunner = async (args, token) => {
  const configDir = mkdtempSync(join(tmpdir(), 'osw-steward-gh-'));
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile('gh', [...args], { env: buildStewardGhEnv(token, configDir), shell: false, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}${stderr ? ` (${String(stderr).trim().slice(0, 500)})` : ''}`, { cause: error }));
          else resolve(String(stdout));
        });
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
};

/** The single write's argv: the merge REST call pinned to `headSha`. */
export function stewardMergeArgs(repo: string, prNumber: number, headSha: string, mergeMethod: string): string[] {
  return ['api', '-X', 'PUT', `repos/${repo}/pulls/${prNumber}/merge`, '-f', `sha=${headSha}`, '-f', `merge_method=${mergeMethod}`];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultReadGh(): GhRunner {
  return async (args) => {
    const { ghWithTimeout } = await import('../support/ghPullRequests.js');
    return ghWithTimeout(process.cwd(), 60_000, ...args);
  };
}

function defaultBuildSnapshot(deps: StewardMergeDeps): (request: StewardSnapshotRequest) => Promise<StewardSnapshotResult> {
  return (request) => {
    const dbPath = defaultAutomationDbPath();
    return buildStewardSnapshot({
      repo: request.repo,
      prNumber: request.prNumber,
      gh: deps.gh ?? defaultReadGh(),
      ledger: deps.ledger ?? createLedgerLookup(dbPath),
      verdictLookup: deps.verdictLookup ?? createVerdictLookup(dbPath),
      automationAccounts: request.automationAccounts,
      readGrant: request.readGrant,
    });
  };
}

/** Did the merge endpoint report a merge? */
function parseMergeResponse(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { merged?: unknown } | null)?.merged === true;
  } catch {
    return false;
  }
}

/** Was the write runner killed, signalled or timed out (rather than answered with an error)? */
export function isRunnerInterrupted(err: unknown): boolean {
  // Walks a short `cause` chain (the default runner wraps the execFile error).
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const e = current as { killed?: unknown; signal?: unknown; code?: unknown; cause?: unknown };
    if (e.killed === true) return true;
    if (typeof e.signal === 'string' && e.signal !== '') return true;
    if (e.code === 'ETIMEDOUT' || e.code === 'ABORT_ERR') return true;
    current = e.cause;
  }
  return false;
}

interface MergeWriteOutcome {
  status: StewardMergeStatus;
  reason: string;
  outcome: 'merged' | 'failed' | 'unknown';
  error?: string;
}

/** The one write. Never retried; a thrown error is redacted of the token. */
async function performMergeWrite(
  runner: StewardWriteRunner, args: readonly string[], token: string, prNumber: number, headSha: string,
): Promise<MergeWriteOutcome> {
  try {
    const stdout = await runner(args, token);
    return parseMergeResponse(stdout)
      ? { status: 'merged', reason: `merged PR #${prNumber} at ${headSha}`, outcome: 'merged' }
      : { status: 'infra', reason: 'merge call returned without merged: true; state unknown, not retried', outcome: 'unknown' };
  } catch (err) {
    const message = errorText(err).split(token).join('[redacted]');
    // A killed or timed-out runner may have sent the request: the merge may have
    // landed. That is 'unknown', never 'failed', so nothing reads it as safe to retry.
    if (isRunnerInterrupted(err)) {
      return { status: 'infra', reason: `merge write was interrupted; state unknown, not retried: ${message}`, outcome: 'unknown', error: message };
    }
    return { status: 'infra', reason: `merge write failed, not retried: ${message}`, outcome: 'failed', error: message };
  }
}

/**
 * The executor with an explicit gate list. Exported so a test can prove each gate
 * is load-bearing by removing it; production goes through `executeStewardMerge`,
 * which always passes `STEWARD_MERGE_GATES`.
 */
export async function runStewardMergeWithGates(input: StewardMergeInput, gates: readonly StewardMergeGate[]): Promise<StewardMergeResult> {
  const { repo, prNumber } = input;
  const deps = input.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const append = deps.appendAudit ?? ((entry: StewardMergeAuditEntry) => appendStewardMergeAudit(entry));
  const env = deps.env ?? process.env;
  const readGrant = deps.readGrant ?? ((r: string) => readMergeGrant(r));

  const finish = (
    status: 'refused' | 'infra',
    reason: string,
    extra: { headSha?: string | null; decision?: StewardDecision } = {},
  ): StewardMergeResult => {
    const headSha = extra.headSha ?? null;
    const audit = formatStewardAudit({ prNumber, headSha, results: extra.decision?.results }, repo);
    const result: StewardMergeResult = { status, reason, repo, prNumber, headSha, audit, results: extra.decision?.results };
    try {
      append({
        at: now().toISOString(), event: status, repo, prNumber, headSha, reason, audit,
        results: extra.decision?.results, blockedBy: extra.decision?.blockedBy,
      });
    } catch (err) {
      result.auditError = `could not append the ${status} audit line: ${errorText(err)}`;
    }
    return result;
  };

  if (!REPO_RE.test(repo)) return finish('refused', `repository ${JSON.stringify(repo)} is not owner/name`);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return finish('refused', `PR number ${String(prNumber)} is not a positive integer`);

  let loaded: StewardConfigLoad;
  try {
    loaded = (deps.loadConfig ?? (() => loadStewardConfig()))();
  } catch (err) {
    return finish('refused', `steward config could not be loaded: ${errorText(err)}`);
  }
  const config = loaded.config;
  const ctx: StewardMergeGateContext = { repo, config, env, readGrant };
  for (const gate of gates) {
    let refusal: string | null;
    try {
      refusal = gate.check(ctx);
    } catch (err) {
      refusal = `${gate.name} gate threw: ${errorText(err)}`;
    }
    if (refusal !== null) {
      return finish('refused', gate.name === 'merge-enabled' ? `${refusal} (${loaded.reason})` : refusal);
    }
  }
  const token = stewardToken(config, env);
  if (token === null) return finish('refused', `steward token env ${config.tokenEnv} is unset or empty`);

  let snap: StewardSnapshotResult;
  try {
    const build = deps.buildSnapshot ?? defaultBuildSnapshot(deps);
    snap = await build({ repo, prNumber, automationAccounts: [...config.automationAccounts], readGrant });
  } catch (err) {
    return finish('infra', `cannot take a fresh snapshot: ${errorText(err)}`);
  }
  const { snapshot } = snap;
  const headSha = snapshot.headSha;
  if (snapshot.prNumber !== prNumber) return finish('infra', `snapshot is for PR #${snapshot.prNumber}, not #${prNumber}`, { headSha });
  if (!SHA_RE.test(headSha)) return finish('infra', 'snapshot head is not a full lowercase commit SHA', { headSha });

  const decision = applyStewardGuards(snapshot, STEWARD_GUARDS);
  if (!decision.mergeable) {
    return finish('refused', `guards refused: ${decision.blockedBy.join(' | ')}`, { headSha, decision });
  }

  const audit = formatStewardAudit(decision, repo);
  const base = { repo, prNumber, headSha, audit, results: decision.results, mergeMethod: config.mergeMethod };
  try {
    append({ ...base, at: now().toISOString(), event: 'intent', reason: `merging PR #${prNumber} at ${headSha} (${config.mergeMethod})` });
  } catch (err) {
    return {
      status: 'refused', reason: `intent audit line could not be appended; no write without an audit trail: ${errorText(err)}`,
      repo, prNumber, headSha, audit, results: decision.results,
    };
  }

  const outcome = await performMergeWrite(deps.writeRunner ?? runStewardGhWrite, stewardMergeArgs(repo, prNumber, headSha, config.mergeMethod), token, prNumber, headSha);
  const result: StewardMergeResult = { status: outcome.status, reason: outcome.reason, repo, prNumber, headSha, audit, results: decision.results };
  try {
    append({ ...base, at: now().toISOString(), event: 'result', reason: outcome.reason, outcome: outcome.outcome, error: outcome.error });
  } catch (err) {
    result.auditError = `could not append the result audit line: ${errorText(err)}`;
  }
  return result;
}

/** Merge one PR if, and only if, every gate and guard passes. Default off. */
export function executeStewardMerge(input: StewardMergeInput): Promise<StewardMergeResult> {
  return runStewardMergeWithGates(input, STEWARD_MERGE_GATES);
}
