// @vitest-environment jsdom
//
// The view is thin, but its wiring is where a graph silently becomes a blank
// page: a fetch shape mismatch, an unhooked selection, or an SSE event that
// never reaches the model. Drive it with a faked fetch and assert real DOM.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import {
  startOrchestrationView, edgeKey, nodeRadius, ROLE_COLORS, wireControls,
} from '../../web/static/js/orchestrationView.mjs';

function shell(): Document {
  document.body.innerHTML = `
    <div id="stats"></div>
    <div id="waiting"></div>
    <div id="controls">
      <input id="filter-search" type="search" />
      <select id="filter-task" data-options=""><option value="">all tasks</option></select>
      <select id="filter-role">
        <option value="">all roles</option>
        <option value="worker">worker</option>
        <option value="reviewer">reviewer</option>
      </select>
      <input id="filter-idle" type="checkbox" />
      <span id="idle-count"></span>
    </div>
    <svg id="graph"></svg>
    <div id="legend"></div>
    <div id="detail"></div>
    <div id="feed"></div>
    <div id="thread"></div>`;
  return document;
}

/** The controls are optional furniture; some hosts render the graph alone. */
function bareShell(): Document {
  document.body.innerHTML = `
    <div id="stats"></div>
    <svg id="graph"></svg>
    <div id="legend"></div>
    <div id="detail"></div>
    <div id="feed"></div>
    <div id="thread"></div>`;
  return document;
}

/** Built, never typed: a literal NUL in this file would defeat its own guard. */
const NUL = String.fromCharCode(0);

function boardEvent(over: Record<string, unknown> = {}) {
  return {
    id: `id-${Math.random()}`,
    seq: 1,
    timestamp: Date.now(),
    correlationId: 'c1',
    repository: '/repo',
    taskId: 't1',
    actor: 'enginseer-rhodanis-novum',
    actorName: 'Enginseer Rhodanis-Novum',
    actorRole: 'worker',
    recipient: 'adept-helion-cognitor',
    recipientName: 'Adept Helion-Cognitor',
    recipientRole: 'reviewer',
    kind: 'advice-request',
    status: 'open',
    summary: 'Reuse the auth helper?',
    ...over,
  };
}

function fetchWith(events: unknown[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ events, pending: [], lastSeq: events.length }) }));
}

