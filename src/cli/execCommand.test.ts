// ============================================
// OpenSwarm — `openswarm exec` deploy/status/await/answer (INT-3XXX)
// ============================================
//
// One contract, four commands: `exec --issue` deploys a Linear issue's worker
// pipeline and returns the run id, `status`/`await` read the durable run
// read-only (no daemon, no writes, no schema migration), and `answer` writes the
// orchestrator's reply to the coordination board, resumes the ledger row and
// redeploys. The pieces pinned here are the ones a regression would be silent
// about:
//
//   - the await verdict partitions every run state (driven off the exported
//     arrays, so the lists and the test cannot drift apart);
//   - the read side reads rows and pending questions straight out of the
//     automation database, and a question with no class fails closed to
//     'approval' (an unclassified ask is not a clarification);
//   - the exec hold is written BEFORE anything is deployed, and a hold that
//     cannot be written aborts the deploy (fail closed: a run deployed without
//     its hold is one idle_fill will steal);
//   - an HTTP refusal from the daemon (403/500) is surfaced as-is and never
//     retried as a local child, which would go around the daemon's own
//     allowedProjects boundary;
//   - a daemon that is up but refusing its own health probe (401/403/503) is a
//     refusal, not unreachability — never a local-child fallback — while a
//     genuinely absent daemon is, and the legacy boolean probe still means down;
//   - a daemon that answers 202 having queued nothing is a refusal (exit 2),
//     distinct from a deploy that failed (exit 1);
//   - `answer` admits only the input-park states (NEEDS_RECONCILE is an
//     elevation but not answerable with no correlation), and binds a given
//     correlation to THIS run before writing anything to the board;
//   - `answer` answers → resumes → re-marks the hold → redeploys, in that
//     order, and refuses to redeploy when the ledger could not be resumed.
//
// Every dependency that could reach the network, the real `~/.openswarm`, or a
// daemon is injected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// The default transport (probe -> /api/work -> detached child) is the effectful
// edge every other test injects around. Only `spawn` and the `dist/cli.js`
// existence check are replaced, so those tests still run the real code path
// without starting a worker or depending on whether this checkout was built.
const spawnMock = vi.hoisted(() => vi.fn());
const distEntry = vi.hoisted(() => ({ exists: true }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).endsWith(join('dist', 'cli.js')) ? distEntry.exists : actual.existsSync(path),
  };
});

