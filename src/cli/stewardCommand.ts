// Created: 2026-11-21
// Purpose: `openswarm steward --dry-run <pr>` — judge one PR with the merge-steward guards and log the decision (AGT-4803)
// Dependencies: ../automation/mergeStewardSnapshot, ../automation/mergeStewardGuards, ../automation/mergeGrant, ../support/ghPullRequests (read-only via allowlist)
// Test Status: stewardCommand.test.ts

/**
 * The steward's dry run. It reads one PR, runs the guard engine with
 * `dryRun: true`, prints the one-line decision and appends it to a JSONL log.
 * There is no merge path here: the engine throws on `dryRun: false`, and every
 * gh call goes through the snapshot module's read-only allowlist.
 *
 * Every decision also prints and logs one audit line (`formatStewardAudit`):
 * repo, PR, head and ci / review / grant as pass|fail. The grant is read from the
 * operator's grants file only (AGT-4414).
 *
 * Exit codes: 0 for any decision (would merge or would not: both are a
 * successful dry run); 1 for an infrastructure failure — nothing to judge (the
 * PR cannot be read, its head moved), which still prints and logs a REFUSE, or
 * a decision log that cannot be written; 2 for usage errors.
 */

import type { Command } from 'commander';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { GhRunner, StewardLedgerLookup } from '../automation/mergeStewardSnapshot.js';

export interface StewardCommandOptions {
  dryRun?: boolean;
  repo?: string;
  automationAccount?: string[];
  ledger?: string;
}

export interface StewardCommandDeps {
  gh?: GhRunner;
  ledger?: StewardLedgerLookup;
  logPath?: string;
  /** Operator merge grants file; defaults to `defaultMergeGrantsPath()` (OPENSWARM_MERGE_GRANTS or ~/.openswarm). */
  mergeGrantsPath?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
}

/** Where decisions are appended, one JSON object per line. */
export function stewardDecisionLogPath(): string {
  return process.env.OPENSWARM_STEWARD_LOG ?? join(homedir(), '.openswarm', 'steward', 'decisions.jsonl');
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** A PR number or `https://github.com/<owner>/<repo>/pull/<n>` URL, reconciled with `--repo`. */
export function parsePrRef(ref: string, repo?: string): { repo?: string; prNumber: number } {
  if (repo !== undefined && !REPO_RE.test(repo)) throw new Error(`--repo must be owner/name, got ${JSON.stringify(repo)}`);
  const url = ref.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (url) {
    if (repo && repo.toLowerCase() !== url[1].toLowerCase()) {
      throw new Error(`PR URL is in ${url[1]} but --repo says ${repo}`);
    }
    return { repo: url[1], prNumber: Number(url[2]) };
  }
  const num = ref.replace(/^#/, '');
  if (!/^\d+$/.test(num) || Number(num) <= 0) throw new Error(`expected a PR number or GitHub PR URL, got ${JSON.stringify(ref)}`);
  return { repo, prNumber: Number(num) };
}

function defaultGh(): GhRunner {
  return async (args) => {
    const { ghWithTimeout } = await import('../support/ghPullRequests.js');
    return ghWithTimeout(process.cwd(), 60_000, ...args);
  };
}

async function resolveRepo(gh: GhRunner, repo: string | undefined): Promise<string> {
  if (repo) return repo;
  const { readOnlyGh } = await import('../automation/mergeStewardSnapshot.js');
  const raw = await readOnlyGh(gh)(['repo', 'view', '--json', 'nameWithOwner']);
  const name = (JSON.parse(raw) as { nameWithOwner?: unknown }).nameWithOwner;
  if (typeof name !== 'string' || !REPO_RE.test(name)) throw new Error('cannot tell which repository the PR is in; pass --repo owner/name');
  return name;
}

/** Append one decision; false (and a message) when the log cannot be written. */
function appendLog(path: string, entry: Record<string, unknown>, err: (line: string) => void): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return true;
  } catch (error) {
    err(`[steward dry-run] could not append to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Run the command; resolves the exit code. */
export async function runStewardCommand(
  prRef: string | undefined,
  opts: StewardCommandOptions,
  deps: StewardCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  if (!opts.dryRun) {
    err('openswarm steward: only --dry-run is supported; there is no merge path (AGT-4803). Run `openswarm steward --dry-run <pr>`.');
    return 2;
  }
  if (!prRef) {
    err('openswarm steward --dry-run: a PR number or URL is required');
    return 2;
  }
  let parsed: { repo?: string; prNumber: number };
  try {
    parsed = parsePrRef(prRef, opts.repo);
  } catch (error) {
    err(`openswarm steward --dry-run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const logPath = deps.logPath ?? stewardDecisionLogPath();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const gh = deps.gh ?? defaultGh();
  const { buildStewardSnapshot, createLedgerLookup } = await import('../automation/mergeStewardSnapshot.js');
  const { evaluateMergeSteward, formatStewardAudit, formatStewardDecision } = await import('../automation/mergeStewardGuards.js');
  const { readMergeGrant } = await import('../automation/mergeGrant.js');
  const grantsPath = deps.mergeGrantsPath;
  let repo = parsed.repo ?? '';
  try {
    repo = await resolveRepo(gh, parsed.repo);
    let ledger = deps.ledger;
    if (!ledger) {
      const { defaultAutomationDbPath } = await import('../automation/automationDbPath.js');
      ledger = createLedgerLookup(opts.ledger ?? defaultAutomationDbPath());
    }
    const { snapshot, prUrl, notes } = await buildStewardSnapshot({
      repo, prNumber: parsed.prNumber, gh, ledger, automationAccounts: opts.automationAccount ?? [],
      readGrant: (r) => readMergeGrant(r, grantsPath !== undefined ? { path: grantsPath } : {}),
    });
    const decision = evaluateMergeSteward(snapshot, { dryRun: true });
    const line = formatStewardDecision(decision);
    const audit = formatStewardAudit(decision, repo);
    out(line);
    out(audit);
    for (const note of notes) out(`  - ${note}`);
    const logged = appendLog(logPath, { at, repo, prUrl, prNumber: decision.prNumber, headSha: decision.headSha, mergeable: decision.mergeable, dryRun: true, line, audit, results: decision.results, notes }, err);
    return logged ? 0 : 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const line = `[steward dry-run] PR #${parsed.prNumber}: REFUSE — ${reason}`;
    const audit = formatStewardAudit({ prNumber: parsed.prNumber }, repo);
    out(line);
    out(audit);
    appendLog(logPath, { at, repo, prNumber: parsed.prNumber, mergeable: false, dryRun: true, error: reason, line, audit }, err);
    return 1;
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `openswarm steward --dry-run <pr> [--repo owner/name] [--automation-account <login>]... [--ledger <db>]` */
export function registerStewardCommand(program: Command): void {
  program
    .command('steward')
    .description('Merge steward: judge whether a factory PR may be merged (dry run only; never merges)')
    .argument('[pr]', 'PR number or GitHub PR URL')
    .option('--dry-run', 'Required: evaluate the guards and log the decision without merging')
    .option('--repo <owner/name>', 'Repository (default: the PR URL\'s, else the current directory\'s)')
    .option('--automation-account <login>', 'A login the factory acts as; its approvals never count (repeatable)', collect, [])
    .option('--ledger <path>', 'Run ledger database to read evidence from (default: the automation database)')
    .action(async (pr: string | undefined, opts: StewardCommandOptions) => {
      process.exitCode = await runStewardCommand(pr, opts);
    });
}