describe('startOrchestrationView', () => {
  it('renders nodes, role colors, stats, and the feed from one snapshot', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'e1', seq: 1 }),
        boardEvent({ id: 'e2', seq: 2, kind: 'human-question', status: 'waiting', recipient: 'human', recipientName: undefined, recipientRole: 'human', correlationId: 'hq-1' }),
      ]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));

    const nodes = [...doc.querySelectorAll('.node')].map((el) => el.getAttribute('data-node'));
    expect(nodes).toContain('enginseer-rhodanis-novum');
    expect(nodes).toContain('adept-helion-cognitor');
    expect(nodes).toContain('human');

    // The hierarchy is stated by the drawing: the three shared rails labeled,
    // then a lane per task, and the operator seated above the worker.
    const labels = [...doc.querySelectorAll('.tier-label')].map((el) => el.textContent);
    expect(labels.slice(0, 3)).toEqual(['OPERATOR', 'CONTROL PLANE', 'COORDINATION']);
    expect(labels).toContain('t1');
    const yOf = (id: string) => Number(/translate\(\S+ (\S+)\)/.exec(
      doc.querySelector(`[data-node="${id}"]`)!.getAttribute('transform')!)![1]);
    expect(yOf('human')).toBeLessThan(yOf('enginseer-rhodanis-novum'));
    expect(doc.getElementById('stats')!.textContent).toContain('pending questions');
    expect(doc.getElementById('feed')!.textContent).toContain('Reuse the auth helper?');
    // The worker node is painted with the worker role color.
    const workerCircle = doc.querySelector('[data-node="enginseer-rhodanis-novum"] circle:last-of-type');
    expect(workerCircle!.getAttribute('fill')).toBe(ROLE_COLORS.worker);
    view.stop();
  });

  it('filters the feed and detail to the selected node, and toggles back', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'e1', seq: 1 }),
        boardEvent({ id: 'e2', seq: 2, actor: 'castellan-mordax-invictus', actorName: 'Castellan Mordax-Invictus', actorRole: 'orchestrator', recipient: undefined, recipientName: undefined, recipientRole: undefined, kind: 'mcp-audit', status: 'completed', correlationId: 'c2', summary: 'granted 3 tools' }),
      ]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));

    (doc.querySelector('[data-node="castellan-mordax-invictus"]') as HTMLElement).dispatchEvent(
      new (doc.defaultView as typeof globalThis & Window).Event('click'));
    expect(doc.getElementById('detail')!.textContent).toContain('Castellan Mordax-Invictus');
    expect(doc.getElementById('feed')!.textContent).toContain('granted 3 tools');
    expect(doc.getElementById('feed')!.textContent).not.toContain('Reuse the auth helper?');

    (doc.querySelector('[data-node="castellan-mordax-invictus"]') as HTMLElement).dispatchEvent(
      new (doc.defaultView as typeof globalThis & Window).Event('click'));
    expect(doc.getElementById('feed')!.textContent).toContain('Reuse the auth helper?');
    view.stop();
  });

  it('absorbs a live SSE coordination event into the running picture', async () => {
    const doc = shell();
    const listeners: { onmessage?: (msg: { data: string }) => void } = {};
    class FakeSource {
      set onmessage(fn: (msg: { data: string }) => void) { listeners.onmessage = fn; }
      close(): void { /* noop */ }
    }
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1 })]),
      eventSourceImpl: FakeSource,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));
    const before = doc.querySelectorAll('.node').length;

    listeners.onmessage!({
      data: JSON.stringify({
        type: 'coordination:event',
        data: boardEvent({ id: 'e-live', seq: 9, actor: 'vindicator-ferrus-theta', actorName: 'Vindicator Ferrus-Theta', recipient: undefined, correlationId: 'c9' }),
      }),
    });
    expect(doc.querySelectorAll('.node').length).toBeGreaterThan(before);
    view.stop();
  });

  it('replaces an existing transcript row when a locale backfill appears on poll', async () => {
    const doc = shell();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          events: [boardEvent({
            id: 'e1', seq: 1,
            summary: calls === 1 ? 'Reuse the auth helper?' : '기존 auth helper를 재사용할까요?',
            ...(calls > 1 ? { localizedLocale: 'ko' } : {}),
          })],
          pending: [], lastSeq: 1,
        }),
      };
    });
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 250 });
    await vi.waitFor(() => expect(doc.getElementById('feed')!.textContent).toContain('Reuse the auth helper?'));
    await vi.waitFor(() => expect(doc.getElementById('feed')!.textContent).toContain('기존 auth helper를 재사용할까요?'));
    expect(doc.getElementById('feed')!.textContent).not.toContain('Reuse the auth helper?');
    view.stop();
  });

  it('escapes hostile summaries instead of injecting them into the feed', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', summary: '<img src=x onerror=alert(1)>' })]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.getElementById('feed')!.textContent).toContain('<img'));
    expect(doc.getElementById('feed')!.querySelector('img')).toBeNull();
    view.stop();
  });

  it('scales node radius with activity but caps it readable', () => {
    expect(nodeRadius({ eventCount: 0 })).toBe(10);
    expect(nodeRadius({ eventCount: 10_000 })).toBe(26);
  });
});

