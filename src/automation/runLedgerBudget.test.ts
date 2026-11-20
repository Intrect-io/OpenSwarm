import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';
import {
  DEFAULT_PER_ISSUE_ATTEMPTS_PER_DAY,
  ISSUE_ATTEMPT_BUDGET_PARK_REASON,
  ISSUE_BUDGET_PARK_REASON,
  costCeilingReasonWithAlert,
  dailySpend,
  issueAttemptsInWindow,
  issueSpend,
  resolvePerIssueAttemptsPerDay,
  setBudgetAlertSink,
} from './runLedgerCost.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

// AGT-4807: unattended runs spent without a ceiling — single issues were
// retried up to 18 times on 2026-10-20 (AGT-4787). A project over its daily
// budget must stop claiming and say so once; an issue over its own budget must
// park for a person.

const roots: string[] = [];
let alerts: string[] = [];

beforeEach(() => {
  alerts = [];
  setBudgetAlertSink((message) => { alerts.push(message); });
});

afterEach(() => {
  setBudgetAlertSink(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Let the alert, which is sent after the claim's tick, arrive. */
async function flushAlerts(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'osw-budget-'));
  roots.push(root);
  const path = join(root, 'automation.db');
  const ledger = new RunLedger(path);
  const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, infraFailureCircuit: 2 });
  const reader = new Database(path, { readonly: true });
  const close = () => { reader.close(); coordinator.close(); ledger.close(); };
  return { path, ledger, coordinator, reader, close };
}

/** A failed run waits in RETRY_AT; make it due now. */
function makeDue(path: string, issueId: string): void {
  const db = new Database(path);
  try {
    db.prepare('UPDATE automation_runs SET retry_at = 0 WHERE issue_id = ?').run(issueId);
  } finally {
    db.close();
  }
}

function task(id: string) {
  return { id, issueId: id, issueIdentifier: id.toUpperCase(), source: 'linear' as const, title: `Task ${id}`, priority: 2, createdAt: Date.now() };
}

/** A finished attempt that spent `costUsd` and failed, so the issue goes back to the queue. */
function spent(costUsd: number): PipelineResult {
  return {
    success: false, sessionId: 's', stages: [], finalStatus: 'failed', totalDuration: 1, iterations: 1,
    totalCost: { costUsd, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1 },
  };
}

describe('per-project daily budget (AGT-4807)', () => {
  it('a project over its daily budget gets 0 claims and exactly 1 alert', async () => {
    const { coordinator, close } = fixture();
    try {
      // The fixture ledger: one attempt today already spent $12 in /repo.
      await coordinator.execute(task('seed'), '/repo', async () => spent(12));

      const admission = { maxConcurrent: 4, maxCostUsdPerDay: 10 };
      const executor = vi.fn(async () => spent(1));
      const outcomes = [];
      for (const id of ['a', 'b', 'c', 'd']) {
        outcomes.push(await coordinator.execute(task(id), '/repo', executor, { admission }));
      }
      await flushAlerts();

      expect(executor).not.toHaveBeenCalled();
      expect(outcomes.every((outcome) => outcome.finalStatus === 'deferred')).toBe(true);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('repository daily cost budget exhausted: $12.0000/$10.0000');
      expect(alerts[0]).toContain('/repo');
    } finally {
      close();
    }
  });

  it('alerts once per project and UTC day however often the ceiling is asked', async () => {
    const { coordinator, path, close } = fixture();
    try {
      await coordinator.execute(task('seed'), '/repo', async () => spent(12));
      const db = new Database(path);
      try {
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
          expect(costCeilingReasonWithAlert(db, { maxCostUsdPerDay: 10 }, '/repo', now)).toMatch(/^repository daily cost budget exhausted/);
        }
        // Another project under its own budget is not affected and does not alert.
        expect(costCeilingReasonWithAlert(db, { maxCostUsdPerDay: 10 }, '/other', now)).toBeNull();
        await flushAlerts();
        expect(alerts).toHaveLength(1);

        // The next UTC day is a new budget, and a new trip alerts again.
        const tomorrow = now + 24 * 60 * 60_000;
        expect(dailySpend(db, tomorrow, { projectPath: '/repo' }).totalUsd).toBe(0);
        expect(costCeilingReasonWithAlert(db, { maxCostUsdPerDay: 10 }, '/repo', tomorrow)).toBeNull();
        await flushAlerts();
        expect(alerts).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      close();
    }
  });

  it('a project under its budget claims and does not alert', async () => {
    const { coordinator, close } = fixture();
    try {
      await coordinator.execute(task('seed'), '/repo', async () => spent(3));
      const executor = vi.fn(async () => spent(1));
      await coordinator.execute(task('a'), '/repo', executor, { admission: { maxConcurrent: 4, maxCostUsdPerDay: 10 } });
      await flushAlerts();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(alerts).toHaveLength(0);
    } finally {
      close();
    }
  });
});

