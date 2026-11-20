import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLedger } from './runLedger.js';
import {
  aggregateTaxonomy, classifyCause, composeCandidateIssue, mergeSignals, runFailureTaxonomy,
  type FailureSignal,
} from './failureTaxonomy.js';
import { missingDefinitionOfReadySections } from './definitionOfReady.js';

// The fixture mirrors the shape of the 2026-10-20 night on the production
// ledger (see the PR for the measured counts): workers declaring the remaining
// work human-only, a run waiting on a product decision, drafts parked for a
// human, a question asking the operator to authorise a release, and a disk
// that filled during verify clones. The issue ids and texts are synthetic.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 21, 15);
const HOUR = 60 * 60 * 1000;

type AttemptSeed = { issue: string; attempt: number; message: string; status?: string; success?: number; at?: number };
type ParkSeed = { issue: string; attempt: number; reason: string; kind?: string; at?: number };

function seededLedger(attempts: AttemptSeed[], parks: ParkSeed[] = []): { path: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-taxonomy-'));
  roots.push(root);
  const path = join(root, 'automation.db');
  new RunLedger(path).close(); // the real schema
  const db = new Database(path);
  const run = db.prepare(`INSERT OR IGNORE INTO automation_runs(issue_id, source, identifier, project_path, state, discovered_at, updated_at)
    VALUES (?, 'linear', ?, '/repo', 'RETRY_AT', ?, ?)`);
  const attempt = db.prepare(`INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at, finished_at, error_message, result_status, success)
    VALUES (?, ?, 1, 'suspended', 'RETRY_AT', ?, ?, ?, ?, ?)`);
  const event = db.prepare(`INSERT INTO automation_events(issue_id, attempt_no, kind, from_state, to_state, data_json, created_at)
    VALUES (?, ?, ?, 'RETRY_AT', 'NEEDS_HUMAN', ?, ?)`);
  for (const a of attempts) {
    const at = a.at ?? NOW - 2 * HOUR;
    run.run(`uuid-${a.issue}`, a.issue, at - 1000, at);
    attempt.run(`uuid-${a.issue}`, a.attempt, at - 1000, at, a.message, a.status ?? 'infra_error', a.success ?? 0);
  }
  for (const p of parks) {
    const at = p.at ?? NOW - HOUR;
    run.run(`uuid-${p.issue}`, p.issue, at - 1000, at);
    event.run(`uuid-${p.issue}`, p.attempt, p.kind ?? 'parked', JSON.stringify({ reason: p.reason }), at);
  }
  return { path, db };
}

function board(events: Array<{ issue: string; id: string; text: string; at?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-taxonomy-board-'));
  roots.push(root);
  const path = join(root, 'coordination.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    nextSeq: events.length + 1,
    events: events.map((e, i) => ({ seq: i + 1, kind: 'human-question', timestamp: e.at ?? NOW - 3 * HOUR, taskLabel: e.issue, correlationId: e.id, summary: e.text })),
    consumed: {},
  }));
  return path;
}

const ENOSPC = 'tester: git exited with code 128: error: copy-fd: write returned: No space left on device';

