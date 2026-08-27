import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { act } from 'react';
import { AuditBoard } from './AuditBoard.js';
import type { AuditArea, AuditProgress } from '../../cli/reviewAudit.js';

const areas: AuditArea[] = [
  { label: 'src/a', dir: 'src/a', files: ['src/a/x.ts'] },
  { label: 'src/b', dir: 'src/b', files: ['src/b/y.ts'] },
];

// Let the effect subscription register / React flush the state update.
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('AuditBoard (INT-2006)', () => {
  it('renders the header with area count and concurrency', () => {
    const events = new EventEmitter();
    const f = render(<AuditBoard areas={areas} concurrency={3} events={events} />).lastFrame()!;
    expect(f).toContain('Codebase audit');
    expect(f).toContain('0/2 areas');
    expect(f).toContain('concurrency 3');
  });

  it('shows a running area row and rolls up the tally on done', async () => {
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={2} events={events} />);
    await act(tick); // effect subscribes
    const emit = (e: AuditProgress) => events.emit('progress', e);

    await act(async () => {
      emit({ type: 'start', label: 'src/a', done: 0, total: 2 });
      await tick();
    });
    expect(r.lastFrame()).toContain('src/a');

    await act(async () => {
      emit({ type: 'done', label: 'src/a', decision: 'approve', done: 1, total: 2 });
      emit({ type: 'done', label: 'src/b', decision: 'reject', done: 2, total: 2 });
      await tick();
    });
    const f = r.lastFrame()!;
    expect(f).toContain('2/2 areas');
    expect(f).toContain('1 done'); // approve tally
    expect(f).toContain('1 reject');
  });

  it('counts an errored area in the failed tally', async () => {
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={2} events={events} />);
    await act(tick); // effect subscribes
    await act(async () => {
      events.emit('progress', { type: 'error', label: 'src/a', error: 'timeout', done: 1, total: 2 });
      await tick();
    });
    expect(r.lastFrame()).toContain('1 failed');
  });

  it('shows why an area failed, not just the tally (AGT-3990)', async () => {
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={2} events={events} />);
    await act(tick); // effect subscribes
    await act(async () => {
      events.emit('progress', {
        type: 'error',
        label: 'src/a',
        error: 'codex timeout after 300000ms',
        done: 1,
        total: 2,
      });
      await tick();
    });
    const f = r.lastFrame()!;
    expect(f).toContain('src/a');
    expect(f).toContain('codex timeout after 300000ms');
  });

  it('renders fix-pass progress with edited file tally', async () => {
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={2} events={events} mode="fix" />);
    await act(tick);

    await act(async () => {
      events.emit('progress', { type: 'start', label: 'src/a', done: 0, total: 2 });
      events.emit('progress', { type: 'log', label: 'src/a', line: '[Worker] Git detected 3 changed file(s): a, b, c' });
      await tick();
    });
    expect(r.lastFrame()).toContain('Review fix pass');
    expect(r.lastFrame()).toContain('src/a');
    expect(r.lastFrame()).toContain('Git detected 3 changed file');

    await act(async () => {
      events.emit('progress', { type: 'done', label: 'src/a', filesChanged: 3, done: 1, total: 2 });
      await tick();
    });
    const f = r.lastFrame()!;
    expect(f).toContain('1/2 areas');
    expect(f).toContain('1 edited');
    expect(f).toContain('3 files');
  });

  it('strips terminal controls from area labels and progress logs', async () => {
    const events = new EventEmitter();
    const unsafeAreas = [{ label: '\u001b]52;c;bad\u0007src/a', dir: 'src/a', files: ['src/a/x.ts'] }];
    const r = render(<AuditBoard areas={unsafeAreas} concurrency={1} events={events} />);
    await act(tick);
    await act(async () => {
      events.emit('progress', { type: 'start', label: unsafeAreas[0].label, done: 0, total: 1 });
      events.emit('progress', { type: 'log', label: unsafeAreas[0].label, line: '\u001b[31munsafe\u001b[0m' });
      await tick();
    });
    expect(r.lastFrame()).toContain('src/a');
    expect(r.lastFrame()).toContain('unsafe');
    expect(r.lastFrame()).not.toContain('\u001b');
  });
});