import type { LinearIssueInfo, SwarmConfig } from '../core/types.js';
import type { RepoMetadata } from '../support/repoMetadata.js';
import { RunLedger, RUN_STATES } from '../automation/runLedger.js';
import { OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
import { WORK_ALREADY_QUEUED_REASON } from '../automation/workRunner.js';
import {
  ANSWERABLE_STATES,
  AWAIT_ELEVATION_STATES,
  AWAIT_TERMINAL_STATES,
  buildExecElevation,
  classifyRunForAwait,
  readExecRunRow,
  readPendingExecQuestions,
  runExecAnswerCommand,
  runExecAwaitCommand,
  runExecDeployCommand,
  runExecStatusCommand,
  type AnswerLedger,
  type ExecCommandDeps,
} from './execCommand.js';

const UUID_MAIN = 'uuid-1';
const UUID_DONE = 'uuid-done';
const UUID_READY = 'uuid-ready';
const REPO = '/repo';

let dir: string;
let dbPath: string;
let repoPath: string;
let notGitPath: string;
const ORIGINAL_DB_ENV = process.env.OPENSWARM_AUTOMATION_DB;
const ORIGINAL_ACTOR_ENV = process.env.OPENSWARM_EXEC_ACTOR;

/** A real git-shaped repo dir (the gate is `existsSync(join(repoPath, '.git'))`). */
function makeRepo(name: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

// ---- Fixtures ----------------------------------------------------------------

function issue(overrides: Partial<LinearIssueInfo> = {}): LinearIssueInfo {
  return {
    id: UUID_MAIN,
    identifier: 'INT-1',
    title: 't',
    state: 'Todo',
    priority: 2,
    labels: [],
    comments: [],
    project: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

function metadata(projectId: string | undefined): RepoMetadata {
  return {
    schemaVersion: 1,
    ...(projectId ? { linear: { projectId } } : {}),
  } as unknown as RepoMetadata;
}

/**
 * Seed the durable ledger: one run parked in NEEDS_HUMAN under the operator
 * question park (the state `exec await` elevates on), one terminal DONE run, and
 * one READY run.
 *
 * The park is reached by a real claim → transition chain rather than a raw SQL
 * write, so the row it produces is one the production write path can produce.
 * `importRun` seeds DONE because `transition` cannot: every path out of
 * PUBLISHING that leads to DONE releases the lease first, so the claim fence
 * refuses the final hop.
 */
function seedLedger(): void {
  const ledger = new RunLedger(dbPath);
  try {
    ledger.registerRun({
      issueId: UUID_MAIN,
      source: 'linear',
      identifier: 'INT-1',
      title: 't',
      projectPath: REPO,
    });
    const claim = ledger.claimRun(UUID_MAIN, { ownerInstanceId: 'test-owner', leaseMs: 60_000 });
    if (!claim) throw new Error('fixture: claimRun returned null');
    if (!ledger.transition(claim, 'EXECUTING')) throw new Error('fixture: CLAIMED → EXECUTING rejected');
    if (!ledger.transition(claim, 'NEEDS_HUMAN', {
      branchName: 'openswarm/int-1',
      worktreePath: `${REPO}/.worktrees/int-1`,
      prUrl: 'https://example.invalid/pr/1',
      errorCode: OPERATOR_QUESTION_PARK_REASON,
      errorMessage: 'The worker asked the operator a question',
    })) throw new Error('fixture: EXECUTING → NEEDS_HUMAN rejected');

    // A terminal row, driven through the whole real write path: EXECUTING →
    // SYNC_PENDING → DONE is how the ledger actually finishes a published run
    // (`transition` alone cannot reach DONE — SYNC_PENDING releases the lease,
    // and `finalizeSyncedRun` is what closes a synchronized run with no
    // outstanding effects).
    ledger.registerRun({
      issueId: UUID_DONE,
      source: 'linear',
      identifier: 'INT-9',
      title: 'done thing',
      projectPath: REPO,
    });
    const doneClaim = ledger.claimRun(UUID_DONE, { ownerInstanceId: 'test-owner', leaseMs: 60_000 });
    if (!doneClaim) throw new Error('fixture: claimRun (done) returned null');
    if (!ledger.transition(doneClaim, 'EXECUTING')) throw new Error('fixture: CLAIMED → EXECUTING (done) rejected');
    if (!ledger.transition(doneClaim, 'SYNC_PENDING', { prUrl: 'https://example.invalid/pr/9' })) {
      throw new Error('fixture: EXECUTING → SYNC_PENDING rejected');
    }
    if (!ledger.finalizeSyncedRun(UUID_DONE)) throw new Error('fixture: SYNC_PENDING → DONE rejected');

    ledger.registerRun({
      issueId: UUID_READY,
      source: 'linear',
      identifier: 'INT-2',
      title: 'ready thing',
      projectPath: REPO,
    });
  } finally {
    ledger.close();
  }
}

/**
 * Seed one parked run per answerable state, each reached through the real write
 * path (`registerRun` → `claimRun` → `transition` to EXECUTING → the park
 * state), so `answer`'s whitelist is read against rows the production ledger can
 * actually produce. `RETRY_AT` comes from `deferUnclaimedRun`, which is the
 * unclaimed path that state exists for.
 *
 * `NEEDS_RECONCILE` is the one that must NOT be admitted with no correlation:
 * it is an elevation (the orchestrator should see it) but not an input park,
 * and forcing it to READY skips artifact reconciliation. `RETRY_AT` and the two
 * spec/env parks are admitted as bare resumes (the operator forcing a retry).
 */
function seedAnswerableRuns(): Record<typeof ANSWERABLE_STATES[number] | 'NEEDS_RECONCILE', string> {
  const ledger = new RunLedger(dbPath);
  const ids: Record<string, string> = {};
  try {
    const park = (issueId: string, identifier: string, state: 'NEEDS_SPEC' | 'NEEDS_ENV' | 'NEEDS_RECONCILE'): void => {
      ledger.registerRun({ issueId, source: 'linear', identifier, title: identifier, projectPath: REPO });
      const claim = ledger.claimRun(issueId, { ownerInstanceId: 'test-owner', leaseMs: 60_000 });
      if (!claim) throw new Error(`fixture: claimRun (${identifier}) returned null`);
      if (!ledger.transition(claim, 'EXECUTING')) throw new Error(`fixture: ${identifier} CLAIMED → EXECUTING rejected`);
      if (!ledger.transition(claim, state)) throw new Error(`fixture: ${identifier} EXECUTING → ${state} rejected`);
      ids[state] = issueId;
    };
    park('uuid-needs-spec', 'INT-11', 'NEEDS_SPEC');
    park('uuid-needs-env', 'INT-12', 'NEEDS_ENV');
    park('uuid-needs-reconcile', 'INT-13', 'NEEDS_RECONCILE');

    ledger.registerRun({ issueId: 'uuid-retry', source: 'linear', identifier: 'INT-14', title: 'retry', projectPath: REPO });
    if (!ledger.deferUnclaimedRun('uuid-retry', Date.now() + 60_000, 'flaky infrastructure')) {
      throw new Error('fixture: defer rejected');
    }
    ids.RETRY_AT = 'uuid-retry';
    // NEEDS_HUMAN is already seeded as UUID_MAIN by `seedLedger`.
    ids.NEEDS_HUMAN = UUID_MAIN;
  } finally {
    ledger.close();
  }
  return ids as Record<typeof ANSWERABLE_STATES[number] | 'NEEDS_RECONCILE', string>;
}

/** The `coordination_trace` DDL, verbatim from `coordinationTrace.ts`'s migrate(). */
const TRACE_DDL = `
  CREATE TABLE IF NOT EXISTS coordination_trace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    board_seq INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    repository TEXT NOT NULL,
    repo_key TEXT,
    task_id TEXT NOT NULL,
    task_label TEXT,
    source_task_id TEXT,
    source_task_label TEXT,
    target_task_id TEXT,
    target_task_label TEXT,
    actor TEXT NOT NULL,
    actor_name TEXT,
    actor_role TEXT,
    recipient TEXT,
    recipient_name TEXT,
    recipient_role TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    metadata_json TEXT,
    fingerprint TEXT NOT NULL
  );
`;

interface TraceSeed {
  correlationId: string;
  taskId: string;
  kind: 'human-question' | 'human-answer';
  status: 'waiting' | 'running' | 'completed';
  summary: string;
  metadataJson?: string | null;
}

/**
 * Seed the coordination board rows the run is stopped on.
 *
 *   hq-a  waiting, classed clarification        -> pending
 *   hq-b  waiting, answered by a completed row  -> NOT pending
 *   hq-c  running, metadata not even JSON       -> pending, fails closed to approval
 *   hq-f  waiting, no metadata at all           -> pending, fails closed to approval
 *   hq-z  waiting, but a DIFFERENT task         -> NOT pending here
 */
const TRACE_SEEDS: TraceSeed[] = [
  { correlationId: 'hq-a', taskId: UUID_MAIN, kind: 'human-question', status: 'waiting', summary: 'Which branch should I use?', metadataJson: '{"questionClass":"clarification"}' },
  { correlationId: 'hq-b', taskId: UUID_MAIN, kind: 'human-question', status: 'waiting', summary: 'Ship it?', metadataJson: '{"questionClass":"approval"}' },
  { correlationId: 'hq-b', taskId: UUID_MAIN, kind: 'human-answer', status: 'completed', summary: 'yes, ship it' },
  { correlationId: 'hq-c', taskId: UUID_MAIN, kind: 'human-question', status: 'running', summary: 'Deploy where?', metadataJson: '{not json' },
  { correlationId: 'hq-f', taskId: UUID_MAIN, kind: 'human-question', status: 'waiting', summary: 'Anything else?', metadataJson: null },
  { correlationId: 'hq-z', taskId: 'uuid-other', kind: 'human-question', status: 'waiting', summary: 'Someone else’s question' },
];

function seedTrace(seeds: readonly TraceSeed[] = TRACE_SEEDS): void {
  const db = new Database(dbPath);
  try {
    db.exec(TRACE_DDL);
    const insert = db.prepare(`
      INSERT INTO coordination_trace(
        event_id, board_seq, timestamp, repository, task_id, actor,
        kind, status, correlation_id, summary, metadata_json, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    seeds.forEach((seed, index) => {
      insert.run(
        `evt-${index}`,
        index + 1,
        1_700_000_000_000 + index,
        'openswarm',
        seed.taskId,
        'worker',
        seed.kind,
        seed.status,
        seed.correlationId,
        seed.summary,
        seed.metadataJson ?? null,
        `fp-${index}`,
      );
    });
  } finally {
    db.close();
  }
}

// ---- Injected deps -----------------------------------------------------------

type TestDeps = ExecCommandDeps & { outs: string[]; logs: string[] };

function baseDeps(overrides: Partial<ExecCommandDeps> = {}): TestDeps {
  const outs: string[] = [];
  const logs: string[] = [];
  const deps: ExecCommandDeps = {
    loadConfig: () => ({}) as unknown as SwarmConfig,
    setAutomationDbPath: () => undefined,
    actor: 'external:test',
    ensureTaskSource: async () => ({}),
    getIssue: async (id) => issue({ id, identifier: id }),
    out: (line) => outs.push(line),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return Object.assign(deps, { outs, logs });
}

const CLAIM_STAMP = 7;
const HELD_STAMP = 9;
const freshClaim = () => ({ wasHeld: false, stamp: CLAIM_STAMP });

/** Deps that get a deploy past every gate: metadata mapped, issue deployable. */
function deployDeps(overrides: Partial<ExecCommandDeps> = {}): TestDeps {
  return baseDeps({
    isGitRepo: () => true,
    loadRepoMetadata: async () => metadata('proj-1'),
    getIssue: async () => issue(),
    daemonHealthy: async () => true,
    postWork: async () => ({ status: 202, body: { workId: 'w', items: [{ status: 'queued' }], queued: 1, skipped: 0 } }),
    // Hermetic: no hold exists beforehand and releasing one touches no store, unless a test says otherwise.
    claimHold: freshClaim,
    releaseHold: () => undefined,
    ...overrides,
  });
}

function fakeLedger(overrides: Partial<AnswerLedger> = {}): AnswerLedger {
  return {
    resumeNeedsHumanForQuestions: () => null,
    readmitParkedRun: () => false,
    markReady: () => false,
    close: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openswarm-execcmd-'));
  dbPath = join(dir, 'automation.db');
  repoPath = makeRepo('repo');
  notGitPath = join(dir, 'plain');
  mkdirSync(notGitPath, { recursive: true });
  process.env.OPENSWARM_AUTOMATION_DB = dbPath;
  delete process.env.OPENSWARM_EXEC_ACTOR;
  seedLedger();
  seedTrace();
});

afterEach(() => {
  if (ORIGINAL_DB_ENV === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
  else process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL_DB_ENV;
  if (ORIGINAL_ACTOR_ENV === undefined) delete process.env.OPENSWARM_EXEC_ACTOR;
  else process.env.OPENSWARM_EXEC_ACTOR = ORIGINAL_ACTOR_ENV;
  rmSync(dir, { recursive: true, force: true });
});

// ---- A. Classification -------------------------------------------------------

describe('classifyRunForAwait', () => {
  it('elevates on every exported elevation state', () => {
    for (const state of AWAIT_ELEVATION_STATES) {
      expect(classifyRunForAwait(state), `${state} must elevate`).toBe('elevation');
    }
  });

  it('finishes on every exported terminal state', () => {
    for (const state of AWAIT_TERMINAL_STATES) {
      expect(classifyRunForAwait(state), `${state} must be terminal`).toBe('terminal');
    }
  });

  it('keeps waiting through every state that is still moving', () => {
    const moving = [
      'READY', 'CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING',
      'SYNC_PENDING', 'RETRY_AT', 'WAITING_EXTERNAL', 'DISCOVERED',
    ];
    for (const state of moving) {
      expect(classifyRunForAwait(state), `${state} must be pending`).toBe('pending');
    }
  });

  it('treats an unknown state as pending — it is not evidence the run stopped', () => {
    expect(classifyRunForAwait('WHAT')).toBe('pending');
    expect(classifyRunForAwait('')).toBe('pending');
  });

  it('partitions every run state, and is not case-insensitive by accident', () => {
    for (const state of RUN_STATES) {
      expect(['elevation', 'terminal', 'pending']).toContain(classifyRunForAwait(state));
    }
    const covered = new Set<string>([...AWAIT_ELEVATION_STATES, ...AWAIT_TERMINAL_STATES]);
    for (const state of covered) expect(RUN_STATES as readonly string[]).toContain(state);
    expect(classifyRunForAwait('needs_human')).toBe('pending');
  });
});

// ---- B. Read-only row + questions -------------------------------------------

describe('readExecRunRow', () => {
  it('returns the durable row exactly as the fixture wrote it', () => {
    const row = readExecRunRow(dbPath, UUID_MAIN);
    expect(row).toMatchObject({
      issueId: UUID_MAIN,
      identifier: 'INT-1',
      title: 't',
      state: 'NEEDS_HUMAN',
      attemptNo: 1,
      branchName: 'openswarm/int-1',
      worktreePath: `${REPO}/.worktrees/int-1`,
      lastErrorCode: OPERATOR_QUESTION_PARK_REASON,
      lastErrorMessage: 'The worker asked the operator a question',
      prUrl: 'https://example.invalid/pr/1',
    });
    expect(row?.retryAt).toBeUndefined();
    expect(row?.updatedAt).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown id and for a database that does not exist', () => {
    expect(readExecRunRow(dbPath, 'uuid-nope')).toBeUndefined();
    expect(readExecRunRow(join(dir, 'missing.db'), UUID_MAIN)).toBeUndefined();
  });

  it('does not create the database it cannot find', () => {
    const missing = join(dir, 'never-created.db');
    expect(readExecRunRow(missing, UUID_MAIN)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });

  it('reads a terminal run', () => {
    const row = readExecRunRow(dbPath, UUID_DONE);
    expect(row).toMatchObject({ state: 'DONE', identifier: 'INT-9' });
  });
});

describe('readPendingExecQuestions', () => {
  it('returns only this task’s unanswered questions, waiting and running alike', () => {
    const questions = readPendingExecQuestions(dbPath, UUID_MAIN);
    expect(questions.map((question) => question.correlationId)).toEqual(['hq-a', 'hq-c', 'hq-f']);
    expect(questions.find((question) => question.correlationId === 'hq-a')?.question).toBe('Which branch should I use?');
  });

  it('fails closed to approval: an unclassed or unparseable question is not a clarification', () => {
    const byId = new Map(readPendingExecQuestions(dbPath, UUID_MAIN).map((question) => [question.correlationId, question]));
    expect(byId.get('hq-a')?.questionClass).toBe('clarification');
    expect(byId.get('hq-c')?.questionClass).toBe('approval');
    expect(byId.get('hq-f')?.questionClass).toBe('approval');
  });

  it('reports a paged question once: the "operator paged" confirmation is not a second question', () => {
    // postHumanQuestionOnce publishes the `waiting` ask and then, once Discord delivered the page, a
    // `running` event under the SAME correlation id with the marker as its summary and no class.
    const pagedDb = join(dir, 'paged.db');
    const original = dbPath;
    dbPath = pagedDb;
    try {
      seedTrace([
        { correlationId: 'hq-p', taskId: UUID_MAIN, kind: 'human-question', status: 'waiting', summary: 'Which branch?', metadataJson: '{"questionClass":"clarification"}' },
        { correlationId: 'hq-p', taskId: UUID_MAIN, kind: 'human-question', status: 'running', summary: 'Operator paged on Discord', metadataJson: null },
      ]);
      expect(readPendingExecQuestions(pagedDb, UUID_MAIN)).toEqual([
        { correlationId: 'hq-p', question: 'Which branch?', questionClass: 'clarification' },
      ]);
    } finally {
      dbPath = original;
    }
  });

  it('reads no questions for a task that has none', () => {
    expect(readPendingExecQuestions(dbPath, 'uuid-unknown')).toEqual([]);
  });

  it('returns [] when the database has no coordination_trace table at all', () => {
    const runsOnly = join(dir, 'runs-only.db');
    const ledger = new RunLedger(runsOnly);
    try {
      ledger.registerRun({ issueId: UUID_MAIN, source: 'linear', identifier: 'INT-1', title: 't', projectPath: REPO });
    } finally {
      ledger.close();
    }
    expect(readPendingExecQuestions(runsOnly, UUID_MAIN)).toEqual([]);
  });
});

// ---- C. Deploy ---------------------------------------------------------------

describe('runExecDeployCommand', () => {
  it('refuses a directory that is not a git repository, before writing any hold', async () => {
    const order: string[] = [];
    const deps = deployDeps({
      isGitRepo: undefined, // exercise the real `existsSync(join(path, '.git'))` gate
      claimHold: () => { order.push('hold'); return freshClaim(); },
      postWork: async () => { order.push('deploy'); return { status: 202, body: { queued: 1 } }; },
      spawnWorkChild: () => { order.push('spawn'); return { ok: true }; },
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: notGitPath, json: true }, deps);
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/Not a git repository/);
    expect(order).toEqual([]);
    expect(deps.outs).toEqual([]);
  });

  it('refuses a repo with no Linear project mapping', async () => {
    const claimHold = vi.fn(freshClaim);
    const deps = deployDeps({ loadRepoMetadata: async () => metadata(undefined), claimHold });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/has no Linear project mapping/);
    expect(claimHold).not.toHaveBeenCalled();
  });

  it('refuses a repo whose metadata is absent entirely', async () => {
    const claimHold = vi.fn(freshClaim);
    const deps = deployDeps({ loadRepoMetadata: async () => null, claimHold });
    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath }, deps)).toBe(2);
    expect(claimHold).not.toHaveBeenCalled();
  });

  it('refuses an issue that belongs to a different Linear project', async () => {
    const claimHold = vi.fn(freshClaim);
    const deps = deployDeps({
      getIssue: async () => issue({ project: { id: 'other', name: 'X' } }),
      claimHold,
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/belongs to a different Linear project/);
    expect(claimHold).not.toHaveBeenCalled();
  });

  it('refuses an issue in a skipped workflow state', async () => {
    const claimHold = vi.fn(freshClaim);
    const deps = deployDeps({ getIssue: async () => issue({ state: 'Done' }), claimHold });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/INT-1 is Done — nothing to deploy\./);
    expect(claimHold).not.toHaveBeenCalled();
  });

  it('deploys via a healthy daemon, writing the hold first', async () => {
    const order: string[] = [];
    const claimHold = vi.fn((_issueId: string, _actor: string) => { order.push('hold'); return freshClaim(); });
    const postWork = vi.fn(async (_path: string, _identifier: string) => {
      order.push('deploy');
      return { status: 202, body: { workId: 'w', items: [{ status: 'queued' }], queued: 1, skipped: 0 } };
    });
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const deps = deployDeps({ claimHold, postWork, spawnWorkChild });

    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);

    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toEqual({
      runId: UUID_MAIN,
      identifier: 'INT-1',
      transport: 'daemon',
      deployed: true,
    });
    expect(order).toEqual(['hold', 'deploy']);
    expect(claimHold).toHaveBeenCalledWith(UUID_MAIN, 'external:test');
    expect(postWork).toHaveBeenCalledWith(repoPath, 'INT-1');
    expect(spawnWorkChild).not.toHaveBeenCalled();
  });

  it('prints the follow-up await command for a human', async () => {
    const deps = deployDeps({ claimHold: vi.fn(freshClaim) });
    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath }, deps)).toBe(0);
    expect(deps.outs.join('\n')).toMatch(new RegExp(`Next: openswarm exec await ${UUID_MAIN}`));
    expect(deps.outs.join('\n')).toMatch(/transport: daemon/);
  });

  it.each([403, 500])('surfaces a daemon HTTP %i refusal and never falls back to a child', async (status) => {
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      postWork: async () => ({ status, body: { error: 'not in the daemon allowed projects' } }),
      spawnWorkChild,
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);

    expect(code).toBe(1);
    expect(spawnWorkChild).not.toHaveBeenCalled();
    expect(deps.logs.join('\n')).toMatch(new RegExp(`daemon refused the dispatch \\(HTTP ${status}\\): not in the daemon allowed projects`));
    const out = JSON.parse(deps.outs.join('\n'));
    expect(out).toMatchObject({ runId: UUID_MAIN, transport: 'daemon', deployed: false });
    expect(out.error).toMatch(/not in the daemon allowed projects/);
  });

  it('fails when the daemon answers 202 but queued nothing, quoting its reason', async () => {
    const claimHold = vi.fn(freshClaim);
    const releaseHold = vi.fn();
    const deps = deployDeps({
      claimHold,
      releaseHold,
      postWork: async () => ({ status: 202, body: { items: [{ reason: 'state is In Progress' }], queued: 0, skipped: 1 } }),
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    // 202 + queued 0 is the daemon declining the issue, not a broken deploy:
    // exit 2 (refused before deploying), never 1.
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/state is In Progress/);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ deployed: false, error: 'state is In Progress' });
    // The hold went in before the deploy so no run could exist unprotected. The deploy was refused, so no
    // run exists and the hold it wrote is released instead of keeping idle_fill off the issue for 24h.
    expect(claimHold).toHaveBeenCalledTimes(1);
    expect(releaseHold).toHaveBeenCalledExactlyOnceWith(UUID_MAIN, CLAIM_STAMP);
  });

  describe('releasing the hold when the deploy is refused', () => {
    const refuse = (postWork: NonNullable<ExecCommandDeps['postWork']>, extra: Partial<ExecCommandDeps> = {}) => {
      const releaseHold = vi.fn();
      const deps = deployDeps({ claimHold: vi.fn(freshClaim), releaseHold, postWork, ...extra });
      return { deps, releaseHold };
    };

    it.each([
      ['an HTTP 403 (outside allowedProjects)', async () => ({ status: 403, body: { error: 'not allowed' } })],
      ['an HTTP 409 (rate-limit window)', async () => ({ status: 409, body: { error: 'paused' } })],
    ])('releases it on %s: nothing was deployed', async (_label, postWork) => {
      const { deps, releaseHold } = refuse(postWork);
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).not.toBe(0);
      expect(releaseHold).toHaveBeenCalledExactlyOnceWith(UUID_MAIN, CLAIM_STAMP);
    });

    it('releases it when the daemon refuses its own health probe and when a detached child cannot start', async () => {
      const probe = refuse(async () => ({ status: 202, body: { queued: 1 } }), { daemonProbe: async () => ({ kind: 'refused', status: 403 }) });
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, probe.deps)).toBe(2);
      expect(probe.releaseHold).toHaveBeenCalledExactlyOnceWith(UUID_MAIN, CLAIM_STAMP);

      const child = refuse(async () => ({ status: 202, body: { queued: 1 } }), {
        daemonProbe: async () => ({ kind: 'down' }), spawnWorkChild: () => ({ ok: false, reason: 'dist/cli.js missing' }),
      });
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, child.deps)).toBe(1);
      expect(child.releaseHold).toHaveBeenCalledExactlyOnceWith(UUID_MAIN, CLAIM_STAMP);
    });

    it('keeps it when the daemon already owns the issue: `exec await` can still follow that run', async () => {
      const { deps, releaseHold } = refuse(async () => ({
        status: 202, body: { items: [{ reason: WORK_ALREADY_QUEUED_REASON }], queued: 0, skipped: 1 },
      }));
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(2);
      expect(releaseHold).not.toHaveBeenCalled();
    });

    it('keeps it when the request may have reached the daemon (a 5xx or a transport error)', async () => {
      const serverError = refuse(async () => ({ status: 503, body: { error: 'busy' } }));
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, serverError.deps)).toBe(1);
      expect(serverError.releaseHold).not.toHaveBeenCalled();

      const dropped = refuse(async () => { throw new Error('socket hang up'); });
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, dropped.deps)).toBe(1);
      expect(dropped.releaseHold).not.toHaveBeenCalled();
    });

    it('keeps a hold that existed before this call: it belongs to an earlier deploy', async () => {
      const { deps, releaseHold } = refuse(async () => ({ status: 403, body: { error: 'not allowed' } }), { claimHold: () => ({ wasHeld: true, stamp: HELD_STAMP }) });
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(1);
      expect(releaseHold).not.toHaveBeenCalled();
    });

    it('never releases it after a successful deploy', async () => {
      const releaseHold = vi.fn();
      const deps = deployDeps({ claimHold: vi.fn(freshClaim), releaseHold });
      expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(0);
      expect(releaseHold).not.toHaveBeenCalled();
    });
  });

  it('quotes the daemon’s own reason when a 202 queues nothing and gives none', async () => {
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      postWork: async () => ({ status: 202, body: { items: [], queued: 0, skipped: 0 } }),
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(2);
    expect(JSON.parse(deps.outs.join('\n')).error).toBe('the daemon queued nothing');
  });

  it('keeps exit 1 for a daemon HTTP 500 — a no-action 202 is a refusal (2), a failure is 1', async () => {
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      postWork: async () => ({ status: 500, body: { error: 'boom' } }),
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(1);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ deployed: false, error: expect.stringContaining('boom') });
  });

  it.each([401, 403, 503])(
    'treats a daemon that answers %i on its own health probe as a refusal, never a child fallback',
    async (status) => {
      const spawnWorkChild = vi.fn(() => ({ ok: true }));
      const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
      const deps = deployDeps({
        claimHold: vi.fn(freshClaim),
        daemonProbe: async () => ({ kind: 'refused', status }),
        postWork,
        spawnWorkChild,
      });
      const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);

      expect(code).toBe(2);
      expect(spawnWorkChild).not.toHaveBeenCalled();
      expect(postWork).not.toHaveBeenCalled();
      const out = JSON.parse(deps.outs.join('\n'));
      expect(out).toMatchObject({ runId: UUID_MAIN, identifier: 'INT-1', transport: 'daemon', deployed: false });
      expect(out.error).toMatch(new RegExp(`refused its own health probe \\(/api/stats HTTP ${status}\\)`));
    },
  );

  it('falls back to a detached child when the precise probe says the daemon is down', async () => {
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      daemonProbe: async () => ({ kind: 'down' }),
      postWork,
      spawnWorkChild,
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);

    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toEqual({
      runId: UUID_MAIN,
      identifier: 'INT-1',
      transport: 'child',
      deployed: true,
    });
    expect(spawnWorkChild).toHaveBeenCalledWith(repoPath, 'INT-1');
    expect(postWork).not.toHaveBeenCalled();
  });

  it('keeps the legacy boolean probe working: false still means down, never refused', async () => {
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      daemonHealthy: async () => false,
      postWork,
      spawnWorkChild,
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);

    expect(code).toBe(0);
    expect(spawnWorkChild).toHaveBeenCalledWith(repoPath, 'INT-1');
    expect(postWork).not.toHaveBeenCalled();
    expect(deps.logs.join('\n')).toMatch(/Daemon unreachable/);
  });

  it('falls back to a detached child only when the daemon is unreachable', async () => {
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const deps = deployDeps({ claimHold: vi.fn(freshClaim), daemonHealthy: async () => false, spawnWorkChild });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toEqual({
      runId: UUID_MAIN,
      identifier: 'INT-1',
      transport: 'child',
      deployed: true,
    });
    expect(spawnWorkChild).toHaveBeenCalledWith(repoPath, 'INT-1');
    expect(deps.logs.join('\n')).toMatch(/Daemon unreachable — deploying via a detached worker instead\./);
  });

  it('fails when the child cannot be started, quoting its reason', async () => {
    const deps = deployDeps({
      claimHold: vi.fn(freshClaim),
      daemonHealthy: async () => false,
      spawnWorkChild: () => ({ ok: false, reason: 'dist/cli.js not found' }),
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(1);
    expect(deps.logs.join('\n')).toMatch(/Deploy failed \(child\): dist\/cli\.js not found/);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ transport: 'child', deployed: false, error: 'dist/cli.js not found' });
  });

  it('aborts the deploy when the hold cannot be written — fail closed', async () => {
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const deps = deployDeps({
      claimHold: () => { throw new Error('database is locked'); },
      postWork,
      spawnWorkChild,
    });
    const code = await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps);
    expect(code).toBe(1);
    expect(deps.logs.join('\n')).toMatch(/Could not record the exec hold: database is locked/);
    expect(postWork).not.toHaveBeenCalled();
    expect(spawnWorkChild).not.toHaveBeenCalled();
    expect(deps.outs).toEqual([]);
  });

  it('honours OPENSWARM_EXEC_ACTOR for the hold actor', async () => {
    process.env.OPENSWARM_EXEC_ACTOR = 'external:claude-code';
    const claimHold = vi.fn(freshClaim);
    const deps = deployDeps({ claimHold, actor: undefined });
    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath }, deps)).toBe(0);
    expect(claimHold).toHaveBeenCalledWith(UUID_MAIN, 'external:claude-code');
  });

  it('resolves an identifier through the tracker', async () => {
    const getIssue = vi.fn(async () => issue({ id: UUID_MAIN, identifier: 'INT-1' }));
    const deps = deployDeps({ getIssue, claimHold: vi.fn(freshClaim) });
    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(0);
    expect(getIssue).toHaveBeenCalledWith('INT-1');
    expect(JSON.parse(deps.outs.join('\n')).runId).toBe(UUID_MAIN);
  });
});

describe('runExecDeployCommand — default daemon transport', () => {
  /** Deploy deps with no injected probe, post or spawn: the module's own defaults run. */
  const defaultTransportDeps = () => deployDeps({
    claimHold: freshClaim, daemonHealthy: undefined, postWork: undefined,
  });
  type FetchArgs = [string, RequestInit | undefined];
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  const urls = () => fetchMock.mock.calls.map(([url]) => new URL(url).pathname);

  beforeEach(() => {
    fetchMock.mockReset();
    spawnMock.mockReset();
    distEntry.exists = true;
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes /api/stats, then posts the issue to /api/work', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queued: 1, items: [] }), { status: 202 }));
    const deps = defaultTransportDeps();

    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(0);
    expect(urls()).toEqual(['/api/stats', '/api/work']);
    const [, init] = fetchMock.mock.calls[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ issueIds: ['INT-1'], projectPath: repoPath });
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ transport: 'daemon', deployed: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reads a non-2xx health probe as a refusal and never posts or spawns', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const deps = defaultTransportDeps();

    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(2);
    expect(urls()).toEqual(['/api/stats']);
    expect(JSON.parse(deps.outs.join('\n')).error).toMatch(/\/api\/stats HTTP 403/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps a dispatch error whose body is not JSON as a failure (exit 1)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    const deps = defaultTransportDeps();

    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(1);
    expect(JSON.parse(deps.outs.join('\n')).error).toMatch(/HTTP 502/);
  });

  it('spawns a detached `work` child from dist/cli.js when the daemon cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });
    const deps = defaultTransportDeps();

    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/dist[\\/]cli\.js$/), 'work', 'INT-1', '--yes', '--path', repoPath],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalled();
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ transport: 'child', deployed: true });
  });

  it('fails the child fallback with a build hint when dist/cli.js is missing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    distEntry.exists = false;
    const deps = defaultTransportDeps();

    expect(await runExecDeployCommand({ issue: 'INT-1', path: repoPath, json: true }, deps)).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(JSON.parse(deps.outs.join('\n')).error).toMatch(/npm run build/);
  });
});

// ---- D. status / await / answer ---------------------------------------------

describe('runExecStatusCommand', () => {
  it('reports UNKNOWN and exit 2 for an id with no durable run', async () => {
    const deps = baseDeps();
    const code = await runExecStatusCommand('uuid-nope', { json: true }, deps);
    expect(code).toBe(2);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ runId: 'uuid-nope', state: 'UNKNOWN' });
    expect(JSON.parse(deps.outs.join('\n')).hint).toMatch(/openswarm exec --issue/);
  });

  it('reports the parked run, its questions and the next command', async () => {
    const deps = baseDeps();
    const code = await runExecStatusCommand(UUID_MAIN, { json: true }, deps);
    expect(code).toBe(0);
    const elevation = JSON.parse(deps.outs.join('\n'));
    expect(elevation).toMatchObject({
      runId: UUID_MAIN,
      identifier: 'INT-1',
      state: 'NEEDS_HUMAN',
      attemptNo: 1,
      elevation: true,
      reason: OPERATOR_QUESTION_PARK_REASON,
      branch: 'openswarm/int-1',
      worktree: `${REPO}/.worktrees/int-1`,
    });
    expect(elevation.verdict).toBe(classifyRunForAwait('NEEDS_HUMAN'));
    expect(elevation.pendingQuestions).toEqual([
      { correlationId: 'hq-a', question: 'Which branch should I use?', questionClass: 'clarification' },
      { correlationId: 'hq-c', question: 'Deploy where?', questionClass: 'approval' },
      { correlationId: 'hq-f', question: 'Anything else?', questionClass: 'approval' },
    ]);
    expect(elevation.hint).toBe(`openswarm exec answer ${UUID_MAIN} --correlation hq-a --text "..."`);
    expect(elevation.hint).toMatch(/exec answer/);
  });

  it('prints the same elevation for a human', async () => {
    const deps = baseDeps();
    expect(await runExecStatusCommand(UUID_MAIN, {}, deps)).toBe(0);
    const text = deps.outs.join('\n');
    expect(text).toMatch(/INT-1: NEEDS_HUMAN \(attempt 1\)/);
    expect(text).toMatch(/reason: operator_question/);
    expect(text).toMatch(/question \[clarification\] hq-a: Which branch should I use\?/);
    expect(text).toMatch(/next: openswarm exec answer/);
  });

  it('resolves an identifier spelling through the tracker', async () => {
    const getIssue = vi.fn(async () => issue({ id: UUID_MAIN, identifier: 'INT-1' }));
    const deps = baseDeps({ getIssue });
    expect(await runExecStatusCommand('INT-1', { json: true }, deps)).toBe(0);
    expect(getIssue).toHaveBeenCalledWith('INT-1');
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ runId: UUID_MAIN, state: 'NEEDS_HUMAN' });
  });

  it('leaves the run and its hold untouched — status is read-only', async () => {
    const markHold = vi.fn();
    const claimHold = vi.fn(freshClaim);
    const releaseHold = vi.fn();
    const deps = baseDeps({ markHold, claimHold, releaseHold });
    expect(await runExecStatusCommand(UUID_MAIN, { json: true }, deps)).toBe(0);
    expect(markHold).not.toHaveBeenCalled();
    expect(claimHold).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
    expect(readExecRunRow(dbPath, UUID_MAIN)?.state).toBe('NEEDS_HUMAN');
  });
});

describe('runExecAwaitCommand', () => {
  it('returns immediately on a parked run, with the elevation verdict and exit 1', async () => {
    const sleep = vi.fn(async () => undefined);
    const deps = baseDeps({ sleep });
    const code = await runExecAwaitCommand(UUID_MAIN, { json: true, timeout: 3600 }, deps);
    expect(code).toBe(1);
    const elevation = JSON.parse(deps.outs.join('\n'));
    expect(elevation).toMatchObject({ state: 'NEEDS_HUMAN', verdict: 'elevation', elevation: true, attemptNo: 1 });
    expect(elevation.pendingQuestions.map((question: { correlationId: string }) => question.correlationId)).toEqual(['hq-a', 'hq-c', 'hq-f']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns immediately on a finished run, with exit 0', async () => {
    const sleep = vi.fn(async () => undefined);
    const deps = baseDeps({ sleep });
    const code = await runExecAwaitCommand(UUID_DONE, { json: true, timeout: 3600 }, deps);
    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ state: 'DONE', verdict: 'terminal', elevation: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('prints the terminal run for a human without inventing a question', async () => {
    const deps = baseDeps({ sleep: async () => undefined });
    expect(await runExecAwaitCommand(UUID_DONE, {}, deps)).toBe(0);
    expect(deps.outs.join('\n')).toMatch(/INT-9: DONE — the run has finished\./);
  });

  it('prints the parked run for a human with its branch, questions and next command', async () => {
    const deps = baseDeps({ sleep: async () => undefined });
    expect(await runExecAwaitCommand(UUID_MAIN, {}, deps)).toBe(1);
    const text = deps.outs.join('\n');
    expect(text).toMatch(/INT-1: NEEDS_HUMAN — needs the orchestrator\./);
    expect(text).toMatch(/reason: operator_question — The worker asked the operator a question/);
    expect(text).toMatch(/branch: openswarm\/int-1 \(worktree \/repo\/\.worktrees\/int-1\)/);
    expect(text).toMatch(/question \[clarification\] hq-a: Which branch should I use\?/);
    expect(text).toMatch(new RegExp(`next: openswarm exec answer ${UUID_MAIN} --correlation hq-a --text "\\.\\.\\."`));
  });

  it('times out with exit 2, a pending verdict and a hint to await again', async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const deps = baseDeps({ now: () => clock, sleep });
    const code = await runExecAwaitCommand(UUID_READY, { json: true, timeout: 10 }, deps);
    expect(code).toBe(2);
    expect(sleep).toHaveBeenCalled();
    expect(sleep.mock.calls.every(([ms]) => ms === 5000)).toBe(true);
    const timedOut = JSON.parse(deps.outs.join('\n'));
    expect(timedOut).toMatchObject({ runId: UUID_READY, state: 'READY', verdict: 'pending', elevation: false });
    expect(timedOut.hint).toMatch(/still READY after 10s — re-run `openswarm exec await uuid-ready` to keep waiting/);
    // The run was never touched while waiting.
    expect(readExecRunRow(dbPath, UUID_READY)?.state).toBe('READY');
  });

  it('reports an unknown run as pending with exit 2 instead of waiting forever', async () => {
    // The clock advances with the sleep, so the deadline is eventually reached
    // and the poll-through-the-deploy-gap loop gives up instead of waiting
    // forever for a row that never appears.
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const deps = baseDeps({ sleep, now: () => clock });
    const code = await runExecAwaitCommand('uuid-nope', { json: true, timeout: 1 }, deps);
    expect(code).toBe(2);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ state: 'UNKNOWN', verdict: 'pending', elevation: false });
    // It polled through the deploy gap once, then gave up.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(deps.logs.join('\n')).toMatch(/no durable run recorded yet — waiting/);
  });

  it('polls through the deploy gap: a run that appears after one poll is reported, not missed', async () => {
    // The row does not exist yet (a detached child is still resolving Linear),
    // then it does. `await` must keep reading rather than returning on the first
    // empty read.
    let clock = 0;
    const late = 'uuid-late';
    const seedLate = () => {
      const ledger = new RunLedger(dbPath);
      try {
        ledger.registerRun({ issueId: late, source: 'linear', identifier: 'INT-77', title: 'late', projectPath: REPO });
      } finally {
        ledger.close();
      }
    };
    let seeded = false;
    const deps = baseDeps({
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        if (!seeded) { seeded = true; seedLate(); }
      },
    });

    const code = await runExecAwaitCommand(late, { json: true, timeout: 10 }, deps);

    // The late run is READY — still pending — so the call times out at exit 2,
    // but its row was read and reported instead of UNKNOWN.
    expect(code).toBe(2);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ identifier: 'INT-77', state: 'READY', verdict: 'pending' });
    expect(deps.logs.join('\n')).toMatch(/no durable run recorded yet — waiting/);
  });

  it('leaves the hold and the run alone — await never writes', async () => {
    const markHold = vi.fn();
    const claimHold = vi.fn(freshClaim);
    const releaseHold = vi.fn();
    const deps = baseDeps({ markHold, claimHold, releaseHold, sleep: async () => undefined });
    expect(await runExecAwaitCommand(UUID_MAIN, { json: true }, deps)).toBe(1);
    expect(markHold).not.toHaveBeenCalled();
    expect(claimHold).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
    expect(readExecRunRow(dbPath, UUID_MAIN)).toMatchObject({ state: 'NEEDS_HUMAN', attemptNo: 1 });
  });
});

describe('runExecAnswerCommand', () => {
  it('refuses an unknown run', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({ answerQuestion });
    const code = await runExecAnswerCommand('uuid-nope', { correlation: 'hq-a', json: true }, deps);
    expect(code).toBe(2);
    expect(deps.logs.join('\n')).toMatch(/No durable run recorded for uuid-nope/);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it('refuses a run that is not elevated and has no correlation', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const openLedger = vi.fn(() => fakeLedger());
    const deps = baseDeps({ answerQuestion, openLedger });
    const code = await runExecAnswerCommand(UUID_READY, { json: true }, deps);
    expect(code).toBe(2);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      runId: UUID_READY,
      answerAccepted: null,
      resumed: null,
      transport: null,
    });
    expect(deps.outs.join('\n')).toMatch(/INT-2 is READY; nothing to answer\./);
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(openLedger).not.toHaveBeenCalled();
  });

  it('answers, resumes the ledger, re-marks the hold and redeploys — in that order', async () => {
    const order: string[] = [];
    const answerQuestion = vi.fn(async (_correlationId: string, _text: string, _actor: string) => {
      order.push('answer');
      return { accepted: true };
    });
    const openLedger = vi.fn((_path: string) => fakeLedger({
      resumeNeedsHumanForQuestions: (_issueId: string) => { order.push('resume'); return 'READY'; },
    }));
    const markHold = vi.fn(() => { order.push('hold'); });
    const postWork = vi.fn(async () => { order.push('deploy'); return { status: 202, body: { queued: 1 } }; });
    const deps = baseDeps({ answerQuestion, openLedger, markHold, daemonHealthy: async () => true, postWork });

    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', text: 'use main', json: true }, deps);

    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toEqual({
      runId: UUID_MAIN,
      answerAccepted: true,
      resumed: 'READY',
      transport: 'daemon',
    });
    expect(answerQuestion).toHaveBeenCalledWith('hq-a', 'use main', 'external:test');
    expect(order).toEqual(['answer', 'resume', 'hold', 'deploy']);
    expect(markHold).toHaveBeenCalledWith(UUID_MAIN, 'external:test');
    // The run was registered under REPO: that is where it is redeployed, whatever the cwd of the caller is.
    expect(postWork).toHaveBeenCalledWith(REPO, 'INT-1');
  });

  it('redeploys to --path when given, over the run\'s recorded path', async () => {
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: true }), markHold: vi.fn(), daemonHealthy: async () => true, postWork,
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
    });
    expect(await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', path: '/elsewhere', json: true }, deps)).toBe(0);
    expect(postWork).toHaveBeenCalledWith('/elsewhere', 'INT-1');
  });

  it('accepts an empty answer text as a pure resume', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({
      answerQuestion,
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
    });
    expect(await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps)).toBe(0);
    expect(answerQuestion).toHaveBeenCalledWith('hq-a', '', 'external:test');
  });

  it('stops when the answer is refused, without touching the ledger', async () => {
    const openLedger = vi.fn(() => { throw new Error('ledger must not be opened for a refused answer'); });
    const markHold = vi.fn();
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: false, reason: 'This question requires a human decision' }),
      openLedger,
      markHold,
      daemonHealthy: async () => true,
      postWork,
    });
    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps);

    expect(code).toBe(1);
    expect(deps.logs.join('\n')).toMatch(/Answer refused: This question requires a human decision/);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      runId: UUID_MAIN,
      answerAccepted: false,
      resumed: null,
      transport: null,
      error: 'This question requires a human decision',
    });
    expect(openLedger).not.toHaveBeenCalled();
    expect(markHold).not.toHaveBeenCalled();
    expect(postWork).not.toHaveBeenCalled();
  });

  it('refuses to redeploy when no resume path accepts the run', async () => {
    const markHold = vi.fn();
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const spawnWorkChild = vi.fn(() => ({ ok: true }));
    const resume = vi.fn(() => null);
    const readmit = vi.fn(() => false);
    const markReady = vi.fn(() => false);
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: true }),
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: resume, readmitParkedRun: readmit, markReady }),
      markHold,
      daemonHealthy: async () => true,
      postWork,
      spawnWorkChild,
    });
    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps);

    expect(code).toBe(1);
    // The whole fallback chain was tried, in order, and each one declined.
    expect(resume).toHaveBeenCalledWith(UUID_MAIN);
    expect(readmit).toHaveBeenCalledWith(UUID_MAIN, OPERATOR_QUESTION_PARK_REASON);
    expect(markReady).toHaveBeenCalledWith(UUID_MAIN);
    expect(deps.logs.join('\n')).toMatch(
      new RegExp(`Could not resume INT-1 from NEEDS_HUMAN \\(park: ${OPERATOR_QUESTION_PARK_REASON}\\)\\.`),
    );
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      answerAccepted: true,
      resumed: null,
      transport: null,
      error: 'could not resume from NEEDS_HUMAN',
    });
    expect(markHold).not.toHaveBeenCalled();
    expect(postWork).not.toHaveBeenCalled();
    expect(spawnWorkChild).not.toHaveBeenCalled();
  });

  it('falls back to readmitParkedRun, then to markReady, when the park resume declines', async () => {
    const markReady = vi.fn(() => false);
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: true }),
      openLedger: () => fakeLedger({
        resumeNeedsHumanForQuestions: () => null,
        readmitParkedRun: () => true,
        markReady,
      }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });
    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps);

    expect(code).toBe(0);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ answerAccepted: true, resumed: 'READY', transport: 'daemon' });
    // readmit won, so the plain reopen was never needed.
    expect(markReady).not.toHaveBeenCalled();
  });

  it('refuses --text without --correlation instead of resuming the run and dropping the guidance', async () => {
    // Guidance is delivered as the answer to a question; with no correlation there is nowhere to write it.
    // The command used to resume and redeploy anyway and report exit 0, while the worker parked again on
    // the same thing, because the text had reached no board, ledger or comment.
    const openLedger = vi.fn(() => fakeLedger());
    const markHold = vi.fn();
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = baseDeps({ openLedger, markHold, postWork, daemonHealthy: async () => true });

    const code = await runExecAnswerCommand(UUID_MAIN, { text: 'use the staging DB', json: true }, deps);

    expect(code).toBe(2);
    const doc = JSON.parse(deps.outs.join('\n'));
    expect(doc).toMatchObject({ runId: UUID_MAIN, answerAccepted: null, resumed: null });
    expect(doc.error).toContain('--text needs --correlation');
    expect(openLedger).not.toHaveBeenCalled();
    expect(markHold).not.toHaveBeenCalled();
    expect(postWork).not.toHaveBeenCalled();
  });

  it('offers --text in the next-command hint only where a question can carry it', () => {
    const row = readExecRunRow(dbPath, UUID_MAIN)!;
    const question = { correlationId: 'hq-a', question: 'Which branch?', questionClass: 'clarification' as const };
    expect(buildExecElevation(UUID_MAIN, row, [question]).hint)
      .toBe(`openswarm exec answer ${UUID_MAIN} --correlation hq-a --text "..."`);
    expect(buildExecElevation(UUID_MAIN, row, []).hint).toBe(`openswarm exec answer ${UUID_MAIN}`);
  });

  it('skips the question contract entirely when the park is not an operator question', async () => {
    // Re-seed a run parked for a non-question reason: RETRY_AT under a
    // deferral, which is the state `readmitParkedRun` is written for.
    const retryId = 'uuid-retry';
    const ledger = new RunLedger(dbPath);
    try {
      ledger.registerRun({ issueId: retryId, source: 'linear', identifier: 'INT-3', title: 'retry', projectPath: REPO });
      if (!ledger.deferUnclaimedRun(retryId, Date.now() + 60_000, 'flaky infrastructure')) throw new Error('fixture: defer rejected');
    } finally {
      ledger.close();
    }
    const resume = vi.fn(() => 'READY');
    const readmit = vi.fn(() => true);
    const deps = baseDeps({
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: resume, readmitParkedRun: readmit }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });
    const code = await runExecAnswerCommand(retryId, { json: true }, deps);

    expect(code).toBe(0);
    // RETRY_AT is answerable without a correlation (the operator forcing a retry),
    // and the question contract is only for an operator_question park.
    expect(resume).not.toHaveBeenCalled();
    expect(readmit).toHaveBeenCalledWith(retryId, 'claim_deferred');
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ answerAccepted: null, resumed: 'READY' });
  });

  it('fails after a resume when the hold cannot be re-marked, without redeploying', async () => {
    const postWork = vi.fn(async () => ({ status: 202, body: { queued: 1 } }));
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: true }),
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
      markHold: () => { throw new Error('database is locked'); },
      daemonHealthy: async () => true,
      postWork,
    });
    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps);
    expect(code).toBe(1);
    expect(deps.logs.join('\n')).toMatch(/Could not refresh the exec hold: database is locked/);
    expect(postWork).not.toHaveBeenCalled();
  });

  it('reports a resumed run whose redeploy failed', async () => {
    const deps = baseDeps({
      answerQuestion: async () => ({ accepted: true }),
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 403, body: { error: 'not in the daemon allowed projects' } }),
    });
    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-a', json: true }, deps);
    expect(code).toBe(1);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      answerAccepted: true,
      resumed: 'READY',
      transport: 'daemon',
      error: expect.stringContaining('not in the daemon allowed projects'),
    });
  });

  // ---- C. Answerable-state whitelist -----------------------------------------

  it.each(ANSWERABLE_STATES)('answers a %s run with no correlation given', async (state) => {
    const ids = seedAnswerableRuns();
    const openLedger = vi.fn(() => fakeLedger({ markReady: () => true }));
    const deps = baseDeps({
      openLedger,
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });

    const code = await runExecAnswerCommand(ids[state], { json: true }, deps);

    expect(code).toBe(0);
    // It was not refused at the gate: the answer path ran, with no correlation,
    // and reached the ledger.
    expect(openLedger).toHaveBeenCalledTimes(1);
    expect(deps.logs.join('\n')).not.toMatch(/nothing to answer/);
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ answerAccepted: null, resumed: 'READY' });
  });

  it('refuses NEEDS_RECONCILE with no correlation and never touches the ledger', async () => {
    // The regression this pins: NEEDS_RECONCILE is an elevation but NOT an input
    // park. Forcing it to READY would re-admit the run with its artifact
    // reconciliation skipped, so `answer` must refuse before any write.
    const ids = seedAnswerableRuns();
    const openLedger = vi.fn(() => fakeLedger());
    const markHold = vi.fn();
    const deps = baseDeps({ openLedger, markHold });

    const code = await runExecAnswerCommand(ids.NEEDS_RECONCILE, { json: true }, deps);

    expect(code).toBe(2);
    expect(readExecRunRow(dbPath, ids.NEEDS_RECONCILE)?.state).toBe('NEEDS_RECONCILE');
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      runId: ids.NEEDS_RECONCILE,
      answerAccepted: null,
      resumed: null,
      transport: null,
      error: 'INT-13 is NEEDS_RECONCILE; nothing to answer.',
    });
    expect(openLedger).not.toHaveBeenCalled();
    expect(markHold).not.toHaveBeenCalled();
  });

  it('still answers a NEEDS_RECONCILE run when a correlation is given — the question path is state-independent', async () => {
    // Needs a binding decision too: the seeded hq-a belongs to UUID_MAIN, and
    // this test is about the STATE gate, not the binding gate.
    const ids = seedAnswerableRuns();
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({
      answerQuestion,
      findQuestionTask: async () => ids.NEEDS_RECONCILE,
      openLedger: () => fakeLedger({ markReady: () => true }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });

    const code = await runExecAnswerCommand(ids.NEEDS_RECONCILE, { correlation: 'hq-a', json: true }, deps);

    expect(code).toBe(0);
    expect(answerQuestion).toHaveBeenCalledWith('hq-a', '', 'external:test');
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({ answerAccepted: true, resumed: 'READY' });
  });

  // ---- D. Correlation → run binding ------------------------------------------

  it('refuses a correlation that belongs to another run, before writing anything', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const openLedger = vi.fn(() => fakeLedger());
    const markHold = vi.fn();
    const findQuestionTask = vi.fn(async () => 'other-issue-uuid');
    const deps = baseDeps({ answerQuestion, openLedger, markHold, findQuestionTask });

    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-1', text: 'x', json: true }, deps);

    expect(code).toBe(2);
    expect(findQuestionTask).toHaveBeenCalledWith('hq-1');
    // The whole point: the board was never written, so a question owned by
    // another run can never be settled through this one.
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(openLedger).not.toHaveBeenCalled();
    expect(markHold).not.toHaveBeenCalled();
    expect(JSON.parse(deps.outs.join('\n'))).toMatchObject({
      runId: UUID_MAIN,
      answerAccepted: false,
      resumed: null,
      transport: null,
      // In --json mode the refusal is the document's `error`, not a log line.
      error: 'hq-1 belongs to other-issue-uuid, not INT-1 — refusing to answer it through this run.',
    });
    expect(deps.logs.join('\n')).toBe('');
  });

  it('accepts a correlation owned by this run (matched by its own issue id)', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({
      answerQuestion,
      findQuestionTask: async () => UUID_MAIN,
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });

    const code = await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-1', text: 'x', json: true }, deps);

    expect(code).toBe(0);
    expect(answerQuestion).toHaveBeenCalledWith('hq-1', 'x', 'external:test');
  });

  it('accepts a correlation owned by this run when the owner is spelled as the identifier', async () => {
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({
      answerQuestion,
      findQuestionTask: async () => 'INT-1',
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });

    expect(await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-1', json: true }, deps)).toBe(0);
    expect(answerQuestion).toHaveBeenCalledWith('hq-1', '', 'external:test');
  });

  it('does not block on a correlation whose owner cannot be resolved', async () => {
    // A question the board does not know (already pruned, or Linear unconfigured)
    // is not evidence it belongs elsewhere — refusing here would make `answer`
    // unusable exactly when the operator needs to force a resume.
    const answerQuestion = vi.fn(async () => ({ accepted: true }));
    const deps = baseDeps({
      answerQuestion,
      findQuestionTask: async () => undefined,
      openLedger: () => fakeLedger({ resumeNeedsHumanForQuestions: () => 'READY' }),
      markHold: vi.fn(),
      daemonHealthy: async () => true,
      postWork: async () => ({ status: 202, body: { queued: 1 } }),
    });

    expect(await runExecAnswerCommand(UUID_MAIN, { correlation: 'hq-1', json: true }, deps)).toBe(0);
    expect(answerQuestion).toHaveBeenCalledWith('hq-1', '', 'external:test');
  });
});