describe('the picture stays bounded and legible (AGT-4066)', () => {
  // The server ring drops coordination events at 2000; this map kept every one
  // it ever saw, so a dashboard left open for a shift outgrew the daemon's own
  // history and every agent that once spoke stayed a node forever.
  it('evicts the oldest events instead of growing without bound', async () => {
    const doc = shell();
    const flood = Array.from({ length: 2400 }, (_, index) => boardEvent({
      id: `e${index}`,
      seq: index + 1,
      correlationId: `c${index}`,
      actor: `agent-${index}`,
      actorName: `Agent ${index}`,
      status: 'completed',
      summary: `line ${index}`,
    }));
    const view = startOrchestrationView(doc, { fetchImpl: fetchWith(flood), eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));

    // The cap is a ceiling on what is retained, not an average it drifts above:
    // 2400 events arrived, at most the server ring's own 2000 are still held.
    const eventStat = [...doc.querySelectorAll('#stats .stat')]
      .find((cell) => cell.textContent!.endsWith('events'))!;
    const retained = Number(eventStat.querySelector('b')!.textContent);
    expect(retained).toBeLessThanOrEqual(2000);
    // ...and it prunes a batch, not the whole map.
    expect(retained).toBeGreaterThan(1500);

    // The very first speakers were pruned; the newest are still on the board.
    expect(doc.querySelector('[data-node="agent-0"]')).toBeNull();
    expect(doc.querySelector('[data-node="agent-2399"]')).not.toBeNull();
    view.stop();
  });

  // Liveness is wall-clock, but only an event, a poll change, a resize or a
  // control action redraws. On a quiet board nothing ever crossed the window,
  // so an agent that stopped talking stayed on screen forever — the very
  // unbounded population the eviction above is meant to prevent.
  it('sheds an agent that ages out even when the board stays silent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const doc = shell();
      const view = startOrchestrationView(doc, {
        fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1, status: 'completed' })]),
        eventSourceImpl: null,
        pollMs: 1e9,
      });
      await vi.waitFor(() => expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).not.toBeNull());

      // No new events, no resize, no clicks — only time passing.
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).toBeNull();
      view.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // `redraw` no-ops after stop, so a leaked sweep repaints nothing — which is
  // exactly why this asserts the timer itself. An armed sweep holds a
  // half-hour wake and the whole view closure alive regardless.
  it('disarms every timer it armed when it is stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const doc = shell();
      const view = startOrchestrationView(doc, {
        fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1, status: 'completed' })]),
        eventSourceImpl: null,
        pollMs: 1e9,
      });
      await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));
      // The poll interval and the liveness sweep are both armed by now.
      expect(vi.getTimerCount()).toBeGreaterThan(1);

      view.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // stop() clears the timers it can see, but a fetch already awaiting its
  // response is not one of them: its continuation would rebuild the graph and
  // arm a fresh liveness timer that nothing is left to clear.
  it('does not redraw after stop when a fetch was already in flight', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const doc = shell();
    const fetchImpl = vi.fn(() => gate.then(() => ({
      ok: true,
      json: async () => ({ events: [boardEvent({ id: 'e1', seq: 1 })], pending: [], lastSeq: 1 }),
    })));

    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    view.stop();          // the snapshot has not landed yet
    release(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.querySelectorAll('.node')).toHaveLength(0);
    expect(doc.getElementById('graph')!.querySelector('[data-layer]')).toBeNull();
  });

  it('keeps node elements across redraws instead of tearing the graph down', async () => {
    const doc = shell();
    const listeners: { onmessage?: (msg: { data: string }) => void } = {};
    class FakeSource {
      set onmessage(fn: (msg: { data: string }) => void) { listeners.onmessage = fn; }
      close(): void { /* noop */ }
    }
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1 })]),
      eventSourceImpl: FakeSource,
    });
    await vi.waitFor(() => expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).not.toBeNull());
    const before = doc.querySelector('[data-node="enginseer-rhodanis-novum"]')!;

    listeners.onmessage!({
      data: JSON.stringify({
        type: 'coordination:event',
        data: boardEvent({ id: 'e-live', seq: 9, actor: 'vindicator-ferrus-theta', actorName: 'Vindicator Ferrus-Theta', correlationId: 'c9' }),
      }),
    });

    // Same element object, not a replacement: that identity is what lets CSS
    // transition a move rather than cutting to it.
    expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).toBe(before);
    view.stop();
  });

  // A NUL joined the two addresses at first. Node parsed it happily, but the
  // served asset became a binary file to `file`, to static-asset middleware and
  // to every text tool that touches it.
  it('keeps the served asset text, and keeps edge keys unambiguous', async () => {
    // Read from disk, not through the import: the module graph would happily
    // hand back a parsed module and hide the byte that is the actual problem.
    const source = await readFile(
      resolve(process.cwd(), 'web/static/js/orchestrationView.mjs'), 'utf8');
    expect(source).not.toHaveLength(0);
    expect(source.includes(NUL)).toBe(false);

    // Injective: no pair of addresses can produce another pair's key.
    expect(edgeKey('a', 'b->c')).not.toBe(edgeKey('a->b', 'c'));
    expect(edgeKey('a', 'b')).toBe(edgeKey('a', 'b'));
    expect(edgeKey('a>b', 'c')).not.toContain(NUL);
  });

  it('names both ends of an edge by handle, not by routing address', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1 })]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.querySelector('[data-edge] title')).not.toBeNull());

    const tooltip = doc.querySelector('[data-edge] title')!.textContent!;
    expect(tooltip).toContain('Enginseer Rhodanis-Novum → Adept Helion-Cognitor');
    expect(tooltip).not.toContain('enginseer-rhodanis-novum');
    view.stop();
  });

  it('says how many agents are waiting on the operator without any interaction', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'q1', seq: 1, kind: 'human-question', status: 'waiting', recipient: 'human', recipientRole: 'human', correlationId: 'hq-1' }),
        boardEvent({
          id: 'q2', seq: 2, kind: 'human-question', status: 'waiting', recipient: 'human',
          recipientRole: 'human', correlationId: 'hq-2',
          actor: 'vindicator-ferrus-theta', actorName: 'Vindicator Ferrus-Theta',
        }),
      ]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.getElementById('waiting')!.textContent).toContain('waiting on you'));

    expect(doc.getElementById('waiting')!.textContent).toBe('2 agents are waiting on you');
    expect(doc.getElementById('waiting')!.className).toContain('is-blocking');
    view.stop();
  });

  it('tells the operator nothing needs them when nothing does', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1, status: 'completed' })]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.getElementById('waiting')!.textContent).toBeTruthy());
    expect(doc.getElementById('waiting')!.textContent).toBe('nothing is waiting on you');
    expect(doc.getElementById('waiting')!.className).not.toContain('is-blocking');
    view.stop();
  });
});

