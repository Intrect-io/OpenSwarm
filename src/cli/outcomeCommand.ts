// ============================================
// OpenSwarm - `openswarm outcome` (AGT-4810)
// ============================================
//
// The operator's way to record the outcomes the daily digest cannot see for
// itself, in the automation database the daemon writes:
//   openswarm outcome defect <issue> --kind revert|hotfix [--at <iso>] [--ref <sha|url>]
//   openswarm outcome wrong-dispatch <issue> --reason <text>
//   openswarm outcome human-minutes <minutes> --kind review|answer|intervention
//     [--at <iso>] [--issue <id>] [--note <text>]
// <issue> is the run's issue id or tracker identifier (AGT-123). The digest
// reads them as the post-merge defect rate (a defect within 7 days of the
// run's recorded merge), the wrong-dispatch rate and merged changes per human
// minute.
//
// human-minutes is strict, and a usage error exits 2 having written nothing
// (the database is not even opened): <minutes> must match /^[1-9][0-9]*$/ and
// be at most 1440; --at must be an ISO date (YYYY-MM-DD, read as 00:00Z) or
// an ISO date-time with Z or an explicit offset (a zone-less time would be
// read in the host's timezone), a real calendar date, and no more than
// HUMAN_MINUTES_FUTURE_SKEW_MS (5 minutes, for clock skew) after now.

import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import {
  DEFECT_KINDS, HUMAN_MINUTES_KINDS, MAX_HUMAN_MINUTES, markWrongDispatchInDb, openOutcomeDb, recordDefectInDb, recordHumanMinutesInDb,
  type DefectKind, type HumanMinutesKind,
} from '../automation/factoryOutcomes.js';
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

/** A malformed command line: exits 2, and nothing was written. */
export class OutcomeUsageError extends Error {
  readonly exitCode = 2;
}

/** How far after now a recorded --at may be: clock skew between hosts, not a forecast. */
export const HUMAN_MINUTES_FUTURE_SKEW_MS = 5 * 60_000;

/** Whole minutes, 1..1440, written as plain digits: no sign, decimals, spaces, exponent or leading zero. */
export function parseHumanMinutes(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw new OutcomeUsageError(`invalid minutes '${raw ?? ''}': give a whole number of minutes from 1 to ${MAX_HUMAN_MINUTES}`);
  }
  const minutes = Number(raw);
  if (minutes > MAX_HUMAN_MINUTES) {
    throw new OutcomeUsageError(`invalid minutes '${raw}': at most ${MAX_HUMAN_MINUTES} (one day) per record`);
  }
  return minutes;
}

const ISO_AT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2})))?$/;

/** A strict ISO date or zoned date-time, as epoch ms; not after now + skew. */
export function parseHumanMinutesAt(raw: string, now: number): number {
  const m = ISO_AT.exec(raw);
  const bad = (why: string) => new OutcomeUsageError(`invalid --at '${raw}': ${why}`);
  if (!m) throw bad('use an ISO date (2026-11-20) or date-time with a zone (2026-11-20T14:30Z, 2026-11-20T23:30+09:00)');
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) throw bad('not a calendar date');
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) throw bad('not a time of day');
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) throw bad('not a timezone offset');
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw bad('not a date');
  if (at > now + HUMAN_MINUTES_FUTURE_SKEW_MS) throw bad(`it is in the future (more than ${HUMAN_MINUTES_FUTURE_SKEW_MS / 60_000} minutes after now)`);
  return at;
}

/** Options as commander hands them: `true` when an option was given without its value. */
export interface HumanMinutesOptions { kind?: string | boolean; at?: string | boolean; issue?: string | boolean; note?: string | boolean }

/**
 * `openswarm outcome human-minutes`. Every argument is validated before the
 * database is opened, so a usage error (OutcomeUsageError, exit 2) writes
 * nothing. `extra`: arguments commander left over (a second positional, an
 * unknown option), which are refused rather than ignored.
 */
export function runHumanMinutesCommand(
  rawMinutes: string | undefined,
  opts: HumanMinutesOptions,
  deps: OutcomeCommandDeps = {},
  extra: string[] = [],
): number {
  if (extra.length > 0) throw new OutcomeUsageError(`unexpected argument(s): ${extra.join(' ')}`);
  const minutes = parseHumanMinutes(rawMinutes);
  const kind = opts.kind as HumanMinutesKind;
  if (!HUMAN_MINUTES_KINDS.includes(kind)) throw new OutcomeUsageError(`--kind must be one of ${HUMAN_MINUTES_KINDS.join(', ')}`);
  for (const name of ['at', 'issue', 'note'] as const) {
    if (opts[name] === true) throw new OutcomeUsageError(`--${name} needs a value`);
  }
  const issue = opts.issue as string | undefined;
  const note = opts.note as string | undefined;
  const now = deps.now ?? Date.now();
  const at = opts.at === undefined ? now : parseHumanMinutesAt(opts.at as string, now);
  if (issue !== undefined && !issue.trim()) throw new OutcomeUsageError('--issue must not be empty');
  return withDb(deps, (db, dbPath) => {
    const row = recordHumanMinutesInDb(db, { kind, minutes, at, issue, note, actor: deps.actor ?? defaultActor() }, now);
    (deps.out ?? console.log)(`Recorded ${row.minutes} ${row.kind} minute(s) at ${new Date(row.at).toISOString()}${row.issueId ? ` for ${row.issueId}` : ''} (${dbPath})`);
    return 0;
  });
}

function exitWith(fn: () => number): void {
  try {
    process.exitCode = fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof OutcomeUsageError ? error.exitCode : 1;
  }
}

export function registerOutcomeCommand(program: Command, deps: OutcomeCommandDeps = {}): void {
  const outcome = program.command('outcome').description('Record run outcomes for the daily factory digest (defects, wrong dispatches, human minutes)');
  outcome
    .command('defect <issue>')
    .description('Link a revert or hotfix to the run whose merge it repairs')
    .requiredOption('--kind <kind>', `One of ${DEFECT_KINDS.join(', ')}`)
    .option('--at <iso>', 'When the revert/hotfix landed (default: now)')
    .option('--ref <ref>', 'The revert/hotfix commit or PR')
    .action((issue: string, opts: { kind?: string; at?: string; ref?: string }) => exitWith(() => runDefectCommand(issue, opts, deps)));
  outcome
    .command('wrong-dispatch <issue>')
    .description('Mark a run "should not have run"')
    .requiredOption('--reason <text>', 'Why it should not have been dispatched')
    .action((issue: string, opts: { reason?: string }) => exitWith(() => runWrongDispatchCommand(issue, opts, deps)));
  // [minutes], optional option values and allowUnknownOption so that every
  // usage error (a missing argument or option value, '-3', an unknown option)
  // reaches the strict parser and exits 2, instead of commander's own exit 1.
  outcome
    .command('human-minutes [minutes]')
    .description('Record time a person spent on the factory (review, answering a question, intervening)')
    .option('--kind [kind]', `Required: one of ${HUMAN_MINUTES_KINDS.join(', ')}`)
    .option('--at [iso]', `When the time was spent: ISO date or zoned date-time, at most ${HUMAN_MINUTES_FUTURE_SKEW_MS / 60_000} min in the future (default: now)`)
    .option('--issue [id]', 'The issue the time was spent on')
    .option('--note [text]', 'A short note')
    .allowUnknownOption()
    .action((minutes: string | undefined, opts: HumanMinutesOptions, cmd: Command) =>
      exitWith(() => runHumanMinutesCommand(minutes, opts, deps, cmd.args.slice(1))));
}
