// The Supervisor page is a server-rendered string with one inline script, so a
// source-shape assertion cannot tell whether a failed Stop still reads as sent.
// Run the real script in jsdom with a scripted fetch and a hand-driven clock.

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildDashboardHtml } from '../../src/support/dashboardHtml.js';

type Responder = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;

interface Page {
  window: JSDOM['window'];
  doc: Document;
  calls: { url: string; init?: RequestInit }[];
  timers: { delay: number; fn: () => void }[];
  emit: (event: unknown) => void;
  settle: () => Promise<void>;
  fire: (delay: number) => void;
}

function load(respond: Responder = () => undefined): Page {
  const calls: Page['calls'] = [];
  const timers: Page['timers'] = [];
  const sources: { onmessage: ((m: { data: string }) => void) | null }[] = [];
  const dom = new JSDOM(buildDashboardHtml(['codex', 'openrouter']), {
    url: 'http://127.0.0.1:3847/',
    runScripts: 'dangerously',
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>;
      w.fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const answer = respond(url, init) ?? { status: 200, body: ['/api/chat/history', '/api/logs', '/api/stages'].includes(url) ? [] : {} };
        return {
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          json: async () => answer.body ?? {},
          text: async () => JSON.stringify(answer.body ?? {}),
        };
      };
      w.EventSource = class { onmessage = null; onerror = null; onopen = null; constructor() { sources.push(this as never); } close() {} addEventListener() {} };
      // A hand-driven clock: every timer is recorded and fired on demand.
      w.setTimeout = (fn: () => void, delay = 0) => { timers.push({ delay, fn }); return timers.length; };
      w.clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; };
      w.setInterval = () => 0;
    },
  });
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
  return {
    window: dom.window,
    doc: dom.window.document,
    calls,
    timers,
    emit: (event) => sources.forEach((s) => s.onmessage?.({ data: JSON.stringify(event) })),
    settle,
    fire: (delay) => timers.filter((t) => t.delay === delay).forEach((t) => { const fn = t.fn; t.fn = () => {}; fn(); }),
  };
}