describe('filter and collapse controls (AGT-4066)', () => {
  const twoTasks = () => [
    boardEvent({ id: 'e1', seq: 1, taskId: 't1', taskLabel: 'AGT-1' }),
    boardEvent({
      id: 'e2', seq: 2, taskId: 't2', taskLabel: 'AGT-2', correlationId: 'c2',
      actor: 'vindicator-ferrus-theta', actorName: 'Vindicator Ferrus-Theta', actorRole: 'worker',
      recipient: 'castellan-mordax-invictus', recipientName: 'Castellan Mordax-Invictus',
      recipientRole: 'orchestrator',
    }),
  ];

  it('offers the live tasks as filter options and narrows the graph to one', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, { fetchImpl: fetchWith(twoTasks()), eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(2));

    const select = doc.getElementById('filter-task') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['all tasks', 'AGT-1', 'AGT-2']);

    select.value = 't1';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).not.toBeNull();
    expect(doc.querySelector('[data-node="vindicator-ferrus-theta"]')).toBeNull();
    // The orchestrator is a shared rail, so it survives a task filter.
    expect(doc.querySelector('[data-node="castellan-mordax-invictus"]')).not.toBeNull();
    view.stop();
  });

  it('searches by handle', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, { fetchImpl: fetchWith(twoTasks()), eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(2));

    const search = doc.getElementById('filter-search') as HTMLInputElement;
    search.value = 'vindic';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(doc.querySelector('[data-node="vindicator-ferrus-theta"]')).not.toBeNull();
    expect(doc.querySelector('[data-node="enginseer-rhodanis-novum"]')).toBeNull();
    view.stop();
  });

  it('collapses agents outside the activity window and expands them on request', async () => {
    const doc = shell();
    const old = Date.now() - 45 * 60_000;
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'fresh', seq: 2 }),
        boardEvent({
          id: 'stale', seq: 1, timestamp: old, correlationId: 'c-old', status: 'completed',
          actor: 'retired-agent', actorName: 'Retired Agent', recipient: undefined,
          recipientName: undefined, recipientRole: undefined,
        }),
      ]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));

    expect(doc.querySelector('[data-node="retired-agent"]')).toBeNull();
    expect(doc.getElementById('idle-count')!.textContent).toBe('(1)');

    const toggle = doc.getElementById('filter-idle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(doc.querySelector('[data-node="retired-agent"]')).not.toBeNull();
    view.stop();
  });

  // Redraws run on every SSE event, so a control that gained a listener per
  // wiring pass would eventually fire dozens of times per click.
  // Expanding the idle set must not re-stack the conversations — that would be
  // the vertical twin of the sliding row this issue exists to remove.
  it('keeps the lane order fixed when idle agents are expanded', async () => {
    const doc = shell();
    const old = Date.now() - 45 * 60_000;
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([
        // The oldest sighting on task B is idle, so collapsing it would make
        // task B look younger than task A and swap the two lanes.
        boardEvent({
          id: 'b-old', seq: 1, timestamp: old, taskId: 'tB', taskLabel: 'B', correlationId: 'cb',
          status: 'completed', actor: 'veteran', actorName: 'Veteran',
          recipient: undefined, recipientName: undefined, recipientRole: undefined,
        }),
        boardEvent({ id: 'a1', seq: 2, taskId: 'tA', taskLabel: 'A', correlationId: 'ca' }),
        boardEvent({
          id: 'b-new', seq: 3, taskId: 'tB', taskLabel: 'B', correlationId: 'cb2',
          actor: 'vindicator-ferrus-theta', actorName: 'Vindicator Ferrus-Theta',
          recipient: undefined, recipientName: undefined, recipientRole: undefined,
        }),
      ]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.lane-label').length).toBeGreaterThan(0));
    const lanesNow = () => [...doc.querySelectorAll('.lane-label')].map((el) => el.textContent);
    const collapsed = lanesNow();
    expect(collapsed).toEqual(['B', 'A']);

    const toggle = doc.getElementById('filter-idle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(lanesNow()).toEqual(collapsed);
    view.stop();
  });

  it('binds each control once even if wiring runs again', () => {
    const doc = shell();
    const filters = { showIdle: false, taskId: null, role: null, query: '' };
    let changes = 0;
    wireControls(doc, filters, () => { changes += 1; });
    wireControls(doc, filters, () => { changes += 1; });

    const toggle = doc.getElementById('filter-idle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(changes).toBe(1);
    expect(filters.showIdle).toBe(true);
  });

  // Same reasoning as the timers: `redraw` no-ops after stop, so a listener
  // left attached is invisible from the DOM — but it still pins the view's
  // whole closure, and its event map, to the window for the page's lifetime.
  it('releases the resize listener when it is stopped', async () => {
    const doc = shell();
    const view = startOrchestrationView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1', seq: 1 })]),
      eventSourceImpl: null,
      pollMs: 1e9,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));

    const remove = vi.spyOn(doc.defaultView!, 'removeEventListener');
    try {
      view.stop();
      expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    } finally {
      remove.mockRestore();
    }
  });

  it('still renders when the host page ships no controls at all', async () => {
    const doc = bareShell();
    const view = startOrchestrationView(doc, { fetchImpl: fetchWith(twoTasks()), eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(2));
    expect(doc.getElementById('feed')!.textContent).toContain('Reuse the auth helper?');
    view.stop();
  });
});

