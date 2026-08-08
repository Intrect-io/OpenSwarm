import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendTaskLog,
  cancelTaskLogCleanup,
  getTaskLog,
  scheduleTaskLogCleanup,
  TASK_LOG_MAX_BUFFERS,
  TASK_LOG_MAX_LINE_CHARS,
  TASK_LOG_RETENTION_MS,
  TASK_LOG_RING_SIZE,
  __resetTaskLogsForTests,
} from './taskLogStore.js';

beforeEach(() => {
  vi.useFakeTimers();
  __resetTaskLogsForTests();
});

afterEach(() => {
  __resetTaskLogsForTests();
  vi.useRealTimers();
});

describe('taskLogStore', () => {
  it('appends lines with stage and timestamp, and snapshots are copies', () => {
    appendTaskLog('t1', 'worker', 'hello', 111);
    appendTaskLog('t1', 'reviewer', 'world', 222);

    const snapshot = getTaskLog('t1')!;
    expect(snapshot.lines).toEqual([
      { stage: 'worker', line: 'hello', ts: 111 },
      { stage: 'reviewer', line: 'world', ts: 222 },
    ]);
    expect(snapshot.truncated).toBe(false);

    // Mutating the snapshot must not touch the ring (serialization safety).
    snapshot.lines.push({ stage: 'x', line: 'injected', ts: 0 });
    expect(getTaskLog('t1')!.lines).toHaveLength(2);
  });

  it('returns null for an unknown task', () => {
    expect(getTaskLog('nope')).toBeNull();
  });

  it('rotates the ring at capacity and flags truncation', () => {
    for (let i = 0; i < TASK_LOG_RING_SIZE + 5; i++) {
      appendTaskLog('t1', 'worker', `line ${i}`);
    }
    const snapshot = getTaskLog('t1')!;
    expect(snapshot.lines).toHaveLength(TASK_LOG_RING_SIZE);
    expect(snapshot.lines[0].line).toBe('line 5');
    expect(snapshot.truncated).toBe(true);
  });

  it('cuts oversized lines to the char cap and flags truncation', () => {
    appendTaskLog('t1', 'worker', 'x'.repeat(TASK_LOG_MAX_LINE_CHARS + 50));
    const snapshot = getTaskLog('t1')!;
    expect(snapshot.lines[0].line.length).toBe(TASK_LOG_MAX_LINE_CHARS + 1); // +ellipsis
    expect(snapshot.truncated).toBe(true);
  });

  it('deletes the buffer after the retention window post-completion', () => {
    appendTaskLog('t1', 'worker', 'done soon');
    scheduleTaskLogCleanup('t1');
    vi.advanceTimersByTime(TASK_LOG_RETENTION_MS - 1);
    expect(getTaskLog('t1')).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(getTaskLog('t1')).toBeNull();
  });

  it('a task id that comes back to life survives its stale cleanup timer', () => {
    appendTaskLog('t1', 'worker', 'first attempt');
    scheduleTaskLogCleanup('t1');
    // Retry reuses the task id — new lines arrive before the timer fires.
    vi.advanceTimersByTime(TASK_LOG_RETENTION_MS / 2);
    appendTaskLog('t1', 'worker', 'second attempt');
    vi.advanceTimersByTime(TASK_LOG_RETENTION_MS);
    expect(getTaskLog('t1')).not.toBeNull();
    expect(getTaskLog('t1')!.lines.map((l) => l.line)).toContain('second attempt');
  });

  it('cancelTaskLogCleanup keeps the buffer alive', () => {
    appendTaskLog('t1', 'worker', 'line');
    scheduleTaskLogCleanup('t1');
    cancelTaskLogCleanup('t1');
    vi.advanceTimersByTime(TASK_LOG_RETENTION_MS * 2);
    expect(getTaskLog('t1')).not.toBeNull();
  });

  it('evicts only completed buffers at the LRU cap, never running ones', () => {
    // Fill the cap with RUNNING tasks, then one more — nothing evictable, so
    // the cap is exceeded rather than holing a live transcript.
    for (let i = 0; i < TASK_LOG_MAX_BUFFERS; i++) {
      appendTaskLog(`run-${i}`, 'worker', 'live');
    }
    appendTaskLog('overflow', 'worker', 'still stored');
    expect(getTaskLog('run-0')).not.toBeNull();
    expect(getTaskLog('overflow')).not.toBeNull();

    // Mark the oldest as completed — the NEXT new buffer evicts exactly it.
    scheduleTaskLogCleanup('run-0');
    appendTaskLog('newcomer', 'worker', 'takes the slot');
    expect(getTaskLog('run-0')).toBeNull();
    expect(getTaskLog('run-1')).not.toBeNull();
    expect(getTaskLog('newcomer')).not.toBeNull();
  });
});