const call = (page: Page, name: string, ...args: unknown[]) =>
  (page.window as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
const posts = (page: Page, path: string) => page.calls.filter((c) => c.url === path && c.init?.method === 'POST');

describe('Supervisor service actions report the daemon\'s answer', () => {
  it('says Stop failed, with the reason, when the daemon refuses', async () => {
    const page = load((url) => (url === '/api/service/stop' ? { status: 500, body: { error: 'systemctl: not found' } } : undefined));
    await page.settle();
    const btn = page.doc.getElementById('svc-stop-btn')!;
    call(page, 'svcAction', 'stop');
    expect(btn.textContent).toBe('Stop the daemon?');
    await call(page, 'svcAction', 'stop');
    expect(posts(page, '/api/service/stop')).toHaveLength(1);
    expect(btn.textContent).toBe('Stop failed');
    expect(btn.classList.contains('is-failed')).toBe(true);
    expect(btn.getAttribute('title')).toBe('systemctl: not found');
    expect(page.doc.body.textContent).toContain('Service stop failed: systemctl: not found');
    page.fire(5000);
    expect(btn.textContent).toBe('⏸ Stop');
  });

  it('says the request was sent when the daemon accepts', async () => {
    const page = load();
    await page.settle();
    const btn = page.doc.getElementById('svc-restart-btn')!;
    call(page, 'svcAction', 'restart');
    await call(page, 'svcAction', 'restart');
    expect(btn.textContent).toBe('Restart sent');
    expect(btn.classList.contains('is-failed')).toBe(false);
  });
});

describe('Supervisor heartbeat button cannot hang', () => {
  it('reports a refused trigger instead of spinning', async () => {
    const page = load((url) => (url === '/api/heartbeat' ? { status: 503, body: { error: 'No daemon runner is attached to this dashboard' } } : undefined));
    await page.settle();
    await call(page, 'triggerHeartbeat');
    const btn = page.doc.getElementById('hb-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('Heartbeat failed');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toContain('No daemon runner');
  });

  it('gives up waiting for the start signal and says so', async () => {
    const page = load((url) => (url === '/api/heartbeat' ? { status: 202, body: { ok: true } } : undefined));
    await page.settle();
    await call(page, 'triggerHeartbeat');
    const btn = page.doc.getElementById('hb-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('⟳ Running…');
    expect(btn.disabled).toBe(true);
    page.fire(15000);
    expect(btn.textContent).toBe('No response');
    expect(btn.disabled).toBe(false);
  });

  it('returns to idle when the heartbeat announces itself', async () => {
    const page = load((url) => (url === '/api/heartbeat' ? { status: 202, body: { ok: true } } : undefined));
    await page.settle();
    await call(page, 'triggerHeartbeat');
    page.emit({ type: 'heartbeat' });
    const btn = page.doc.getElementById('hb-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('▶ Heartbeat');
    expect(btn.disabled).toBe(false);
    page.fire(15000);
    expect(btn.textContent).toBe('▶ Heartbeat');
  });
});

describe('Supervisor fleet-wide switches take two presses', () => {
  it('arms a provider on the first press and switches on the second', async () => {
    const page = load();
    await page.settle();
    const btn = page.doc.getElementById('provider-openrouter')!;
    call(page, 'switchProvider', 'openrouter');
    expect(btn.textContent).toBe('Switch fleet?');
    expect(posts(page, '/api/provider')).toHaveLength(0);
    call(page, 'switchProvider', 'openrouter');
    await page.settle();
    expect(posts(page, '/api/provider')).toHaveLength(1);
    expect(JSON.parse(posts(page, '/api/provider')[0]!.init!.body as string)).toEqual({ provider: 'openrouter' });
    expect(btn.textContent).toBe('OpenRouter');
  });

  it('keeps only one provider armed at a time', async () => {
    const page = load();
    await page.settle();
    call(page, 'switchProvider', 'openrouter');
    call(page, 'switchProvider', 'codex');
    expect(page.doc.getElementById('provider-openrouter')!.textContent).toBe('OpenRouter');
    expect(page.doc.getElementById('provider-codex')!.textContent).toBe('Switch fleet?');
    expect(posts(page, '/api/provider')).toHaveLength(0);
  });

  it('stages a thinking level and applies it only on confirm', async () => {
    const page = load((url) => (url === '/api/reasoning-effort' ? { status: 200, body: { effort: 'high' } } : undefined));
    await page.settle();
    const select = page.doc.getElementById('reasoning-effort') as HTMLSelectElement;
    const confirm = page.doc.getElementById('effort-confirm') as HTMLButtonElement;
    select.value = 'high';
    call(page, 'stageReasoningEffort', 'high');
    expect(confirm.hidden).toBe(false);
    expect(confirm.textContent).toBe('Set fleet to High?');
    expect(posts(page, '/api/reasoning-effort')).toHaveLength(0);
    call(page, 'confirmReasoningEffort');
    await page.settle();
    expect(JSON.parse(posts(page, '/api/reasoning-effort')[0]!.init!.body as string)).toEqual({ effort: 'high' });
  });

  it('lets an unconfirmed thinking level lapse back to the applied one', async () => {
    const page = load((url) => (url === '/api/reasoning-effort' ? { status: 200, body: { effort: 'low' } } : undefined));
    await page.settle();
    // The page reads the applied level in its deferred, second loading pass.
    page.fire(3000);
    await page.settle();
    const select = page.doc.getElementById('reasoning-effort') as HTMLSelectElement;
    expect(select.value).toBe('low');
    select.value = 'high';
    call(page, 'stageReasoningEffort', 'high');
    page.fire(6000);
    expect(select.value).toBe('low');
    expect((page.doc.getElementById('effort-confirm') as HTMLButtonElement).hidden).toBe(true);
    expect(posts(page, '/api/reasoning-effort')).toHaveLength(0);
  });
});
