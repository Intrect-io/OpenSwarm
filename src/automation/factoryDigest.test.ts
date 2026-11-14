import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunLedger } from './runLedger.js';
import { computeFactoryDigest, formatFactoryDigest, readFactoryDigest } from './factoryDigest.js';
import { handleFactoryDigest } from '../support/webFactoryDigest.js';
import type { ServerResponse } from 'node:http';

// AGT-4810: the digest's numbers against a fixture whose expected values were
// counted by hand (the comments next to each row), not recomputed by the code.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const H = 60 * 60_000;
const T = Date.parse('2026-11-14T00:00:00Z');

function fixtureDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-digest-'));
  roots.push(root);
  const dbPath = join(root, 'automation.db');
  new RunLedger(dbPath).close(); // the real schema
  const db = new Database(dbPath);
  const run = db.prepare(`
    INSERT INTO automation_runs(issue_id, source, identifier, title, project_path, state, discovered_at, updated_at, completed_at, pr_url, tracker_state, tracker_state_type)
    VALUES (?, 'linear', ?, 'T', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  run.run('r1', 'AGT-1', '/a', 'DONE', T - 2 * H, T + H, T + 1 * H, 'pr/1', 'Done', 'completed');      // merged, cycle 3 h
  run.run('r2', 'AGT-2', '/b', 'DONE', T + 1 * H, T + 5 * H, T + 5 * H, 'pr/2', 'Done', 'completed');  // merged, cycle 4 h
  run.run('r3', 'AGT-3', '/a', 'DONE', T, T + 3 * H, T + 3 * H, 'pr/3', null, null);                  // published, merge unconfirmed
  run.run('r4', 'AGT-4', '/a', 'DONE', T - 9 * H, T - H, T - 1 * H, 'pr/4', 'Done', 'completed');      // merged before the window
  run.run('r5', 'AGT-5', '/b', 'NEEDS_HUMAN', T, T + 9 * H, null, null, null, null);                   // parked now
  run.run('r6', 'AGT-6', '/a', 'EXECUTING', T, T + 10 * H, null, null, null, null);
  const attempt = db.prepare(`
    INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at, finished_at, result_status, success, cost_usd)
    VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?)
  `);
  attempt.run('r1', 1, 1, 'finished', T - 1 * H, T - 0.5 * H, 'approved', 1, 1.0);   // outside: finished and started before T
  attempt.run('r1', 2, 2, 'finished', T + 0.5 * H, T + 0.9 * H, 'approved', 1, 2.0);  // /a $2.00
  attempt.run('r2', 1, 1, 'finished', T + 2 * H, T + 4 * H, 'approved', 1, 3.5);      // /b $3.50
  attempt.run('r5', 1, 1, 'finished', T + 6 * H, T + 7 * H, 'failed', 0, null);       // /b unpriced
  attempt.run('r5', 2, 2, 'finished', T + 8 * H, T + 9 * H, 'infra_error', 0, 0.5);   // /b $0.50
  attempt.run('r6', 1, 1, 'running', T + 10 * H, null, null, null, null);             // /a unpriced, not finished
  const event = db.prepare(`INSERT INTO automation_events(issue_id, attempt_no, kind, created_at) VALUES (?, 1, ?, ?)`);
  event.run('r5', 'parked', T + 7 * H);                    // in window
  event.run('r5', 'operator_parked', T - 1 * H);           // before the window
  event.run('r5', 'operator_question_parked', T + 8 * H);  // in window
  event.run('r5', 'claimed', T + 8 * H);                   // not a park
  db.exec(`
    CREATE TABLE coordination_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, correlation_id TEXT NOT NULL);
    CREATE TABLE automation_pauses (scope TEXT PRIMARY KEY, mode TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const q = db.prepare('INSERT INTO coordination_trace(timestamp, kind, status, correlation_id) VALUES (?, ?, ?, ?)');
  q.run(T + 1 * H, 'human-question', 'open', 'q1');
  q.run(T + 2 * H, 'human-question', 'answered', 'q1');    // closed
  q.run(T + 3 * H, 'human-question', 'waiting', 'q2');     // open, oldest: 21 h at T+24h
  q.run(T + 10 * H, 'human-question', 'open', 'q3');
  q.run(T + 11 * H, 'human-question', 'running', 'q3');    // open
  q.run(T + 12 * H, 'status', 'open', 'x1');               // not a question
  db.prepare("INSERT INTO automation_pauses VALUES ('/b', 'drain', 'redispatch', 'auto:redispatch', ?)").run(T + 9 * H);
  const circuit = db.prepare('INSERT INTO automation_repo_circuits(project_path, reason, opened_at, open_until, updated_at) VALUES (?, ?, ?, ?, ?)');
  circuit.run('/a', 'failure circuit open: 6/6 in 1h', T + 23 * H, T + 25 * H, T + 23 * H); // open at T+24h
  circuit.run('/b', 'old', T, T + 2 * H, T);                                                // expired
  db.close();
  return dbPath;
}