function nightOf1020() {
  const attempts: AttemptSeed[] = [
    ...['T-1', 'T-2', 'T-3'].flatMap((issue, i) => [1, 2].map(n => ({
      issue, attempt: n, status: 'superseded', success: 1,
      message: `human_action_only: the remaining definition of done is a production data write and a live readback (${i}).`,
    }))),
    ...['T-4', 'T-5', 'T-6', 'T-7'].map((issue, i) => ({ issue, attempt: i + 1, message: ENOSPC })),
    { issue: 'T-8', attempt: 1, status: 'superseded', success: 1, message: 'blocked_by_dependency: the remaining work needs a product decision from the client.' },
    { issue: 'T-8', attempt: 2, status: 'superseded', success: 1, message: 'blocked_by_dependency: the remaining work needs a product decision from the client.' },
    { issue: 'T-9', attempt: 1, status: 'waiting_on_operator', message: 'Waiting for operator answer (hq-0000000000000001)' },
    { issue: 'T-10', attempt: 3, status: 'approved', success: 1, message: 'not a failure' },
  ];
  const parks: ParkSeed[] = [
    { issue: 'T-11', attempt: 1, reason: 'Draft PR needs a human: https://example.invalid/pr/1 — not a review rollback and no sibling PR closes the issue' },
    { issue: 'T-12', attempt: 1, reason: 'Draft PR needs a human: https://example.invalid/pr/2 — not a review rollback and no sibling PR closes the issue' },
  ];
  const questions = [
    { issue: 'T-9', id: 'hq-0000000000000001', text: 'A workflow_dispatch of the release workflow would deploy the site. Do you authorise the release?' },
    { issue: 'T-13', id: 'hq-0000000000000002', text: 'Free disk space please: edit_file failed with ENOSPC; 116MiB free on the data volume.' },
  ];
  return { attempts, parks, questions };
}

describe('classifyCause', () => {
  it.each([
    [ENOSPC, 'host_disk_full'],
    ['작업 디스크 여유 공간을 확보해 주십시오', 'host_disk_full'],
    ['human_action_only: requires an authorised production write', 'human_only_deploy'],
    ['Do you authorise the release workflow_dispatch?', 'human_only_deploy'],
    ['Provide an isolated WAREHOUSE_TEST_DSN for the database-backed test', 'missing_credential'],
    ['blocked_by_dependency: waits on a client decision', 'decision_pending'],
    ['Draft PR needs a human: https://example.invalid/pr/3', 'decision_pending'],
    ['pr-review: changes requested: the status wording is wrong', 'review_changes_requested'],
    ['tester: verify-runner: pytest:apps infrastructure failure: ....', 'verify_infra_failure'],
    ['worker: codex-responses timeout after 1200000ms', 'stage_timeout'],
    ['pipeline stopped early: Same output produced 3 times', 'output_loop'],
  ])('%s → %s', (text, cause) => {
    expect(classifyCause(text).id).toBe(cause);
  });

  it('falls back to a normalised fingerprint, so a repeating unnamed cause still groups', () => {
    const a = classifyCause('Existing open PR owns planned files at /tmp/a/b.ts:12');
    const b = classifyCause('Existing open PR owns planned files at /tmp/c/d.ts:40');
    expect(a.id).toMatch(/^other:/);
    expect(a.id).toBe(b.id);
  });
});

describe('the 2026-10-20 night', () => {
  it('surfaces decision pending, human-only deploy and ENOSPC, each with its sessions', async () => {
    const { attempts, parks, questions } = nightOf1020();
    const { db } = seededLedger(attempts, parks);
    const result = await runFailureTaxonomy({ db, coordinationPath: board(questions), now: NOW, windowMs: 2 * 24 * HOUR, force: true });
    db.close();
    const byId = Object.fromEntries(result.candidates.map(c => [c.id, c]));

    expect(Object.keys(byId)).toEqual(expect.arrayContaining(['decision_pending', 'human_only_deploy', 'host_disk_full']));
    expect(byId.human_only_deploy.sessions).toEqual(['T-1#1', 'T-1#2', 'T-2#1', 'T-2#2', 'T-3#1', 'T-3#2', 'hq-0000000000000001']);
    expect(byId.host_disk_full.sessions).toEqual(['T-4#1', 'T-5#2', 'T-6#3', 'T-7#4', 'hq-0000000000000002']);
    expect(byId.host_disk_full.sources).toEqual({ attempt: 4, question: 1 });
    expect(byId.decision_pending.sessions).toEqual(['T-11#1', 'T-12#1', 'T-8#1', 'T-8#2']);
    expect(byId.decision_pending.kind).toBe('readiness_check');
    // The waiting attempt is represented by its question, not counted twice.
    expect(result.candidates.flatMap(c => c.sessions)).not.toContain('T-9#1');
    // A successful attempt is not a failure signal.
    expect(result.candidates.flatMap(c => c.sessions)).not.toContain('T-10#3');
    expect(result.filed).toEqual([]);
  });

  it('ignores signals outside the window', async () => {
    const { db } = seededLedger([
      { issue: 'T-1', attempt: 1, message: ENOSPC, at: NOW - 10 * 24 * HOUR },
      { issue: 'T-2', attempt: 1, message: ENOSPC, at: NOW - 10 * 24 * HOUR },
      { issue: 'T-3', attempt: 1, message: ENOSPC, at: NOW - 10 * 24 * HOUR },
    ]);
    const result = await runFailureTaxonomy({ db, now: NOW, force: true });
    db.close();
    expect(result.candidates).toEqual([]);
  });
});

