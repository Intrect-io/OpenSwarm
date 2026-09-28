// Purpose: display bounds (AGT-3458) — every TUI presenter clips a value to the
// terminal's columns before rendering, so one pathological value (hundreds of
// newlines, an unbroken multi-KB string) can't wrap into a wall of physical rows
// and push a fullscreen frame off the layout. The bound must be terminal rows /
// display columns, never code units.
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { act } from 'react';
import { ChatLog } from './ChatLog.js';
import { ChatInput } from './ChatInput.js';
import { SelectList } from './SelectList.js';
import { LogLine } from './LogLine.js';
import { StageTimeline } from './StageTimeline.js';
import { AuditBoard } from './AuditBoard.js';
import { displayWidth } from '../../cli/reviewProgress.js';
import type { AuditArea } from '../../cli/reviewAudit.js';
import type { StageEntry } from '../pipelineEvents.js';
import type { ChatLine } from '../chatModel.js';

// ink-testing-library renders to a fixed-width 100-column stdout.
const COLUMNS = 100;
const rowsOf = (frame: string) => frame.split('\n');
const widestRow = (frame: string) => Math.max(...rowsOf(frame).map(displayWidth));

/** A single value holding 400 unbroken columns plus 500 newlines. */
const PATHOLOGICAL = `${'x'.repeat(400)}\n${'line\n'.repeat(500)}`;

const expectBounded = (frame: string, maxRows: number) => {
  expect(rowsOf(frame).length).toBeLessThanOrEqual(maxRows);
  expect(widestRow(frame)).toBeLessThanOrEqual(COLUMNS);
};

/** Rendered rows for a component at the harness's 24-row viewport. */
const VIEWPORT_ROWS = 24;

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ChatLog display bounds (AGT-3458)', () => {
  it('bounds a message with hundreds of newlines and an unbroken string', () => {
    const history: ChatLine[] = [{ role: 'user', content: PATHOLOGICAL }];
    const f = render(<ChatLog history={history} streaming={null} />).lastFrame()!;
    // The transcript as a whole must fit the viewport, not just one message.
    expectBounded(f, VIEWPORT_ROWS);
    expect(f).toContain('xxxx'); // still shown, just bounded
  });

  it('bounds a markdown reply the same way', () => {
    const history: ChatLine[] = [{ role: 'assistant', content: PATHOLOGICAL }];
    const f = render(<ChatLog history={history} streaming={null} />).lastFrame()!;
    expectBounded(f, 32);
  });

  it('bounds wide (Hangul/emoji) content by display columns, not code units', () => {
    // Markdown's reflow counts code units and skips lists/code, so a wide-char
    // paragraph used to re-wrap past a narrow frame even after the source clip.
    const wide = `가${'나'.repeat(400)}\n${'다\n'.repeat(300)}\n- ${'라'.repeat(200)}`;
    const history: ChatLine[] = [{ role: 'assistant', content: wide }];
    const f = render(<ChatLog history={history} streaming={null} />).lastFrame()!;
    expectBounded(f, 32);
    expect(f).toContain('가');
  });

  it('bounds the streaming preview to one row per tail line', () => {
    // Tail lines are themselves over-long, so the source-line cap alone is not
    // enough: each tail line must also be clipped to the terminal columns.
    // Exact budget: the `openswarm` label + the elision row + 14 tail lines.
    const f = render(<ChatLog history={[]} streaming={`${'line\n'.repeat(500)}${'x'.repeat(400)}`} />).lastFrame()!;
    expectBounded(f, 16);
  });

  it('bounds each tool-activity line to one row', () => {
    const f = render(<ChatLog history={[]} streaming={''} activity={[PATHOLOGICAL]} busy />).lastFrame()!;
    expectBounded(f, 20);
    expect(f).toContain('xxxx');
  });

  it('leaves a normal conversation unchanged', () => {
    const history: ChatLine[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'use **bold** here' },
    ];
    const f = render(<ChatLog history={history} streaming={'typing…'} />).lastFrame()!;
    expect(f).toContain('hello');
    expect(f).toContain('bold');
    expect(f).toContain('typing…');
    expect(f).not.toContain('…line'); // no elision marker on an ordinary reply
  });
});

describe('ChatInput display bounds (AGT-3458)', () => {
  it('clips the display but still submits the full controlled value', async () => {
    const onSubmit = vi.fn();
    const r = render(
      <ChatInput value={PATHOLOGICAL} active onChange={() => {}} onSubmit={onSubmit} />,
    );
    const f = r.lastFrame()!;
    expect(rowsOf(f).length).toBeLessThanOrEqual(3); // round border: top / content / bottom
    expect(widestRow(f)).toBeLessThanOrEqual(COLUMNS);
    expect(f).not.toContain('line'); // the newline tail is not rendered

    r.stdin.write('\r'); // Enter
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(PATHOLOGICAL);
  });

  it('leaves a normal value unchanged', () => {
    const f = render(<ChatInput value="hello" active onChange={() => {}} onSubmit={() => {}} />).lastFrame()!;
    expect(f).toContain('hello');
    expect(rowsOf(f).length).toBeLessThanOrEqual(3);
  });
});