describe('computeFactoryDigest against hand counts', () => {
  it('counts runs, questions, spend, pauses and KPIs exactly', () => {
    const db = new Database(fixtureDb(), { readonly: true });
    const d = computeFactoryDigest(db, { from: T, to: T + 24 * H });
    db.close();

    expect(d.runs).toEqual({
      merged: 2,
      publishedUnconfirmed: 1,
      parkedNow: 1,
      parkedInWindow: 2,
      finishedByStatus: { approved: 2, failed: 1, infra_error: 1 },
    });
    expect(d.questions).toEqual({ open: 2, oldestAgeMs: 21 * H });
    expect(d.spend).toEqual([
      { projectPath: '/b', costUsd: 4.0, attempts: 3, attemptsWithoutCost: 1 },
      { projectPath: '/a', costUsd: 2.0, attempts: 2, attemptsWithoutCost: 1 },
    ]);
    expect(d.pauses).toEqual([{ scope: '/b', mode: 'drain', reason: 'redispatch', actor: 'auto:redispatch', since: T + 9 * H }]);
    expect(d.circuits).toEqual([{ projectPath: '/a', reason: 'failure circuit open: 6/6 in 1h', openUntil: T + 25 * H }]);
    expect(d.kpis.costPerMergedIssueUsd).toBe(3.25); // (1.00 + 2.00 + 3.50) / 2
    expect(d.kpis.medianCycleTimeMs).toBe(3.5 * H); // median(3 h, 4 h)
    expect(d.kpis.mergedPerHumanMinute.measured).toBe(false);
    expect(d.kpis.postMergeDefectRate.measured).toBe(false);
    expect(d.kpis.wrongDispatchRate.measured).toBe(false);
  });

  it('renders not-measured KPIs as such, never as a number', () => {
    const text = formatFactoryDigest(readFactoryDigest(fixtureDb(), T + 24 * H));
    expect(text).toContain('merged 2, published (merge unconfirmed) 1, parked 2 in window / 1 now');
    expect(text).toContain('Questions waiting on you**: 2, oldest 21.0h');
    expect(text).toContain('b $4.00 (3 attempts, 1 unpriced); a $2.00 (2 attempts, 1 unpriced)');
    expect(text).toContain('cost per merged issue: $3.25');
    expect(text).toContain('median cycle time (discovered → merged): 3.5h');
    expect(text).toMatch(/merged changes per human minute: not measured \(/);
    expect(text).toMatch(/wrong-dispatch rate: not measured \(/);
    expect(text).not.toMatch(/human minute: 0/);
  });

  it('a missing database is an empty digest, not an error', () => {
    const d = readFactoryDigest(join(tmpdir(), 'openswarm-digest-missing', 'none.db'), T);
    expect(d.runs.merged).toBe(0);
    expect(formatFactoryDigest(d)).toContain('cost per merged issue: n/a (nothing merged)');
  });

  it('serves the digest on the dashboard route', () => {
    const dbPath = fixtureDb();
    const captured: { status?: number; body?: string } = {};
    const res = { writeHead(s: number) { captured.status = s; return res; }, end(b: string) { captured.body = b; } } as unknown as ServerResponse;
    vi.useFakeTimers();
    vi.setSystemTime(T + 24 * H);
    try {
      expect(handleFactoryDigest('/api/factory/digest', 'GET', res, dbPath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body!).digest.runs.merged).toBe(2);
    expect(handleFactoryDigest('/api/factory/other', 'GET', res, dbPath)).toBe(false);
  });
});
