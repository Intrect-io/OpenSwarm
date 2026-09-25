import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { consecutiveIdenticalVerdictsInDb, infraFailureFingerprint } from './infraFailureCircuit.js';

describe('infraFailureFingerprint', () => {
  it('ignores what changes between attempts and keeps what identifies the cause', () => {
    const a = infraFailureFingerprint(
      "verify-security: pytest could not run inside the attested companion: [security] strict verification sandbox unavailable: ENOENT: no such file or directory, lstat '/run/openswarm-sandbox' (took 1.93s)",
    );
    const b = infraFailureFingerprint(
      "verify-security: pytest could not run inside the attested companion: [security] strict verification sandbox unavailable: ENOENT: no such file or directory, lstat '/run/openswarm-sandbox' (took 2.41s)",
    );
    expect(a).toBe(b);
    expect(a).toContain("lstat '/run/openswarm-sandbox'");
  });

  it('collapses sandbox roots and worktree ids', () => {
    const a = infraFailureFingerprint('tester: pytest infrastructure failure in /work/.openswarm-verify-base-3zSAeP/worktree/ (worktree/fa265da7-a479-45f5-8ee3-d603465d98d6)');
    const b = infraFailureFingerprint('tester: pytest infrastructure failure in /work/.openswarm-verify-base-UY8fMU/worktree/ (worktree/9241f3b4-01c5-44a1-9d3f-77ea8037df3d)');
    expect(a).toBe(b);
  });

  it('keeps different causes apart and is empty for no detail', () => {
    expect(infraFailureFingerprint('tester: openrouter timeout after 360000ms'))
      .not.toBe(infraFailureFingerprint('security-audit: CodeQL extractor missing for go'));
    expect(infraFailureFingerprint(undefined)).toBe('');
  });
});

describe('consecutiveIdenticalVerdictsInDb', () => {
  type Row = [status: string | null, code: string | null, message: string | null];
  const SCOPE = 'worker-scope: changed files outside declared fileScope: apps/pipelines/tests/test_check_meta_webhook_setup.py';

  function ledger(rows: Row[]): Database.Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE automation_attempts (
      issue_id TEXT, attempt_no INTEGER, lease_epoch INTEGER, finished_at INTEGER,
      result_status TEXT, error_code TEXT, error_message TEXT)`);
    const insert = db.prepare('INSERT INTO automation_attempts VALUES (?,?,?,?,?,?,?)');
    rows.forEach(([status, code, message], i) => insert.run('i1', i + 1, 1, 1000 + i, status, code, message));
    return db;
  }

  // The real sequence from cgf-portal AX-1027 attempts 25–33 on 2026-09-17.
  it('sees through restarts and timeouts between two identical refusals', () => {
    const db = ledger([
      ['failed', 'failed', SCOPE],
      [null, 'owner_process_exited', 'Executor owner process exited before a terminal transition'],
      [null, 'owner_process_exited', 'Executor owner process exited before a terminal transition'],
      ['cancelled', 'shutdown_cancelled', null],
      ['infra_error', 'infra_error', 'tester: openrouter timeout after 360000ms'],
      ['infra_error', 'infra_error', 'tester: openrouter timeout after 360000ms'],
      ['superseded', 'superseded', null],
      ['failed', 'failed', SCOPE],
    ]);
    expect(consecutiveIdenticalVerdictsInDb(db, 'i1')).toBe(2);
  });

  it('counts one for a first verdict and zero for a run with none', () => {
    expect(consecutiveIdenticalVerdictsInDb(ledger([['failed', 'failed', SCOPE]]), 'i1')).toBe(1);
    expect(consecutiveIdenticalVerdictsInDb(ledger([['infra_error', 'infra_error', 'x']]), 'i1')).toBe(0);
    expect(consecutiveIdenticalVerdictsInDb(ledger([]), 'i1')).toBe(0);
  });

  it('stops at a different verdict, a different code, or progress', () => {
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'failed', SCOPE],
      ['failed', 'failed', 'worker-scope: changed files outside declared fileScope: docs/other.md'],
      ['failed', 'failed', SCOPE],
    ]), 'i1')).toBe(1);
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'worker_no_changes', SCOPE],
      ['failed', 'publication_scope_mismatch', SCOPE],
    ]), 'i1')).toBe(1);
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'failed', SCOPE],
      ['approved', null, null],
      ['failed', 'failed', SCOPE],
    ]), 'i1')).toBe(1);
  });

  it('never builds a streak out of reviewer prose, which differs every attempt', () => {
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'failed', 'Core wiring exists, but the hard gate lacks execution evidence.'],
      ['failed', 'failed', 'Hard-gate production evidence is absent. The implementation contains partial wiring.'],
    ]), 'i1')).toBe(1);
  });

  it('treats timing noise inside a deterministic message as the same verdict', () => {
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'failed', '[pytest] 3 failed, 120 passed in 12.4s'],
      ['failed', 'failed', '[pytest] 3 failed, 120 passed in 9.81s'],
    ]), 'i1')).toBe(2);
  });

  it('does not extend a streak across an attempt that left no message', () => {
    expect(consecutiveIdenticalVerdictsInDb(ledger([
      ['failed', 'failed', SCOPE],
      ['failed', 'failed', null],
      ['failed', 'failed', SCOPE],
    ]), 'i1')).toBe(1);
  });
});
