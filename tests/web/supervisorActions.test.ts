// The Supervisor page runs one classic script (web/static/js/supervisor.js),
// so a source-shape assertion cannot tell whether a failed Stop still reads as
// sent. Run the real page and script in jsdom with a scripted fetch and a
// hand-driven clock.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const STATIC = join(__dirname, '..', '..', 'web', 'static');
const SCRIPT_TAG = '<script src="/static/js/supervisor.js"></script>';
/** The page with its script inlined: jsdom does not fetch /static/ assets. */
function pageSource(): string {
  const html = readFileSync(join(STATIC, 'supervisor.html'), 'utf8');
  if (!html.includes(SCRIPT_TAG)) throw new Error('supervisor.html no longer loads supervisor.js');
  const script = readFileSync(join(STATIC, 'js', 'supervisor.js'), 'utf8');
  return html.replace(SCRIPT_TAG, () => `<script>${script}</script>`);
}
const PROVIDERS = ['codex', 'openrouter'];

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
  const dom = new JSDOM(pageSource(), {
    url: 'http://127.0.0.1:3847/',
    runScripts: 'dangerously',
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>;
      w.fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const answer = respond(url, init)
          ?? (url === '/api/providers' ? { status: 200, body: { providers: PROVIDERS } } : undefined)
          ?? { status: 200, body: ['/api/chat/history', '/api/logs', '/api/stages'].includes(url) ? [] : {} };
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
    expect(btn.textContent).toBe('Stop daemon');
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
    expect(btn.textContent).toBe('Starting…');
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
    expect(btn.textContent).toBe('Heartbeat');
    expect(btn.disabled).toBe(false);
    page.fire(15000);
    expect(btn.textContent).toBe('Heartbeat');
  });
});

