// View model of the desktop ADE workspace (desktop/dist/ade/model.js).
// The page itself is plain ES modules bundled into the Tauri app; its
// decisions are pure functions so they are tested here without a WebView.

import { describe, expect, it } from 'vitest';
// Plain JS module shipped as-is in the app bundle (tests/ is not typechecked).
import * as model from '../../desktop/dist/ade/model.js';

describe('ADE session list', () => {
  it('orders running, then queued, then recent, newest first, without duplicates', () => {
    const rows = model.sessionRows({
      runnerAvailable: true,
      sessions: [
        { taskId: 'q1', title: 'Queued', projectPath: '/r/a', startedAt: 50, status: 'queued' },
        { taskId: 'r1', title: 'Old run', projectPath: '/r/a', startedAt: 10, status: 'running', stage: 'worker' },
        { taskId: 'r2', title: 'New run', issueIdentifier: 'INT-2', projectPath: '/r/b/', startedAt: 20, status: 'running' },
      ],
      recent: [
        { taskId: 'd1', title: 'Done', status: 'completed', finalStatus: 'approved', completedAt: 5, durationMs: 1 },
        { taskId: 'r1', title: 'Old run (earlier attempt)', status: 'failed', finalStatus: 'rejected', completedAt: 9, durationMs: 1 },
        { taskId: 'f1', title: 'Failed', status: 'failed', finalStatus: 'infra_error', completedAt: 7, durationMs: 1, failureCause: 'ENOSPC' },
      ],
    });

    expect(rows.map((r: { taskId: string }) => r.taskId)).toEqual(['r2', 'r1', 'q1', 'f1', 'd1']);
    expect(rows[0]).toMatchObject({ issue: 'INT-2', project: 'b', live: true, status: 'running' });
    expect(rows[3]).toMatchObject({ status: 'failed', finalStatus: 'infra_error', failureCause: 'ENOSPC', live: false });
  });

  it('tolerates a daemon with no runner', () => {
    expect(model.sessionRows({ runnerAvailable: false, sessions: [], recent: [] })).toEqual([]);
    expect(model.sessionRows(undefined)).toEqual([]);
  });
});

describe('ADE live log', () => {
  it('merges a snapshot and live lines by seq, dropping duplicates and keeping order', () => {
    const snapshot = model.snapshotLines({
      taskId: 't', gen: 'g1', truncated: false,
      lines: [{ stage: 'worker', line: 'a', ts: 1, seq: 1 }, { stage: 'worker', line: 'b', ts: 1, seq: 2 }],
    });
    const live = [
      model.logLineFromEvent({ type: 'log', data: { taskId: 't', stage: 'worker', line: 'b', seq: 2, gen: 'g1' } }, 't'),
      model.logLineFromEvent({ type: 'log', data: { taskId: 't', stage: 'tester', line: 'c', seq: 3, gen: 'g1' } }, 't'),
    ];
    const merged = model.mergeLog(model.mergeLog([], live), snapshot);
    expect(merged.map((l: { line: string }) => l.line)).toEqual(['a', 'b', 'c']);
  });

  it('ignores another task, non-log events and lines without a seq', () => {
    expect(model.logLineFromEvent({ type: 'log', data: { taskId: 'other', line: 'x', seq: 1 } }, 't')).toBeNull();
    expect(model.logLineFromEvent({ type: 'task:started', data: { taskId: 't' } }, 't')).toBeNull();
    expect(model.logLineFromEvent({ type: 'log', data: { taskId: 't', line: 'x' } }, 't')).toBeNull();
  });

  it('restarts the transcript when the daemon generation changes, and caps its length', () => {
    const old = [{ stage: 's', line: 'old', seq: 900, gen: 'g1' }];
    const fresh = [{ stage: 's', line: 'new', seq: 1, gen: 'g2' }];
    expect(model.mergeLog(old, fresh).map((l: { line: string }) => l.line)).toEqual(['new']);

    const many = Array.from({ length: 30 }, (_, i) => ({ stage: 's', line: String(i), seq: i }));
    expect(model.mergeLog([], many, 10).map((l: { seq: number }) => l.seq)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it('refreshes the session list only on lifecycle events', () => {
    for (const type of ['task:queued', 'task:started', 'task:completed', 'pipeline:stage']) {
      expect(model.eventChangesSessions({ type })).toBe(true);
    }
    expect(model.eventChangesSessions({ type: 'log' })).toBe(false);
  });

  it('pulls verification lines out of the transcript and classifies them', () => {
    const lines = model.verificationLines([
      { stage: 'worker', line: 'editing', seq: 1 },
      { stage: 'tester', line: 'npm test: 12 passed', seq: 2 },
      { stage: 'tester', line: 'FAIL src/a.test.ts', seq: 3 },
      { stage: 'verify', line: 'running lint', seq: 4 },
    ]);
    expect(lines).toEqual([
      { seq: 2, text: 'npm test: 12 passed', kind: 'pass' },
      { seq: 3, text: 'FAIL src/a.test.ts', kind: 'fail' },
      { seq: 4, text: 'running lint', kind: 'info' },
    ]);
  });
});

describe('ADE diff and run status', () => {
  it('splits a unified diff per file with classified lines and counts', () => {
    const files = model.parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n'));

    expect(files.map((f: { path: string; additions: number; deletions: number }) => [f.path, f.additions, f.deletions]))
      .toEqual([['src/a.ts', 1, 1], ['new.txt', 1, 0]]);
    expect(files[0].lines.map((l: { kind: string }) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
    expect(model.parseUnifiedDiff('')).toEqual([]);
  });

  it('summarizes the durable run state with the one reason a person needs', () => {
    const now = 1_000_000;
    expect(model.summarizeRun({ state: 'NEEDS_HUMAN', attemptNo: 2, lastErrorMessage: 'active_tests_removed' }, now))
      .toMatchObject({ state: 'NEEDS_HUMAN', tone: 'bad', attempt: 2, detail: 'active_tests_removed' });
    expect(model.summarizeRun({ state: 'RETRY_AT', retryAt: now + 125_000 }, now))
      .toMatchObject({ tone: 'warn', detail: 'retries in 2m 5s' });
    expect(model.summarizeRun({ state: 'DONE', prUrl: 'https://github.com/o/r/pull/9' }, now))
      .toMatchObject({ tone: 'ok', prUrl: 'https://github.com/o/r/pull/9' });
    expect(model.summarizeRun({ state: 'DONE', prUrl: 'javascript:alert(1)' }, now).prUrl).toBeUndefined();
    expect(model.summarizeRun(null)).toMatchObject({ state: 'UNKNOWN', tone: 'idle' });
  });

  it('formats ages and durations for a glance', () => {
    expect(model.formatDuration(3_725_000)).toBe('1h 2m');
    expect(model.formatDuration(45_000)).toBe('45s');
    expect(model.formatAge(0)).toBe('');
    expect(model.formatAge(1000, 2000)).toBe('just now');
    expect(model.formatAge(0 + 1, 3 * 3_600_000)).toBe('3h ago');
  });

  it('only lets http(s) links leave the app', () => {
    expect(model.safeExternalUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(model.safeExternalUrl('file:///etc/passwd')).toBeNull();
    expect(model.safeExternalUrl('not a url')).toBeNull();
  });
});
