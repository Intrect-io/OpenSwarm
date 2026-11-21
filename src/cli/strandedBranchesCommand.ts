// ============================================
// OpenSwarm - `openswarm stranded-branches` (AGT-4271)
// ============================================
// Read-only report of local swarm/* branches that carry commits ahead of the
// base ref but do not exist on the base remote. It never fetches, pushes,
// deletes a branch or calls gh: the only remote access is one `git ls-remote
// --heads <base.remote>`. A failed lookup fails closed (every branch counts as
// not on the remote) and the summary says so.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { RunRecord, RunState } from '../automation/runLedger.js';
import { parseRemoteHeads } from '../automation/diskPressureReclaim.js';
import { resolveBaseRef } from '../support/worktreeManager.js';

const execFileAsync = promisify(execFile);

type GitRunner = (repoPath: string, ...args: string[]) => Promise<string>;

export interface StrandedBranchesOptions { path?: string; json?: boolean }

export interface StrandedBranch { branch: string; headSha: string; ahead: number; ledgerState?: RunState; issueId?: string }

export interface StrandedBranchesSummary {
  stranded: StrandedBranch[];
  pushed: string[];
  empty: string[];
  originLookupFailed: boolean;
  baseRef: string;
}

export interface StrandedBranchesLedger { listRuns(): RunRecord[]; close(): void }

export interface StrandedBranchesDeps {
  git?: GitRunner;
  resolveBase?: (repoPath: string) => Promise<{ remote: string; branch: string; ref: string }>;
  lsRemoteHeads?: (repoPath: string, remote: string) => Promise<string>;
  /** Return undefined to skip the run-ledger join. */
  createLedger?: () => StrandedBranchesLedger | undefined | Promise<StrandedBranchesLedger | undefined>;
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
  });
  return stdout;
}

async function openDefaultLedger(): Promise<StrandedBranchesLedger | undefined> {
  try {
    const { RunLedger } = await import('../automation/runLedger.js');
    return new RunLedger();
  } catch {
    return undefined; // the join is optional; the report stands without it
  }
}

export async function runStrandedBranchesCommand(
  opts: StrandedBranchesOptions = {},
  deps: StrandedBranchesDeps = {},
): Promise<StrandedBranchesSummary> {
  const repoPath = resolve(opts.path ?? process.cwd());
  const invokeGit = deps.git ?? git;
  const base = await (deps.resolveBase ?? resolveBaseRef)(repoPath);
  const lsRemote = deps.lsRemoteHeads ?? ((p: string, remote: string) => invokeGit(p, 'ls-remote', '--heads', remote));
  const summary: StrandedBranchesSummary = { stranded: [], pushed: [], empty: [], originLookupFailed: false, baseRef: base.ref };

  const refs = (await invokeGit(repoPath, 'for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/swarm/'))
    .split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => { const [refname, headSha = ''] = line.split('\t'); return { branch: refname.slice('refs/heads/'.length), headSha }; });
  if (refs.length === 0) return summary;

  let remoteHeads = new Set<string>();
  try {
    remoteHeads = parseRemoteHeads(await lsRemote(repoPath, base.remote));
  } catch {
    summary.originLookupFailed = true; // fail closed: nothing counts as pushed
  }

  const runsByBranch = await loadRunsByBranch(repoPath, deps);
  for (const { branch, headSha } of refs) {
    if (remoteHeads.has(branch)) { summary.pushed.push(branch); continue; }
    let ahead: number;
    try {
      ahead = Number.parseInt((await invokeGit(repoPath, 'rev-list', '--count', `${base.ref}..refs/heads/${branch}`)).trim(), 10);
    } catch {
      ahead = Number.NaN; // base ref missing locally: keep the branch visible
    }
    if (ahead === 0) { summary.empty.push(branch); continue; }
    const run = runsByBranch.get(branch);
    summary.stranded.push({
      branch, headSha, ahead: Number.isFinite(ahead) ? ahead : -1,
      ...(run ? { ledgerState: run.state, issueId: run.identifier ?? run.issueId } : {}),
    });
  }
  return summary;
}

async function loadRunsByBranch(repoPath: string, deps: StrandedBranchesDeps): Promise<Map<string, RunRecord>> {
  const byBranch = new Map<string, RunRecord>();
  const ledger = deps.createLedger ? await deps.createLedger() : await openDefaultLedger();
  if (!ledger) return byBranch;
  try {
    for (const run of ledger.listRuns()) {
      if (!run.branchName) continue;
      const sameRepo = resolve(run.projectPath) === repoPath;
      const prior = byBranch.get(run.branchName);
      // listRuns() is updated_at ascending: later rows win unless they would replace a same-repo run.
      if (!prior || sameRepo || resolve(prior.projectPath) !== repoPath) byBranch.set(run.branchName, run);
    }
  } catch {
    /* the join is optional */
  } finally {
    ledger.close();
  }
  return byBranch;
}

export function formatStrandedBranchesSummary(summary: StrandedBranchesSummary): string {
  const total = summary.stranded.reduce((sum, row) => sum + Math.max(row.ahead, 0), 0);
  const lines = [
    `branches_with_commits=${summary.stranded.length} total_commits=${total}`,
    ...summary.stranded.map((row) => [
      `stranded  ${row.branch}  ahead=${row.ahead >= 0 ? row.ahead : '?'}  head=${row.headSha.slice(0, 12)}`,
      row.issueId ? `  issue=${row.issueId}` : '',
      row.ledgerState ? `  state=${row.ledgerState}` : '',
    ].join('')),
    `note: ${summary.baseRef} was not fetched; squash-merged branches deleted from the remote still appear as stranded`,
  ];
  if (summary.originLookupFailed) {
    lines.push('warning: remote lookup (git ls-remote) failed; every branch was treated as not on the remote');
  }
  return lines.join('\n');
}

export function registerStrandedBranchesCommand(
  program: Command,
  deps: StrandedBranchesDeps & { out?: (line: string) => void } = {},
): void {
  program
    .command('stranded-branches')
    .description('List local swarm/* branches with commits that are not on the base remote (read-only)')
    .option('--path <path>', 'Repository path to inspect (default: current directory)')
    .option('--json', 'Emit the summary as JSON')
    .option('--fail-on-stranded', 'Exit 1 when any stranded branch is found')
    .action(async (opts: StrandedBranchesOptions & { failOnStranded?: boolean }) => {
      const out = deps.out ?? console.log;
      try {
        const summary = await runStrandedBranchesCommand(opts, deps);
        out(opts.json ? JSON.stringify(summary) : formatStrandedBranchesSummary(summary));
        if (opts.failOnStranded && summary.stranded.length > 0) process.exitCode = 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