describe('aggregateTaxonomy floors', () => {
  const signal = (issue: string, n: number, text = ENOSPC): FailureSignal => ({ source: 'attempt', issue, session: `${issue}#${n}`, text, at: NOW });

  it('needs the cause on more than one issue', () => {
    expect(aggregateTaxonomy([signal('A', 1), signal('A', 2), signal('A', 3)])).toEqual([]);
    expect(aggregateTaxonomy([signal('A', 1), signal('A', 2), signal('B', 1)])).toHaveLength(1);
  });

  it('needs at least minSignals records', () => {
    expect(aggregateTaxonomy([signal('A', 1), signal('B', 1)])).toEqual([]);
    expect(aggregateTaxonomy([signal('A', 1), signal('B', 1)], { minSignals: 2 })).toHaveLength(1);
  });

  it('keeps a waiting attempt when the board does not hold its question', () => {
    const waiting = signal('A', 1, 'Waiting for operator answer (hq-00000000000000ff)');
    expect(mergeSignals([waiting], [])).toEqual([waiting]);
  });
});

describe('runFailureTaxonomy filing', () => {
  function source() {
    let n = 0;
    return {
      createTask: vi.fn(async () => { n += 1; return { id: `uuid-${n}`, identifier: `AGT-90${n}` }; }),
      updateState: vi.fn(async () => true),
    };
  }

  it('files each candidate into Backlog, never Todo, and only once a week', async () => {
    const { attempts, parks, questions } = nightOf1020();
    const { db } = seededLedger(attempts, parks);
    const coordinationPath = board(questions);
    const src = source();

    const first = await runFailureTaxonomy({ db, coordinationPath, taskSource: src, projectId: 'proj', now: NOW, windowMs: 2 * 24 * HOUR });
    expect(first.filed).toHaveLength(first.candidates.length);
    expect(src.createTask).toHaveBeenCalledTimes(first.candidates.length);
    expect(src.updateState.mock.calls.every(([, state]) => state === 'Backlog')).toBe(true);
    expect(src.createTask.mock.calls[0][2]).toBe('proj');

    const sameWeek = await runFailureTaxonomy({ db, coordinationPath, taskSource: src, projectId: 'proj', now: NOW + 24 * HOUR, windowMs: 2 * 24 * HOUR });
    expect(sameWeek).toMatchObject({ ran: false, reason: 'interval' });

    // Next week the same causes are still open candidates: not filed again.
    const nextWeek = await runFailureTaxonomy({ db, coordinationPath, taskSource: src, projectId: 'proj', now: NOW + 7 * 24 * HOUR, windowMs: 8 * 24 * HOUR });
    expect(nextWeek.ran).toBe(true);
    expect(nextWeek.filed).toEqual([]);
    expect(src.createTask).toHaveBeenCalledTimes(first.candidates.length);
    db.close();
  });

  it('a dry run measures without filing or stamping the week', async () => {
    const { attempts, parks } = nightOf1020();
    const { db } = seededLedger(attempts, parks);
    const dry = await runFailureTaxonomy({ db, now: NOW, windowMs: 2 * 24 * HOUR });
    expect(dry.reason).toBe('dry run');
    expect(dry.candidates.length).toBeGreaterThan(0);
    const src = source();
    const real = await runFailureTaxonomy({ db, taskSource: src, now: NOW + HOUR, windowMs: 2 * 24 * HOUR });
    expect(real.ran).toBe(true);
    db.close();
  });
});

