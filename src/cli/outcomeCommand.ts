// ============================================
// OpenSwarm - `openswarm outcome` (AGT-4810)
// ============================================
//
// The operator's way to record the two outcomes the daily digest cannot see
// for itself, in the automation database the daemon writes:
//   openswarm outcome defect <issue> --kind revert|hotfix [--at <iso>] [--ref <sha|url>]
//   openswarm outcome wrong-dispatch <issue> --reason <text>
// <issue> is the run's issue id or tracker identifier (AGT-123). The digest
// reads them as the post-merge defect rate (a defect within 7 days of the
// run's recorded merge) and the wrong-dispatch rate.

import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import { DEFECT_KINDS, markWrongDispatchInDb, openOutcomeDb, recordDefectInDb, type DefectKind } from '../automation/factoryOutcomes.js';
import { defaultActor, resolveDbPath } from './pauseCommand.js';

export interface OutcomeCommandDeps {
  dbPath?: string;
  actor?: string;
  now?: number;
  out?: (line: string) => void;
}

function withDb<T>(deps: OutcomeCommandDeps, fn: (db: Database.Database, dbPath: string) => T): T {
  const dbPath = deps.dbPath ?? resolveDbPath();
  const db = openOutcomeDb(dbPath);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
  }
}

export function runDefectCommand(issue: string, opts: { kind?: string; at?: string; ref?: string }, deps: OutcomeCommandDeps = {}): number {
  const kind = opts.kind as DefectKind;
  if (!DEFECT_KINDS.includes(kind)) throw new Error(`--kind must be one of ${DEFECT_KINDS.join(', ')}`);
  const now = deps.now ?? Date.now();
  const at = opts.at ? Date.parse(opts.at) : now;
  if (Number.isNaN(at)) throw new Error(`invalid --at '${opts.at}': use an ISO date/time`);
  return withDb(deps, (db, dbPath) => {
    const { issueId } = recordDefectInDb(db, { issue, kind, at, ref: opts.ref, actor: deps.actor ?? defaultActor() }, now);
    (deps.out ?? console.log)(`Recorded ${kind} at ${new Date(at).toISOString()} against run ${issueId} (${dbPath})`);
    return 0;
  });
}

export function runWrongDispatchCommand(issue: string, opts: { reason?: string }, deps: OutcomeCommandDeps = {}): number {
  return withDb(deps, (db, dbPath) => {
    const { issueId } = markWrongDispatchInDb(db, { issue, reason: opts.reason ?? '', actor: deps.actor ?? defaultActor() }, deps.now);
    (deps.out ?? console.log)(`Marked run ${issueId} should-not-have-run (${dbPath})`);
    return 0;
  });
}

function exitWith(fn: () => number): void {
  try {
    process.exitCode = fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function registerOutcomeCommand(program: Command): void {
  const outcome = program.command('outcome').description('Record run outcomes for the daily factory digest (defects, wrong dispatches)');
  outcome
    .command('defect <issue>')
    .description('Link a revert or hotfix to the run whose merge it repairs')
    .requiredOption('--kind <kind>', `One of ${DEFECT_KINDS.join(', ')}`)
    .option('--at <iso>', 'When the revert/hotfix landed (default: now)')
    .option('--ref <ref>', 'The revert/hotfix commit or PR')
    .action((issue: string, opts: { kind?: string; at?: string; ref?: string }) => exitWith(() => runDefectCommand(issue, opts)));
  outcome
    .command('wrong-dispatch <issue>')
    .description('Mark a run "should not have run"')
    .requiredOption('--reason <text>', 'Why it should not have been dispatched')
    .action((issue: string, opts: { reason?: string }) => exitWith(() => runWrongDispatchCommand(issue, opts)));
}