describe('SelectList display bounds (AGT-3458)', () => {
  it('keeps a pathological item on one row', () => {
    const f = render(<SelectList title="Model" items={[PATHOLOGICAL, 'sonnet']} />).lastFrame()!;
    expectBounded(f, 5); // margin + title + 2 items + footer
    expect(f).toContain('sonnet');
  });

  it('leaves normal items unchanged', () => {
    const f = render(<SelectList title="Provider" items={['claude', 'codex']} selectedIndex={1} />).lastFrame()!;
    expect(f).toContain('Provider');
    expect(f).toContain('claude');
    expect(f).toContain('❯ codex');
  });
});

describe('LogLine display bounds (AGT-3458)', () => {
  it('keeps a pathological log line on one row', () => {
    const f = render(<LogLine line={`[worker] [p | INT-1 | worktree/a] ${PATHOLOGICAL}`} />).lastFrame()!;
    expectBounded(f, 1);
  });

  it('leaves a normal line unchanged', () => {
    const f = render(<LogLine line="[worker] [p | INT-1918 | worktree/0cc4e232] Codex turn completed" />).lastFrame()!;
    expect(f).toContain('INT-1918');
    expect(f).toContain('Codex turn completed');
  });
});

describe('StageTimeline display bounds (AGT-3458)', () => {
  it('keeps a pathological stage on one row', () => {
    const stages: StageEntry[] = [{ taskId: 't', stage: PATHOLOGICAL, status: 'complete' }];
    const f = render(<StageTimeline stages={stages} />).lastFrame()!;
    expectBounded(f, 2); // heading + one stage row
  });

  it('leaves a normal stage unchanged', () => {
    const stages: StageEntry[] = [
      { taskId: 't', stage: 'reviewer', status: 'complete', model: 'sonnet', durationMs: 5000, decision: 'approve' },
    ];
    const f = render(<StageTimeline stages={stages} />).lastFrame()!;
    expect(f).toContain('reviewer');
    expect(f).toContain('sonnet');
    expect(f).toContain('5s');
    expect(f).toContain('approve');
  });
});

describe('AuditBoard display bounds (AGT-3458)', () => {
  it('keeps a pathological area label on the running row', async () => {
    const areas: AuditArea[] = [{ label: PATHOLOGICAL, dir: 'src/a', files: ['src/a/x.ts'] }];
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={1} events={events} />);
    await act(tick);
    // The label was rendered unsanitized-for-width pre-fix: 400 unbroken columns
    // plus 500 newlines wrapped the single row into a screenful.
    await act(async () => {
      events.emit('progress', { type: 'start', label: PATHOLOGICAL, done: 0, total: 1 });
      await tick();
    });
    const f = r.lastFrame()!;
    expectBounded(f, 3); // header + running row + tally
    expect(f).toContain('x'); // the label is still shown, just clipped
  });

  it('keeps a pathological progress log on the area row', async () => {
    // A log made of newlines defeats the old code-unit cap: 48 code units of
    // `\n` still rendered 49 rows.
    const areas: AuditArea[] = [{ label: 'src/a', dir: 'src/a', files: ['src/a/x.ts'] }];
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={1} events={events} />);
    await act(tick);
    await act(async () => {
      events.emit('progress', { type: 'start', label: 'src/a', done: 0, total: 1 });
      events.emit('progress', { type: 'log', label: 'src/a', line: `${'\n'.repeat(300)}${'x'.repeat(400)}` });
      await tick();
    });
    expectBounded(r.lastFrame()!, 4);
    expect(r.lastFrame()).toContain('src/a');
  });

  it('leaves a normal progress log unchanged', async () => {
    const areas: AuditArea[] = [{ label: 'src/a', dir: 'src/a', files: ['src/a/x.ts'] }];
    const events = new EventEmitter();
    const r = render(<AuditBoard areas={areas} concurrency={1} events={events} />);
    await act(tick);
    await act(async () => {
      events.emit('progress', { type: 'start', label: 'src/a', done: 0, total: 1 });
      events.emit('progress', { type: 'log', label: 'src/a', line: 'Git detected 3 changed file(s): a, b, c' });
      await tick();
    });
    const f = r.lastFrame()!;
    expect(f).toContain('Git detected 3 changed file(s): a, b, c');
    expectBounded(f, 4);
  });
});