describe('feed legibility', () => {
  it('says when, on what task, who spoke and to whom', async () => {
    const doc = shell();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ events: [boardEvent({ id: 'e1', taskLabel: 'AGT-4001' })], pending: [], lastSeq: 1 }),
    }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.getElementById('feed')!.textContent).toContain('Enginseer'));

    const row = doc.querySelector('#feed .ev')!;
    expect(row.textContent).toContain('AGT-4001');
    expect(row.querySelector('.ev-line')!.textContent)
      .toBe('Enginseer Rhodanis-Novum → Adept Helion-Cognitor: Reuse the auth helper?');
    expect(row.querySelector('.clock')!.textContent).toBeTruthy();
    view.stop();
  });

  it('prefers the full words in detail and truncates them for the row', async () => {
    const doc = shell();
    const words = `the whole argument ${'x'.repeat(200)}`;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        events: [boardEvent({ id: 'e1', summary: 'clipped...', detail: words })],
        pending: [], lastSeq: 1,
      }),
    }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelector('#feed .ev-line')).not.toBeNull());

    const line = doc.querySelector('#feed .ev-line')!.textContent!;
    expect(line).toContain('the whole argument');
    expect(line).not.toContain('clipped...');
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThan(words.length);
    view.stop();
  });

  it('keeps instruction snapshots off the conversation surfaces', async () => {
    const doc = shell();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        events: [boardEvent({
          id: 'sys', actor: 'openswarm-daemon', actorName: 'OpenSwarm daemon', actorRole: 'daemon',
          recipient: undefined, recipientName: undefined, recipientRole: undefined,
          kind: 'instruction-snapshot', status: 'completed',
          summary: 'Claude Code rules c480ceccd832 (0 sources)',
          metadata: { digest: 'c480ceccd832', sourceCount: 0 },
        })],
        pending: [], lastSeq: 1,
      }),
    }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    // The event still feeds the graph (the daemon node exists) but nobody
    // "said" anything, so the feed stays empty.
    await vi.waitFor(() => expect(doc.querySelectorAll('.node').length).toBeGreaterThan(0));
    expect(doc.getElementById('feed')!.textContent).toContain('no coordination events');
    view.stop();
  });

  it('escapes event-fed markup in every rendered field', async () => {
    const doc = shell();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        events: [boardEvent({
          id: 'x', taskLabel: '<img src=x onerror=alert(1)>',
          summary: '<script>alert(1)</script>',
          detail: '<iframe src="javascript:alert(1)"></iframe>',
        })],
        pending: [], lastSeq: 1,
      }),
    }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.getElementById('feed')!.textContent).toContain('alert(1)'));

    const feed = doc.getElementById('feed')!;
    expect(feed.querySelector('script')).toBeNull();
    expect(feed.querySelector('img')).toBeNull();
    expect(feed.querySelector('iframe')).toBeNull();
    view.stop();
  });

  it('escapes metadata that reaches the thread chip tooltip', async () => {
    const doc = shell();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        events: [boardEvent({ id: 'm', metadata: { 'a"b': '"><img src=x onerror=alert(1)>' } })],
        pending: [], lastSeq: 1,
      }),
    }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelector('#feed .ev')).not.toBeNull());
    // Metadata rides with the message in the thread, not in the feed preview.
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(doc.querySelector('#thread .chip')).not.toBeNull());

    expect(doc.getElementById('thread')!.querySelector('img')).toBeNull();
    expect(doc.querySelector('#thread .chip')!.getAttribute('title'))
      .toBe('a"b: "><img src=x onerror=alert(1)>');
    view.stop();
  });
});

