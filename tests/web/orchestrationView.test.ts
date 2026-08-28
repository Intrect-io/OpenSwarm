// @vitest-environment jsdom
//
// The view is thin, but its wiring is where a graph silently becomes a blank
// page: a fetch shape mismatch, an unhooked selection, or an SSE event that
// never reaches the model. Drive it with a faked fetch and assert real DOM.

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { startOrchestrationView, nodeRadius, ROLE_COLORS } from '../../web/static/js/orchestrationView.mjs';

function shell(): Document {
  document.body.innerHTML = `
    <div id="stats"></div>
    <svg id="graph"></svg>
    <div id="legend"></div>
    <div id="detail"></div>
    <div id="feed"></div>
    <div id="thread"></div>`;
  return document;
}

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

    // The hierarchy is stated by the drawing: all four tier bands labeled, and
    // the operator seated above the worker.
    const labels = [...doc.querySelectorAll('.tier-label')].map((el) => el.textContent);
    expect(labels).toEqual(['OPERATOR', 'CONTROL PLANE', 'COORDINATION', 'EXECUTION']);
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
  async function withThread() {
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
        return { ok: true, json: async () => ({ delivered: true }) };
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
});