describe('per-issue budget (AGT-4807)', () => {
  it('parks an issue over its budget NEEDS_HUMAN without running it, and the comment shows the spend', async () => {
    const { coordinator, ledger, reader, path, close } = fixture();
    try {
      await coordinator.execute(task('x'), '/repo', async () => spent(3));
      makeDue(path, 'x');
      await coordinator.execute(task('x'), '/repo', async () => spent(2.5));
      makeDue(path, 'x');

      const executor = vi.fn(async () => spent(1));
      const result = await coordinator.execute(task('x'), '/repo', executor, { admission: { maxConcurrent: 4, maxCostUsdPerIssue: 5 } });

      expect(executor).not.toHaveBeenCalled();
      expect(result.operatorPark?.code).toBe(ISSUE_BUDGET_PARK_REASON);
      // The runner posts this reason as the issue's one operator-park comment.
      expect(result.operatorPark?.reason).toContain('🧭 **[OpenSwarm]** This issue has spent $5.50 of its $5.00 budget');
      // The comment names the resume that actually lifts this park (an explicit
      // dispatch); a Todo move alone never calls resumeNeedsHuman for it.
      expect(result.operatorPark?.reason).toContain('dispatch it from the dashboard issue board to resume');
      expect(result.operatorPark?.reason).not.toContain('move it back to Todo to resume');
      const run = ledger.getRun('x');
      expect(run?.state).toBe('NEEDS_HUMAN');
      expect(run?.lastErrorCode).toBe(ISSUE_BUDGET_PARK_REASON);
      // The park ran no model, so it records no spend of its own.
      const attempts = reader.prepare('SELECT cost_usd FROM automation_attempts WHERE issue_id = ? ORDER BY attempt_no').all('x') as Array<{ cost_usd: number | null }>;
      expect(attempts.map((a) => a.cost_usd)).toEqual([3, 2.5, 0]);
    } finally {
      close();
    }
  });

  it('runs an issue under its budget', async () => {
    const { coordinator, path, close } = fixture();
    try {
      await coordinator.execute(task('y'), '/repo', async () => spent(1));
      makeDue(path, 'y');
      const executor = vi.fn(async () => spent(1));
      await coordinator.execute(task('y'), '/repo', executor, { admission: { maxConcurrent: 4, maxCostUsdPerIssue: 5 } });
      expect(executor).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it('a resume of some other park does not reset the issue budget', async () => {
    const { coordinator, path, close } = fixture();
    try {
      await coordinator.execute(task('w'), '/repo', async () => spent(6));
      const db = new Database(path);
      try {
        // What resumeNeedsHuman writes for an idle-fill lift of an unrelated park.
        const later = Date.now() + 10;
        db.prepare(`INSERT INTO automation_events(issue_id, attempt_no, kind, from_state, to_state, data_json, created_at)
          VALUES (?, 1, 'operator_resumed', 'NEEDS_HUMAN', 'READY', ?, ?)`)
          .run('w', JSON.stringify({ trigger: 'idle_fill', parkedUnder: 'publication_scope_mismatch' }), later);
        expect(issueSpend(db, 'w', later + 1).totalUsd).toBe(6);
      } finally {
        db.close();
      }
    } finally {
      close();
    }
  });

  it('an operator resume grants a fresh budget', async () => {
    const { coordinator, ledger, path, close } = fixture();
    try {
      await coordinator.execute(task('z'), '/repo', async () => spent(6));
      makeDue(path, 'z');
      const parked = await coordinator.execute(task('z'), '/repo', vi.fn(), { admission: { maxConcurrent: 4, maxCostUsdPerIssue: 5 } });
      expect(parked.operatorPark?.code).toBe(ISSUE_BUDGET_PARK_REASON);

      // The tracker reads Todo again (the operator moved the card back): that
      // alone neither reopens the park nor runs the issue.
      const todoExecutor = vi.fn(async () => spent(1));
      await coordinator.execute({ ...task('z'), linearState: 'Todo' }, '/repo', todoExecutor, { admission: { maxConcurrent: 4, maxCostUsdPerIssue: 5 } });
      expect(todoExecutor).not.toHaveBeenCalled();
      expect(ledger.getRun('z')?.state).toBe('NEEDS_HUMAN');

      const db = new Database(path);
      try {
        expect(issueSpend(db, 'z', Date.now()).totalUsd).toBe(6);
        // A free slot is not more budget: idle fill does not lift the park.
        expect(ledger.resumeNeedsHuman('z', Date.now(), 'idle_fill')).toBeNull();
        // Resume strictly after the spend was recorded, the way the park comment
        // tells the operator to: an explicit dispatch.
        expect(ledger.resumeNeedsHuman('z', Date.now() + 1, 'explicit_dispatch')).not.toBeNull();
        expect(issueSpend(db, 'z', Date.now() + 2).totalUsd).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      close();
    }
  });
});

describe('per-issue daily attempt budget (AGT-4787)', () => {
  const admission = { maxConcurrent: 4, maxAttemptsPerIssuePerDay: 3 };

  /** Three failed attempts, each made due again, so the issue is queued for a fourth. */
  async function threeAttempts(coordinator: ReturnType<typeof fixture>['coordinator'], path: string, id: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await coordinator.execute(task(id), '/repo', async () => spent(0.01), { admission });
      makeDue(path, id);
    }
  }

  it('parks an issue NEEDS_HUMAN after its daily attempt budget and claims nothing', async () => {
    const { coordinator, ledger, reader, path, close } = fixture();
    try {
      await threeAttempts(coordinator, path, 'q');

      const executor = vi.fn(async () => spent(1));
      const result = await coordinator.execute(task('q'), '/repo', executor, { admission });

      expect(executor).not.toHaveBeenCalled();
      expect(result.operatorPark?.code).toBe(ISSUE_ATTEMPT_BUDGET_PARK_REASON);
      expect(result.operatorPark?.reason).toContain('🧭 **[OpenSwarm]** This issue has started 3 of its 3 attempts in the last 24 hours');
      expect(result.operatorPark?.reason).toContain('autonomous.budget.perIssueAttemptsPerDay');
      expect(result.operatorPark?.reason).toContain('dispatch it from the dashboard issue board to resume');
      const run = ledger.getRun('q');
      expect(run?.state).toBe('NEEDS_HUMAN');
      expect(run?.lastErrorCode).toBe(ISSUE_ATTEMPT_BUDGET_PARK_REASON);
      // The park ran no model, so it records no spend of its own.
      const costs = reader.prepare('SELECT cost_usd FROM automation_attempts WHERE issue_id = ? ORDER BY attempt_no').all('q') as Array<{ cost_usd: number | null }>;
      expect(costs.map((a) => a.cost_usd)).toEqual([0.01, 0.01, 0.01, 0]);

      // Still parked: a Todo move, another dispatch tick and an idle fill neither
      // run the issue nor park it again, so its one comment stays one.
      const later = vi.fn(async () => spent(1));
      await coordinator.execute({ ...task('q'), linearState: 'Todo' }, '/repo', later, { admission });
      await coordinator.execute(task('q'), '/repo', later, { admission });
      expect(ledger.resumeNeedsHuman('q', Date.now(), 'idle_fill')).toBeNull();
      expect(later).not.toHaveBeenCalled();
      expect(ledger.getRun('q')?.state).toBe('NEEDS_HUMAN');
      const parks = reader.prepare(`SELECT COUNT(*) AS n FROM automation_events WHERE issue_id = ? AND kind = 'operator_parked'`).get('q') as { n: number };
      expect(parks.n).toBe(1);
    } finally {
      close();
    }
  });

  it('runs an issue under its attempt budget, and the window rolls', async () => {
    const { coordinator, path, close } = fixture();
    try {
      await coordinator.execute(task('u'), '/repo', async () => spent(0.01), { admission });
      makeDue(path, 'u');
      await coordinator.execute(task('u'), '/repo', async () => spent(0.01), { admission });
      makeDue(path, 'u');
      const executor = vi.fn(async () => spent(0.01));
      await coordinator.execute(task('u'), '/repo', executor, { admission });
      expect(executor).toHaveBeenCalledTimes(1);

      const db = new Database(path);
      try {
        const now = Date.now();
        expect(issueAttemptsInWindow(db, 'u', now).attempts).toBe(3);
        // An attempt started more than 24 hours ago is outside the window.
        db.prepare('UPDATE automation_attempts SET started_at = ? WHERE issue_id = ? AND attempt_no = 1').run(now - 24 * 60 * 60_000 - 1, 'u');
        expect(issueAttemptsInWindow(db, 'u', now).attempts).toBe(2);
        // Attempts that ended before any model call are not counted.
        db.prepare(`UPDATE automation_attempts SET result_status = 'rate_limited' WHERE issue_id = ? AND attempt_no = 2`).run('u');
        expect(issueAttemptsInWindow(db, 'u', now).attempts).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      close();
    }
  });

  it('resets the attempt count after an operator resume', async () => {
    const { coordinator, ledger, path, close } = fixture();
    try {
      await threeAttempts(coordinator, path, 'r');
      const parked = await coordinator.execute(task('r'), '/repo', vi.fn(), { admission });
      expect(parked.operatorPark?.code).toBe(ISSUE_ATTEMPT_BUDGET_PARK_REASON);

      const db = new Database(path);
      try {
        const now = Date.now();
        const lastStart = (db.prepare('SELECT MAX(started_at) AS at FROM automation_attempts WHERE issue_id = ?').get('r') as { at: number }).at;
        expect(issueAttemptsInWindow(db, 'r', lastStart).attempts).toBe(4);
        // A resume of some other park does not reset the count.
        db.prepare(`INSERT INTO automation_events(issue_id, attempt_no, kind, from_state, to_state, data_json, created_at)
          VALUES (?, 4, 'operator_resumed', 'NEEDS_HUMAN', 'READY', ?, ?)`)
          .run('r', JSON.stringify({ trigger: 'idle_fill', parkedUnder: 'publication_scope_mismatch' }), lastStart + 1);
        expect(issueAttemptsInWindow(db, 'r', lastStart + 2).attempts).toBe(4);
        // The explicit operator resume that grants a fresh USD budget grants fresh attempts.
        const resumeAt = Math.max(now, lastStart) + 5;
        expect(ledger.resumeNeedsHuman('r', resumeAt, 'explicit_dispatch')).not.toBeNull();
        expect(issueAttemptsInWindow(db, 'r', resumeAt + 1).attempts).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      close();
    }
  });

  it('defaults to 3 attempts when the config sets none', () => {
    expect(DEFAULT_PER_ISSUE_ATTEMPTS_PER_DAY).toBe(3);
    expect(resolvePerIssueAttemptsPerDay(undefined)).toBe(3);
    expect(resolvePerIssueAttemptsPerDay({})).toBe(3);
    expect(resolvePerIssueAttemptsPerDay({ perIssueAttemptsPerDay: 7 })).toBe(7);
  });
});