describe('clicking a feed row', () => {
  async function withThread(messageResponse?: unknown) {
    const doc = shell();
    const events = [
      boardEvent({ id: 'q', seq: 1, summary: 'Retry in adapter or scheduler?' }),
      boardEvent({
        id: 'a', seq: 2, kind: 'advice-response', status: 'completed',
        actor: 'adept-helion-cognitor', actorName: 'Adept Helion-Cognitor', actorRole: 'reviewer',
        recipient: 'enginseer-rhodanis-novum', recipientName: 'Enginseer Rhodanis-Novum', recipientRole: 'worker',
        summary: 'Scheduler owns retries.',
      }),
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/coordination/message')) {
        return messageResponse ?? { ok: true, json: async () => ({ delivered: true }) };
      }
      return { ok: true, json: async () => ({ events, pending: [], lastSeq: 2 }) };
    });
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('#feed .ev').length).toBe(2));
    return { doc, view, fetchImpl };
  }

  it('highlights the speaker and marks the addressee', async () => {
    const { doc, view } = await withThread();
    // Rows render newest-first, so the last row is the opening question.
    const rows = [...doc.querySelectorAll('#feed .ev')] as HTMLElement[];
    rows[rows.length - 1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const speaking = doc.querySelector('[data-speaking="true"]');
    const spokenTo = doc.querySelector('[data-spoken-to="true"]');
    expect(speaking!.getAttribute('data-node')).toBe('enginseer-rhodanis-novum');
    expect(spokenTo!.getAttribute('data-node')).toBe('adept-helion-cognitor');
    view.stop();
  });

  it('opens the whole exchange as a transcript', async () => {
    const { doc, view } = await withThread();
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const messages = doc.querySelectorAll('#thread .msg');
    expect(messages).toHaveLength(2);
    expect(messages[0].textContent).toContain('Retry in adapter or scheduler?');
    expect(messages[1].textContent).toContain('Scheduler owns retries.');
    view.stop();
  });

  it('renders the exchange as chat bubbles and sets operator speech apart', async () => {
    const doc = shell();
    const events = [
      boardEvent({ id: 'q', seq: 1, summary: 'Reuse the auth helper?' }),
      boardEvent({
        id: 'note', seq: 2, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human',
        recipient: 'enginseer-rhodanis-novum', recipientName: 'Enginseer Rhodanis-Novum', recipientRole: 'worker',
        kind: 'advice-response', status: 'completed',
        summary: 'Ship it.', detail: 'Ship it. The helper is fine.',
      }),
    ];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ events, pending: [], lastSeq: 2 }) }));
    const view = startOrchestrationView(doc, { fetchImpl, eventSourceImpl: null, pollMs: 1e9 });
    await vi.waitFor(() => expect(doc.querySelectorAll('#feed .ev').length).toBe(2));
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const operatorMsg = doc.querySelector('#thread .msg.from-operator');
    expect(operatorMsg).not.toBeNull();
    // The bubble body carries the full words, not the clipped summary.
    expect(operatorMsg!.querySelector('.msg-text')!.textContent).toBe('Ship it. The helper is fine.');
    expect(operatorMsg!.querySelector('.to')!.textContent).toBe('→ Enginseer Rhodanis-Novum');
    const roleTags = [...doc.querySelectorAll('#thread .role-tag')].map((el) => el.textContent);
    expect(roleTags).toContain('operator');
    expect(roleTags).toContain('worker');
    view.stop();
  });

  it('sends an operator reply addressed to the last agent speaker', async () => {
    const { doc, view, fetchImpl } = await withThread();
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'Keep it in the scheduler.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((call) => call[0] === '/api/coordination/message')).toBe(true));
    const [, init] = fetchImpl.mock.calls.find((call) => call[0] === '/api/coordination/message')!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      correlationId: 'c1',
      recipient: 'adept-helion-cognitor',
      text: 'Keep it in the scheduler.',
    });
    view.stop();
  });

  // `fetch` resolves on 400/409, so a refused reply used to read as delivered
  // while the operator's text was already gone from the box (AGT-4026).
  it('keeps the reply and shows why when the daemon refuses it', async () => {
    const { doc, view } = await withThread({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Cannot address the message' }),
    });
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'Use the mounted credentials.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(doc.getElementById('composer-status')?.textContent).toBe('Cannot address the message');
    });
    expect(input.value).toBe('Use the mounted credentials.');
    view.stop();
  });

  it('clears the reply only once the daemon accepts it', async () => {
    const { doc, view } = await withThread();
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    (doc.getElementById('composer-text') as HTMLInputElement).value = 'Proceed.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    // Re-query rather than holding the node: a send re-renders the panel, and
    // the pending state is re-applied to the fresh composer — that is the
    // property that keeps an in-flight send from being undone by an agent
    // event arriving mid-flight.
    await vi.waitFor(() => {
      expect((doc.getElementById('composer-text') as HTMLInputElement).value).toBe('');
    });
    expect(doc.getElementById('composer-status')?.textContent).toBe('');
    view.stop();
  });

  it('keeps the composer locked and the text intact while a send is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { doc, view } = await withThread(
      gate.then(() => ({ ok: true, json: async () => ({ delivered: true }) })),
    );
    (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    (doc.getElementById('composer-text') as HTMLInputElement).value = 'Hold for CI.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(doc.getElementById('composer-status')?.textContent).toBe('Sending…');
    });
    const midFlight = doc.getElementById('composer-text') as HTMLInputElement;
    expect(midFlight.disabled).toBe(true);
    expect(midFlight.value).toBe('Hold for CI.');

    release(null);
    await vi.waitFor(() => {
      expect((doc.getElementById('composer-text') as HTMLInputElement).value).toBe('');
    });
    view.stop();
  });

  it('does not leak a pending send into a different exchange', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { doc, view } = await withThread(
      gate.then(() => ({ ok: false, status: 400, json: async () => ({ error: 'Cannot address the message' }) })),
    );
    const rows = doc.querySelectorAll('#feed .ev');
    (rows[0] as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    (doc.getElementById('composer-text') as HTMLInputElement).value = 'For the first thread only.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(doc.getElementById('composer-status')?.textContent).toBe('Sending…'));

    // The operator moves to another exchange while the first send is in flight.
    (rows[0] as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    release(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const other = doc.getElementById('composer-text') as HTMLInputElement | null;
    if (other) {
      expect(other.value).not.toBe('For the first thread only.');
      expect(other.disabled).toBe(false);
    }
    view.stop();
  });
});

