// ============================================
// OpenSwarm - `openswarm drain-parks` (AGT-4124)
// ============================================
// Backfill draft PRs for committed branches created before publish-on-park.
// This is intentionally a one-shot operator command, never a daemon sweep:
// old parked rows have no executor lease, so a live runner must remain the
// only writer for newly parked work.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { RunLedger } from '../automation/runLedger.js';
import type { RunRecord, RunState } from '../automation/runLedger.js';
import { attachParkedPublication, recordParkedPublicationSkip } from '../automation/runLedgerParkedPublication.js';
import { resolveBaseRef } from '../support/worktreeManager.js';
import { gh } from '../support/ghPullRequests.js';

const execFileAsync = promisify(execFile);

export interface DrainParksOptions {
  path?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface DrainParksSummary {
  attached: Array<{ issueId: string; branchName: string; prUrl: string }>;
  skipped: Array<{ issueId: string; branchName?: string; reason: string }>;
  failed: Array<{ issueId: string; branchName?: string; reason: string }>;
}

export interface DrainParksLedger {
  listRuns(states?: readonly RunState[]): RunRecord[];
  attachParkedPublication(expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'branchName'>, publication: { prUrl: string; headSha: string }): boolean;
  recordParkedPublicationSkip(expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'branchName'>, reason: string): boolean;
  close(): void;
}

export interface DrainParksDeps {
  createLedger?: () => DrainParksLedger;
  resolveBase?: (repoPath: string) => Promise<{ remote: string; branch: string; ref: string }>;
  git?: (repoPath: string, ...args: string[]) => Promise<string>;
  gh?: (repoPath: string, ...args: string[]) => Promise<string>;
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { timeout: 5 * 60_000 });
  return stdout;
}

function draftBody(run: RunRecord): string {
  const identifier = run.identifier ?? run.issueId;
  return [
    '## Backfilled parked work',
    '',
    'This draft was created by `openswarm drain-parks` for committed work that',
    'predated publish-on-park. It has not been reviewed and remains a draft.',
    '',
    '## Linear',
    `Closes ${identifier}`,
  ].join('\n');
}

function isCandidate(run: RunRecord, repoPath: string): boolean {
  return run.state === 'NEEDS_HUMAN'
    && resolve(run.projectPath) === repoPath
    && !!run.branchName
    && !run.prUrl
    && !run.ownerInstanceId
    && !run.leaseToken;
}

async function findOrCreateDraft(
  repoPath: string,
  base: { branch: string },
  run: RunRecord,
  invokeGh: (repoPath: string, ...args: string[]) => Promise<string>,
): Promise<string> {
  const branchName = run.branchName!;
  const existing = (await invokeGh(repoPath, 'pr', 'list', '--head', branchName, '--state', 'open', '--json', 'url', '--jq', '.[0].url')).trim();
  if (existing) return existing;
  try {
    return (await invokeGh(
      repoPath, 'pr', 'create', '--head', branchName, '--base', base.branch,
      '--title', run.title ?? branchName, '--body', draftBody(run), '--draft',
    )).trim();
  } catch (error) {
    // A concurrent operator can win after our first list. Artifact truth wins.
    const raced = (await invokeGh(repoPath, 'pr', 'list', '--head', branchName, '--state', 'open', '--json', 'url', '--jq', '.[0].url')).trim();
    if (raced) return raced;
    throw error;
  }
}

export async function runDrainParksCommand(
  opts: DrainParksOptions = {},
  deps: DrainParksDeps = {},
): Promise<DrainParksSummary> {
  const repoPath = resolve(opts.path ?? process.cwd());
  const ownedLedger = deps.createLedger ? undefined : new RunLedger();
  const ledger = deps.createLedger?.() ?? {
    listRuns: (states?: readonly RunState[]) => ownedLedger!.listRuns(states),
    attachParkedPublication: (expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'branchName'>, publication: { prUrl: string; headSha: string }) => attachParkedPublication(ownedLedger!, expected, publication),
    recordParkedPublicationSkip: (expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'branchName'>, reason: string) => recordParkedPublicationSkip(ownedLedger!, expected, reason),
    close: () => ownedLedger!.close(),
  };
  const invokeGit = deps.git ?? git;
  const invokeGh = deps.gh ?? gh;
  const resolveBase = deps.resolveBase ?? resolveBaseRef;
  const summary: DrainParksSummary = { attached: [], skipped: [], failed: [] };
  try {
    const base = await resolveBase(repoPath);
    await invokeGit(repoPath, 'fetch', base.remote, '--prune');
    for (const run of ledger.listRuns(['NEEDS_HUMAN'])) {
      if (!isCandidate(run, repoPath)) continue;
      const branchName = run.branchName!;
      const branchRef = `${base.remote}/${branchName}`;
      let ahead: number;
      try {
        ahead = Number.parseInt((await invokeGit(repoPath, 'rev-list', '--count', `${base.ref}..${branchRef}`)).trim(), 10);
      } catch {
        summary.skipped.push({ issueId: run.issueId, branchName, reason: 'remote branch is missing' });
        if (!opts.dryRun) ledger.recordParkedPublicationSkip(run, 'remote branch is missing');
        continue;
      }
      if (!Number.isFinite(ahead) || ahead <= 0) {
        summary.skipped.push({ issueId: run.issueId, branchName, reason: 'no commits ahead of base' });
        if (!opts.dryRun) ledger.recordParkedPublicationSkip(run, 'no commits ahead of base');
        continue;
      }
      try {
        const headSha = (await invokeGit(repoPath, 'rev-parse', branchRef)).trim();
        const prUrl = opts.dryRun
          ? `would-create-draft-for:${branchName}`
          : await findOrCreateDraft(repoPath, base, run, invokeGh);
        if (!opts.dryRun && !ledger.attachParkedPublication(run, { prUrl, headSha })) {
          summary.failed.push({ issueId: run.issueId, branchName, reason: 'park changed while attaching its PR' });
          continue;
        }
        summary.attached.push({ issueId: run.issueId, branchName, prUrl });
      } catch (error) {
        summary.failed.push({ issueId: run.issueId, branchName, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return summary;
  } finally {
    ledger.close();
  }
}

export function formatDrainParksSummary(summary: DrainParksSummary): string {
  const lines = [
    `attached=${summary.attached.length} skipped=${summary.skipped.length} failed=${summary.failed.length}`,
    ...summary.attached.map((row) => `attached  ${row.issueId}  ${row.prUrl}`),
    ...summary.skipped.map((row) => `skipped   ${row.issueId}  ${row.reason}`),
    ...summary.failed.map((row) => `failed    ${row.issueId}  ${row.reason}`),
  ];
  return lines.join('\n');
}