describe('composeCandidateIssue', () => {
  it('states that nothing was applied and lists the evidence', () => {
    const [candidate] = aggregateTaxonomy([
      { source: 'attempt', issue: 'A', session: 'A#1', text: ENOSPC, at: NOW },
      { source: 'attempt', issue: 'B', session: 'B#2', text: ENOSPC, at: NOW },
      { source: 'question', issue: 'C', session: 'hq-0000000000000003', text: ENOSPC, at: NOW },
    ]);
    const { title, description } = composeCandidateIssue(candidate, { since: NOW - 7 * 24 * HOUR, until: NOW });
    expect(title).toBe('[Failure taxonomy] guard candidate: ENOSPC — host disk full');
    expect(description).toContain('nothing has been applied');
    // Ledger sessions outside code spans, so the tracker links the identifier.
    expect(description).toContain('A (attempt 1), B (attempt 2), `hq-0000000000000003`');
    expect(description).toContain('<!-- failure-taxonomy-cause: host_disk_full -->');
    expect(description).toContain('| Signals | 3 (attempt 2, question 1) |');
    expect(description).toContain(ENOSPC);
  });
});

describe('failure taxonomy review fixes (#876 review, AGT-4812)', () => {
  const WEEK = 7 * 24 * HOUR;
  const enospc = (issues: string[], at = NOW - 2 * HOUR): AttemptSeed[] => issues.map((issue, i) => ({ issue, attempt: i + 1, message: ENOSPC, at }));
  function source(overrides: Partial<{ updateState: (id: string, state: 'Backlog') => Promise<boolean> }> = {}) {
    let n = 0;
    return {
      createTask: vi.fn(async () => { n += 1; return { id: `uuid-${n}`, identifier: `AGT-90${n}` }; }),
      updateState: vi.fn(overrides.updateState ?? (async () => true)),
    };
  }

  it('a weekly callback that fires a few ms earlier than last week still runs', async () => {
    const { db } = seededLedger(enospc(['T-1', 'T-2', 'T-3']));
    const src = source();
    await runFailureTaxonomy({ db, taskSource: src, now: NOW });
    const next = await runFailureTaxonomy({ db, taskSource: src, now: NOW + WEEK - 30 });
    expect(next.ran).toBe(true);
    // ...but a second pass the same week does not.
    expect((await runFailureTaxonomy({ db, taskSource: src, now: NOW + WEEK + HOUR })).ran).toBe(false);
    db.close();
  });

  it('after a missed week the window reaches back to the last pass', async () => {
    const { db } = seededLedger(enospc(['T-1', 'T-2', 'T-3'], NOW + 3 * 24 * HOUR));
    const src = source();
    await runFailureTaxonomy({ db, taskSource: { ...src, createTask: vi.fn(async () => ({ error: 'none yet' })) }, now: NOW });
    // The daemon missed NOW + 1 week; the signals sit 11 days before this pass.
    const late = await runFailureTaxonomy({ db, taskSource: src, now: NOW + 2 * WEEK });
    expect(late.candidates.map(c => c.id)).toContain('host_disk_full');
    db.close();
  });

  it('a failed move to Backlog is reported, does not cause a twin, and the body is held by the readiness gate', async () => {
    const { db } = seededLedger(enospc(['T-1', 'T-2', 'T-3']));
    const src = source({ updateState: async () => false });
    const first = await runFailureTaxonomy({ db, taskSource: src, now: NOW });
    expect(first.filed).toEqual(['AGT-901']);
    expect(first.notInBacklog).toEqual(['AGT-901']);
    expect(src.updateState).toHaveBeenCalledTimes(3);
    expect(first.reason).toContain('NOT in Backlog');
    const description = (src.createTask.mock.calls[0] as unknown as [string, string])[1];
    expect(missingDefinitionOfReadySections(description).length).toBeGreaterThan(0);
    const next = await runFailureTaxonomy({ db, taskSource: src, now: NOW + WEEK });
    expect(next.filed).toEqual([]);
    db.close();
  });

  it('an issue still open gets the new evidence as a comment instead of a twin, whenever it was filed', async () => {
    const { db } = seededLedger([...enospc(['T-1', 'T-2', 'T-3']), ...enospc(['T-4', 'T-5', 'T-6'], NOW + 5 * WEEK - 2 * HOUR)]);
    const addComment = vi.fn(async () => {});
    const lookupIssueState = vi.fn(async () => ({ ok: true as const, issue: { state: 'Backlog', stateType: 'backlog' } }));
    const src = { ...source(), addComment, lookupIssueState };
    await runFailureTaxonomy({ db, taskSource: src, now: NOW });
    // Five weeks later, past the old four-week quiet period, the issue is still open.
    const later = await runFailureTaxonomy({ db, taskSource: src, now: NOW + 5 * WEEK });
    expect(later.filed).toEqual([]);
    expect(later.updated).toEqual(['uuid-1']);
    expect(lookupIssueState).toHaveBeenCalledWith('uuid-1');
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(src.createTask).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('files again only after the quiet period once a person closed the issue, and never on an unknown state', async () => {
    const { db } = seededLedger([...enospc(['T-1', 'T-2', 'T-3']), ...enospc(['T-4', 'T-5', 'T-6'], NOW + WEEK - 2 * HOUR), ...enospc(['T-7', 'T-8', 'T-9'], NOW + 5 * WEEK - 2 * HOUR)]);
    let lookup: { ok: true; issue: { state: string; stateType?: string } } | { ok: false; error: string } = { ok: false, error: 'tracker down' };
    const src = { ...source(), addComment: vi.fn(async () => {}), lookupIssueState: vi.fn(async () => lookup) };
    await runFailureTaxonomy({ db, taskSource: src, now: NOW });
    expect((await runFailureTaxonomy({ db, taskSource: src, now: NOW + WEEK })).filed).toEqual([]);
    lookup = { ok: true, issue: { state: 'Canceled', stateType: 'canceled' } };
    expect((await runFailureTaxonomy({ db, taskSource: src, now: NOW + 5 * WEEK })).filed).toEqual(['AGT-902']);
    db.close();
  });

  it('one candidate throwing does not drop the others', async () => {
    const attempts = [
      ...enospc(['T-1', 'T-2', 'T-3']),
      ...['T-4', 'T-5', 'T-6'].map((issue, i) => ({ issue, attempt: 1 + i, message: 'blocked_by_dependency: needs a client decision' })),
    ];
    const { db } = seededLedger(attempts);
    let calls = 0;
    const src = {
      createTask: vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('Linear 500'); return { id: 'uuid-2', identifier: 'AGT-902' }; }),
      updateState: vi.fn(async () => true),
    };
    const result = await runFailureTaxonomy({ db, taskSource: src, now: NOW });
    expect(result.candidates).toHaveLength(2);
    expect(result.filed).toEqual(['AGT-902']);
    db.close();
  });

  it('the same unnamed cause keeps one id across numbers, dates and PR numbers', () => {
    const a = classifyCause('worker: tsc exited with code 137 (PR #812) on 2026-10-20 09:00');
    const b = classifyCause('worker: tsc exited with code 1 (PR #813) on 2026-10-27 10:15');
    expect(a.id.startsWith('other:')).toBe(true);
    expect(a.id).toBe(b.id);
  });

  it.each([
    ['pr-review: changes requested: release notes missing entry', 'review_changes_requested'],
    ['pr-review: changes requested: reviewer would approve once tests added', 'review_changes_requested'],
    ['verify-runner: infrastructure failure — failed to release lock', 'verify_infra_failure'],
    ['Please write the release notes for this change', 'other'],
  ])('a stage-stamped or bare-word record is not misread: %s', (text, cause) => {
    expect(classifyCause(text).id.startsWith(cause)).toBe(true);
  });

  it('redacts secret-shaped values from the filed title and body', () => {
    const leak = 'worker: curl failed with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 set';
    const [candidate] = aggregateTaxonomy([
      { source: 'attempt', issue: 'A', session: 'A#1', text: leak, at: NOW },
      { source: 'attempt', issue: 'B', session: 'B#1', text: leak, at: NOW },
      { source: 'attempt', issue: 'C', session: 'C#1', text: leak, at: NOW },
    ]);
    const { title, description } = composeCandidateIssue(candidate, { since: NOW - WEEK, until: NOW });
    expect(`${title}\n${description}`).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(description).toContain('[redacted]');
  });

  it('reads question threads from the durable trace, once per thread, merged with the board', async () => {
    const { db } = seededLedger([]);
    db.exec(`CREATE TABLE IF NOT EXISTS coordination_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, correlation_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', task_label TEXT, summary TEXT NOT NULL DEFAULT '')`);
    const q = db.prepare('INSERT INTO coordination_trace(timestamp, kind, status, correlation_id, task_label, summary) VALUES (?, ?, ?, ?, ?, ?)');
    const ask = 'Do you authorise the release workflow_dispatch?';
    // Each thread is paged: 'waiting' then 'running' under one id.
    for (const [id, issue] of [['hq-0000000000000a01', 'Q-1'], ['hq-0000000000000a02', 'Q-2']] as const) {
      q.run(NOW - 3 * HOUR, 'human-question', 'waiting', id, issue, ask);
      q.run(NOW - 3 * HOUR + 1000, 'human-question', 'running', id, issue, ask);
    }
    // The board still holds one of the two threads.
    const coordinationPath = board([{ issue: 'Q-2', id: 'hq-0000000000000a02', text: ask }]);
    const result = await runFailureTaxonomy({ db, coordinationPath, now: NOW, force: true, minSignals: 2 });
    db.close();
    const deploy = result.candidates.find(c => c.id === 'human_only_deploy');
    expect(deploy?.signals).toBe(2);
    expect(deploy?.sessions).toEqual(['hq-0000000000000a01', 'hq-0000000000000a02']);
    // Four trace rows plus a board copy are still two questions: below a floor of three.
    const strict = seededLedger([]).db;
    expect(aggregateTaxonomy(mergeSignals([], [
      { source: 'question', issue: 'Q-1', session: 'hq-1', text: ask, at: NOW },
      { source: 'question', issue: 'Q-1', session: 'hq-1', text: ask, at: NOW + 1 },
      { source: 'question', issue: 'Q-2', session: 'hq-2', text: ask, at: NOW },
      { source: 'question', issue: 'Q-2', session: 'hq-2', text: ask, at: NOW + 1 },
    ]))).toEqual([]);
    strict.close();
  });

  it('counts an attempt the in-pipeline reviewer rejected, even without a message', async () => {
    const { db } = seededLedger(['R-1', 'R-2', 'R-3'].map((issue, i) => ({ issue, attempt: i + 1, message: '', status: 'rejected' })));
    const result = await runFailureTaxonomy({ db, now: NOW, force: true });
    db.close();
    expect(result.candidates.map(c => c.id)).toContain('review_changes_requested');
  });

  it('drops an attempt waiting on several questions when the board holds them', () => {
    const waiting: FailureSignal = { source: 'attempt', issue: 'A', session: 'A#1', text: 'Waiting for operator answers (hq-00000000000000aa, hq-00000000000000bb)', at: NOW };
    const asked: FailureSignal = { source: 'question', issue: 'A', session: 'hq-00000000000000bb', text: 'which DSN?', at: NOW };
    expect(mergeSignals([waiting], [asked])).toEqual([asked]);
  });
});
