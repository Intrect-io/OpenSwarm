// The DOM-free half of the issue board's console recovery path (INT-3397):
// lines that arrive before their card exists are parked, bounded, and moved —
// never duplicated — when the card materializes. This file lives under tests/
// (not src/) because it imports a browser ESM asset; vitest transpiles it,
// while `tsc -p .` only covers src/.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { PendingLogBuffer } from '../../web/static/js/pendingLogBuffer.mjs';

type Entry = { stage: string; line: string };
const entry = (line: string, stage = 'worker'): Entry => ({ stage, line });

describe('PendingLogBuffer', () => {
  it('parks lines and moves them out in arrival order exactly once', () => {
    const buffer = new PendingLogBuffer();
    buffer.park('t1', entry('first'));
    buffer.park('t1', entry('second'));
    buffer.park('t1', entry('third', 'reviewer'));

    const flushed = buffer.takeFor('t1');
    expect(flushed.map((e: Entry) => e.line)).toEqual(['first', 'second', 'third']);
    // Moved, not copied — a second take yields nothing (no duplication).
    expect(buffer.takeFor('t1')).toEqual([]);
    expect(buffer.taskCount).toBe(0);
  });

  it('returns an empty array for a task that never parked anything', () => {
    const buffer = new PendingLogBuffer();
    expect(buffer.takeFor('unknown')).toEqual([]);
  });

  it('caps lines per task by dropping the oldest', () => {
    const buffer = new PendingLogBuffer({ maxLines: 3 });
    for (const line of ['a', 'b', 'c', 'd', 'e']) buffer.park('t1', entry(line));
    expect(buffer.takeFor('t1').map((e: Entry) => e.line)).toEqual(['c', 'd', 'e']);
  });

  it('evicts the oldest task when the task cap is exceeded', () => {
    const buffer = new PendingLogBuffer({ maxTasks: 2 });
    buffer.park('t1', entry('one'));
    buffer.park('t2', entry('two'));
    buffer.park('t3', entry('three')); // evicts t1

    expect(buffer.takeFor('t1')).toEqual([]);
    expect(buffer.takeFor('t2').map((e: Entry) => e.line)).toEqual(['two']);
    expect(buffer.takeFor('t3').map((e: Entry) => e.line)).toEqual(['three']);
  });

  it('parking again after a take starts a fresh queue (task id reuse)', () => {
    const buffer = new PendingLogBuffer();
    buffer.park('t1', entry('old'));
    buffer.takeFor('t1');
    buffer.park('t1', entry('new'));
    expect(buffer.takeFor('t1').map((e: Entry) => e.line)).toEqual(['new']);
  });

  it('an existing task queue does not count as a new task for eviction', () => {
    const buffer = new PendingLogBuffer({ maxTasks: 2 });
    buffer.park('t1', entry('one'));
    buffer.park('t2', entry('two'));
    // t1 already has a queue — parking more must not evict anyone.
    buffer.park('t1', entry('one-more'));
    expect(buffer.taskCount).toBe(2);
    expect(buffer.takeFor('t2').map((e: Entry) => e.line)).toEqual(['two']);
  });
});
