import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLedger } from './runLedger.js';
import { aggregateFailureBuckets, composeRetrospectiveIssue, runLedgerRetrospective } from './ledgerRetrospective.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000;

function seededDb(rows: Array<{ issue: string; attempt: number; message: string; finishedAt?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-retro-'));
  roots.push(root);
  const path = join(root, 'automation.db');
  new RunLedger(path).close(); // creates the real schema
  const db = new Database(path);
  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO automation_runs(issue_id, source, identifier, project_path, state, discovered_at, updated_at)
    VALUES (?, 'linear', ?, '/repo', 'RETRY_AT', ?, ?)
  `);
  const insertAttempt = db.prepare(`
    INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at, finished_at, error_message, success)
    VALUES (?, ?, 1, 'suspended', 'RETRY_AT', ?, ?, ?, 0)
  `);
  for (const row of rows) {
    const finishedAt = row.finishedAt ?? NOW - 60_000;
    insertRun.run(`uuid-${row.issue}`, row.issue, finishedAt - 1000, finishedAt);
    insertAttempt.run(`uuid-${row.issue}`, row.attempt, finishedAt - 1000, finishedAt, row.message);
  }
  db.close();
  return path;
}

function fakeSource() {
  return {
    createTask: vi.fn(async (title: string) => ({ id: 'issue-uuid', identifier: 'AGT-9001', title })),
    updateState: vi.fn(async () => true),
  };
}

// The lane encodes the operator's 2026-09-02 steering: aggregate the ledger,
// pick the largest cross-issue bucket, file one evidence-rich issue, hand it
// to the normal pipeline. Measurement is deterministic — no LLM.
describe('ledger retrospective lane', () => {
  const scopeMsg = 'publication-scope: branch contains files outside reserved write scope: uv.lock';
  const bigBucket = Array.from({ length: 7 }, (_, i) => ({ issue: `AX-${860 + (i % 3)}`, attempt: i + 1, message: scopeMsg }));

  it('aggregates normalized buckets largest-first with distinct issue counts', () => {
    const path = seededDb([
      ...bigBucket,
      { issue: 'AGT-1', attempt: 1, message: 'gh: HTTP 502' },
    ]);
    const db = new Database(path);
    const buckets = aggregateFailureBuckets(db, NOW - 3_600_000);
    db.close();

    expect(buckets[0]).toMatchObject({ attempts: 7, distinctIssues: 3 });
    expect(buckets[0].identifiers).toContain('AX-860');
    expect(buckets).toHaveLength(2);
  });

  it('files exactly one Todo issue for the top bucket, with measured numbers in the body', async () => {
    const source = fakeSource();
    const outcome = await runLedgerRetrospective({ taskSource: source, projectId: 'proj-1', dbPath: seededDb(bigBucket), now: NOW });

    expect(outcome).toMatchObject({ filed: true, identifier: 'AGT-9001' });
    const [title, description, projectId] = source.createTask.mock.calls[0];
    expect(title).toMatch(/^\[Retrospective\] /);
    expect(description).toContain('| Failed attempts | 7 |');
    expect(description).toContain('AX-860');
    expect(projectId).toBe('proj-1');
    expect(source.updateState).toHaveBeenCalledWith('issue-uuid', 'Todo');
  });

  it('skips buckets below the noise floor — one loud issue is not a systemic defect', async () => {
    const oneIssue = Array.from({ length: 10 }, (_, i) => ({ issue: 'AX-874', attempt: i + 1, message: scopeMsg }));
    const source = fakeSource();

    const outcome = await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: seededDb(oneIssue), now: NOW });

    expect(outcome).toMatchObject({ filed: false, reason: 'no bucket above the noise floor' });
    expect(source.createTask).not.toHaveBeenCalled();
  });

  it('runs at most once per interval, and never refiles a fingerprint inside the dedupe window', async () => {
    const path = seededDb(bigBucket);
    const source = fakeSource();

    expect((await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: path, now: NOW })).filed).toBe(true);
    // Same day: interval gate.
    expect((await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: path, now: NOW + 60_000 })).reason).toBe('interval');
    // Next day, same bucket still failing: fingerprint dedupe.
    const db = new Database(path);
    const later = NOW + 25 * 3_600_000;
    db.prepare('UPDATE automation_attempts SET finished_at = ?').run(later - 60_000);
    db.close();
    const third = await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: path, now: later });
    expect(third).toMatchObject({ filed: false, reason: 'no bucket above the noise floor' });
    expect(source.createTask).toHaveBeenCalledTimes(1);
  });

  it('stamps the interval even on a quiet pass, so an empty day does not shorten the next one', async () => {
    const path = seededDb([]);
    const source = fakeSource();

    expect((await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: path, now: NOW })).reason).toBe('no failures in window');
    expect((await runLedgerRetrospective({ taskSource: source, projectId: 'p', dbPath: path, now: NOW + 60_000 })).reason).toBe('interval');
  });

  it('composes a body that survives an ugly example verbatim but bounded', () => {
    const { title, description } = composeRetrospectiveIssue({
      fingerprint: 'x'.repeat(200), attempts: 9, distinctIssues: 4, maxAttemptNo: 53,
      identifiers: ['A-1'], example: 'y'.repeat(2000),
    }, 24);
    expect(title.length).toBeLessThanOrEqual('[Retrospective] '.length + 90);
    expect(description).toContain('y'.repeat(600));
    expect(description).not.toContain('y'.repeat(601));
  });
});