describe('the default fetcher (AGT-4029)', () => {
  // Every other test injects fetchImpl, so the fetcher a real browser uses was
  // never exercised — and it dropped the request init, turning each POST into a
  // GET the daemon answered 404. Drive the view with no fetchImpl so the
  // default path is the one under test.
  it('forwards method and body, so a send is a POST and not a GET', async () => {
    const doc = shell();
    const events = [
      boardEvent({ id: 'q', seq: 1, summary: 'Retry in adapter or scheduler?' }),
    ];
    const calls: Array<[string, RequestInit | undefined]> = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({ ok: true, json: async () => ({ events, pending: [], lastSeq: 1 }) } as Response);
    }) as typeof fetch;

    try {
      const view = startOrchestrationView(doc, { eventSourceImpl: null, pollMs: 1e9 });
      await vi.waitFor(() => expect(doc.querySelectorAll('#feed .ev').length).toBe(1));
      (doc.querySelector('#feed .ev') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

      (doc.getElementById('composer-text') as HTMLInputElement).value = 'Ship it.';
      doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

      await vi.waitFor(() => {
        expect(calls.some(([url]) => url === '/api/coordination/message')).toBe(true);
      });
      const [, init] = calls.find(([url]) => url === '/api/coordination/message')!;
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: 'Ship it.' });
      view.stop();
    } finally {
      globalThis.fetch = original;
    }
  });
});
