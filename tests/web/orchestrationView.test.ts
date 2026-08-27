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
    <div id="feed"></div>`;
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