describe('Supervisor fleet-wide switches take two presses', () => {
  it('stages a provider and switches the fleet only on confirm', async () => {
    const page = load((url) => (url === '/api/stats' ? { status: 200, body: { adapters: { defaultAdapter: 'codex' } } } : undefined));
    await page.settle();
    const select = page.doc.getElementById('provider-select') as HTMLSelectElement;
    const confirm = page.doc.getElementById('provider-confirm') as HTMLButtonElement;
    select.value = 'openrouter';
    call(page, 'stageProvider', 'openrouter');
    expect(confirm.hidden).toBe(false);
    expect(confirm.textContent).toBe('Switch fleet to openrouter?');
    expect(posts(page, '/api/provider')).toHaveLength(0);
    call(page, 'confirmProvider');
    await page.settle();
    expect(posts(page, '/api/provider')).toHaveLength(1);
    expect(JSON.parse(posts(page, '/api/provider')[0]!.init!.body as string)).toEqual({ provider: 'openrouter' });
  });

  it('lets an unconfirmed provider lapse back to the one the fleet uses', async () => {
    const page = load((url) => (url === '/api/stats' ? { status: 200, body: { adapters: { defaultAdapter: 'codex' } } } : undefined));
    await page.settle();
    const select = page.doc.getElementById('provider-select') as HTMLSelectElement;
    select.value = 'openrouter';
    call(page, 'stageProvider', 'openrouter');
    page.fire(6000);
    expect(select.value).toBe('codex');
    expect((page.doc.getElementById('provider-confirm') as HTMLButtonElement).hidden).toBe(true);
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

// Ported from the server-side source checks that died with dashboardHtml.ts:
// these now run the behaviour instead of matching the emitted string.
describe('Supervisor provider select and stage rows', () => {
  it('lists every registry provider in the select and selects the default (INT-3284)', async () => {
    const page = load((url) => (url === '/api/stats' ? { status: 200, body: { adapters: { defaultAdapter: 'openrouter' } } } : undefined));
    await page.settle();
    const select = page.doc.getElementById('provider-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['codex', 'openrouter']);
    expect(select.value).toBe('openrouter');
  });

  it('escapes a stage status in both the class and the label (AGT-3476)', async () => {
    const page = load();
    await page.settle();
    const status = '"><img src=x onerror="window.__pwned=1">';
    page.emit({ type: 'pipeline:stage', data: { taskId: 't1', stage: 'worker', status } });
    await page.settle();
    page.timers.splice(0).forEach((t) => t.fn());
    await page.settle();
    expect(page.doc.querySelector('#stage-list img')).toBeNull();
    expect(page.doc.getElementById('stage-list')!.textContent).toContain(status);
  });
});

describe('Supervisor departure board', () => {
  const running = {
    running: [{ task: { id: 'u1', issueIdentifier: 'AX-1777', title: 'Import statements' }, projectPath: '/r/cgf-portal', startedAt: Date.now() - 4 * 60_000, stage: 'worker' }],
    queued: [{ task: { id: 'u2', issueIdentifier: 'AX-1801', title: 'Batch guard' }, projectPath: '/r/kyte', queuedAt: Date.now() - 60_000 }],
  };

  it('lists running and queued runs from the scheduler', async () => {
    const page = load((url) => (url === '/api/tasks' ? { status: 200, body: running } : undefined));
    await page.settle();
    const rows = [...page.doc.querySelectorAll('#board-rows tr')];
    expect(rows.map((r) => r.querySelector('.c-run')!.textContent)).toEqual(['AX-1777', 'AX-1801']);
    expect(rows[0]!.querySelector('.c-repo')!.textContent).toBe('cgf-portal');
    expect(rows[0]!.querySelector('.c-status')!.textContent).toBe('Running · 4m');
    expect(rows[0]!.querySelector('.stg.now')!.textContent).toBe('worker');
    expect(rows[1]!.querySelector('.c-status')!.textContent).toBe('Queued · 1m');
    expect((page.doc.getElementById('board-empty') as HTMLElement).hidden).toBe(true);
  });

  it('marks a run that ended in failure and counts it', async () => {
    const page = load();
    await page.settle();
    page.emit({ type: 'task:started', data: { taskId: 'u9', title: 'Flaky', issueIdentifier: 'AX-9' } });
    page.emit({ type: 'task:completed', data: { taskId: 'u9', success: false, duration: 1000 } });
    const row = page.doc.querySelector('#board-rows tr.is-failed')!;
    expect(row.querySelector('.c-status')!.textContent).toBe('Failed');
    expect(page.doc.getElementById('stat-failed')!.textContent).toBe('1');
  });

  it('says so instead of an empty table when nothing runs', async () => {
    const page = load();
    await page.settle();
    expect((page.doc.getElementById('board-empty') as HTMLElement).hidden).toBe(false);
  });
});

describe('Supervisor notice band', () => {
  it('stays hidden when nothing waits on the operator', async () => {
    const page = load((url) => (url === '/api/shell-status' ? { status: 200, body: { needsYou: { questions: 0, parked: 0, total: 0 } } } : undefined));
    await page.settle();
    expect((page.doc.getElementById('notice') as HTMLElement).hidden).toBe(true);
  });

  it('uses the shell status counts and lists the open question', async () => {
    const page = load((url) => {
      if (url === '/api/shell-status') return { status: 200, body: { needsYou: { questions: 1, parked: 2, total: 3 } } };
      if (url === '/api/coordination') return { status: 200, body: { events: [{ id: 'e1', seq: 1, correlationId: 'c1', kind: 'human-question', status: 'open', actor: 'sable', actorRole: 'worker', taskLabel: 'AX-1812', repository: '/r/cgf-portal', summary: 'uv is missing?', timestamp: Date.now() }] } };
      return undefined;
    });
    await page.settle();
    expect((page.doc.getElementById('notice') as HTMLElement).hidden).toBe(false);
    expect(page.doc.getElementById('notice-title')!.textContent).toBe('3 need you');
    expect(page.doc.getElementById('notice-breakdown')!.textContent).toBe('1 question · 2 parked runs');
    expect(page.doc.getElementById('stat-needs')!.textContent).toBe('3');
    expect(page.doc.getElementById('notice-rows')!.textContent).toContain('sable (worker): uv is missing?');
    expect(page.doc.querySelector('#notice-rows a.nb')!.getAttribute('href')).toBe('/chat');
  });

  it('does not read a tracker error as nothing stuck', async () => {
    const page = load((url) => (url === '/api/stuck-issues' ? { status: 500, body: { error: 'Linear unreachable' } } : undefined));
    await page.settle();
    page.fire(3000);
    await page.settle();
    expect((page.doc.getElementById('notice') as HTMLElement).hidden).toBe(false);
    expect(page.doc.getElementById('stuck-list')!.textContent).toContain('did not answer');
  });

  it('links a tracker issue only when its URL is http(s)', async () => {
    const page = load((url) => (url === '/api/stuck-issues' ? { status: 200, body: { stuckIssues: [], failedIssues: [
      { id: 'a', identifier: 'AX-1', title: 'ok', url: 'https://linear.app/x/AX-1', reason: 'failed' },
      { id: 'b', identifier: 'AX-2', title: 'bad', url: 'javascript:alert(1)', reason: 'failed' },
    ] } } : undefined));
    await page.settle();
    page.fire(3000);
    await page.settle();
    const links = [...page.doc.querySelectorAll('#stuck-list a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://linear.app/x/AX-1']);
  });
});

describe('Supervisor controls tell the truth about the daemon', () => {
  const ROUTINE = ['hb-btn', 'pr-proc-btn', 'provider-select', 'reasoning-effort'];

  it('disables the routine controls, and says why, when no daemon runner is attached', async () => {
    const page = load((url) => (url === '/api/shell-status'
      ? { status: 200, body: { daemon: { state: 'dashboard-only', reason: 'No daemon runner is attached' }, needsYou: { questions: 0, parked: 0, total: 0 } } }
      : undefined));
    await page.settle();
    for (const id of ROUTINE) {
      const el = page.doc.getElementById(id) as HTMLButtonElement;
      expect(el.disabled, id).toBe(true);
      expect(el.title, id).toMatch(/No daemon runner/);
    }
  });

  it('leaves them usable when a daemon is running', async () => {
    const page = load((url) => (url === '/api/shell-status'
      ? { status: 200, body: { daemon: { state: 'running', reason: null }, needsYou: { questions: 0, parked: 0, total: 0 } } }
      : url === '/api/service/status' ? { status: 200, body: { status: 'active' } } : undefined));
    await page.settle();
    page.fire(3000);
    await page.settle();
    for (const id of [...ROUTINE, 'svc-stop-btn', 'svc-restart-btn']) {
      expect((page.doc.getElementById(id) as HTMLButtonElement).disabled, id).toBe(false);
    }
  });

  it('does not offer stop or restart when the service manager cannot report the state', async () => {
    const page = load((url) => (url === '/api/service/status' ? { status: 200, body: {} } : undefined));
    await page.settle();
    page.fire(3000);
    await page.settle();
    expect((page.doc.getElementById('svc-stop-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((page.doc.getElementById('svc-restart-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
