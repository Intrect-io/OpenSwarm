// @vitest-environment jsdom
//
// The drill-down panel (AGT-4297). Each case below is one of the round-3
// review findings the issue lists; the comments name the number. Items 4 and 5
// are written as the mutants that used to survive: deleting `open = null` in
// close(), and deleting the sequence guard in load()'s catch branch.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { createUsageDrill, drillFooter, drillUrl, isDrillable } from '../../web/static/js/usageDrill.mjs';
// @ts-expect-error — browser ESM asset without type declarations
import { renderTable, startUsageView } from '../../web/static/js/usage.mjs';

const SHELL = readFileSync(resolve(__dirname, '../../web/static/usage.html'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../../web/static/css/usage.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function mountShell(): void {
  document.body.innerHTML = SHELL.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
}

function row(key: string, over: Record<string, number> = {}) {
  return { key, calls: 10, meteredCalls: 10, promptTokens: 1000, completionTokens: 100, cachedTokens: 365, reasoningTokens: 0, costUsd: 1, ...over };
}

function aggregate(by: string, keys: string[]) {
  const rows = keys.map(k => row(k));
  return { by, since: '2026-11-14T00:00:00.000Z', until: '2026-11-15T00:00:00.000Z', rows, total: row('total', { calls: rows.length * 10 }) };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fetch whose answers the test releases by hand, in any order. */
function deferredFetch() {
  const pending: Array<{ url: string; resolve: (v: unknown) => void }> = [];
  const fetchImpl = vi.fn((url: string) => new Promise((resolveFn) => { pending.push({ url, resolve: resolveFn }); }));
  return { fetchImpl, pending };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const panel = () => document.querySelector('#drill-panel') as HTMLElement;
const drillTable = () => document.querySelector('#drill-table') as HTMLTableElement;
const status = () => document.querySelector('#drill-status')!.textContent;

beforeEach(mountShell);
afterEach(() => { document.body.innerHTML = ''; });

describe('drill URL and labels', () => {
  it('asks the server for the child axis filtered by the clicked row', () => {
    const url = new URL(drillUrl('24h', 'project', 'OpenSwarm'), 'http://x');
    expect(url.pathname).toBe('/api/usage');
    expect(url.searchParams.get('by')).toBe('stage');
    expect(url.searchParams.get('project')).toBe('OpenSwarm');
    expect(url.searchParams.get('since')).toBe('24h');
  });

  it('encodes keys that are not URL-safe', () => {
    const url = new URL(drillUrl('2h', 'stage', 'a&b=c'), 'http://x');
    expect(url.searchParams.get('stage')).toBe('a&b=c');
    expect([...url.searchParams.keys()].sort()).toEqual(['by', 'since', 'stage']);
  });

  it('drills only the four breakdown tables, not task', () => {
    expect(['model', 'stage', 'adapter', 'project'].every(isDrillable)).toBe(true);
    expect(isDrillable('task')).toBe(false);
    expect(isDrillable('__proto__')).toBe(false);
  });

  it('names axes by the table labels, not raw ids (item 8)', () => {
    const line = drillFooter('project', 'OpenSwarm', aggregate('stage', ['worker']));
    expect(line).toContain('Stage breakdown of Project OpenSwarm');
    expect(line).not.toContain('project =');
  });
});

describe('key cells', () => {
  it('renders the key as a drill button carrying axis and key', () => {
    const table = document.createElement('table');
    renderTable(table, aggregate('project', ['fba70edf-1234']), { drillAxis: 'project' });
    const trigger = table.querySelector('td.key .drill-trigger') as HTMLButtonElement;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.type).toBe('button');
    expect(trigger.textContent).toBe('fba70edf-1234');
    expect(trigger.title).toBe('fba70edf-1234');
    expect(trigger.dataset).toMatchObject({ axis: 'project', key: 'fba70edf-1234' });
  });

  it('keeps a plain key cell without drillAxis', () => {
    const table = document.createElement('table');
    renderTable(table, aggregate('task', ['AGT-1']));
    expect(table.querySelector('.drill-trigger')).toBeNull();
  });

  it('keeps the key selectable and ellipsised (items 1 and 2)', () => {
    const rule = /\.drill-trigger\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/(?<!-webkit-)user-select:\s*text/);
  });

  it('puts aria-live on the status line only, not around the result table (item 6)', () => {
    expect(document.querySelector('#drill-status')!.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('#drill-panel [aria-live] table')).toBeNull();
    expect(document.querySelector('#drill-panel')!.hasAttribute('aria-live')).toBe(false);
  });
});

describe('createUsageDrill', () => {
  it('opens on a key click and renders the breakdown with the label and footer', async () => {
    const fetchImpl = vi.fn(async () => response(aggregate('stage', ['worker', 'draft'])));
    createUsageDrill({ fetchImpl, getSince: () => '24h' });
    const table = document.querySelector('#table-project') as HTMLTableElement;
    renderTable(table, aggregate('project', ['OpenSwarm']), { drillAxis: 'project' });

    (table.querySelector('.drill-trigger') as HTMLButtonElement).click();
    await flush();

    expect(panel().hidden).toBe(false);
    expect(new URL(fetchImpl.mock.calls[0][0] as string, 'http://x').searchParams.get('project')).toBe('OpenSwarm');
    expect(drillTable().querySelector('thead th')!.textContent).toBe('Stage');
    expect([...drillTable().querySelectorAll('tbody td.key')].map(td => td.textContent)).toEqual(['worker', 'draft']);
    expect(document.querySelector('#drill-footer')!.textContent).toContain('Stage breakdown of Project OpenSwarm');
    expect(status()).toBe('');
  });

  it('does not destroy focus on the Close button when the response lands (item 3)', async () => {
    const { fetchImpl, pending } = deferredFetch();
    const drill = createUsageDrill({ fetchImpl });
    const loading = drill.open('project', 'OpenSwarm');
    const close = document.querySelector('#drill-close') as HTMLButtonElement;
    close.focus();
    expect(document.activeElement).toBe(close);

    pending[0].resolve(response(aggregate('stage', ['worker'])));
    await loading;

    expect(document.activeElement).toBe(close);
    expect(close.isConnected).toBe(true);
  });

  it('a refresh after close does not reopen the panel (item 4: open = null)', async () => {
    const fetchImpl = vi.fn(async () => response(aggregate('stage', ['worker'])));
    const drill = createUsageDrill({ fetchImpl });
    await drill.open('project', 'OpenSwarm');
    (document.querySelector('#drill-close') as HTMLButtonElement).click();
    expect(panel().hidden).toBe(true);

    await drill.refresh();

    expect(panel().hidden).toBe(true);
    expect(drill.current()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a cancelled request failing later does not repaint the panel (item 5: catch guard)', async () => {
    const { fetchImpl, pending } = deferredFetch();
    const drill = createUsageDrill({ fetchImpl });
    const first = drill.open('project', 'OpenSwarm');
    const second = drill.open('project', 'intrect-platform');
    pending[1].resolve(response(aggregate('stage', ['reviewer'])));
    await second;

    pending[0].resolve(response({ error: 'forbidden' }, 403));
    await first;

    expect(status()).toBe('');
    expect([...drillTable().querySelectorAll('tbody td.key')].map(td => td.textContent)).toEqual(['reviewer']);
  });

  it('a request failing after close leaves the panel closed and silent (item 5)', async () => {
    const { fetchImpl, pending } = deferredFetch();
    const drill = createUsageDrill({ fetchImpl });
    const loading = drill.open('project', 'OpenSwarm');
    drill.close();
    pending[0].resolve(response({ error: 'forbidden' }, 403));
    await loading;
    expect(panel().hidden).toBe(true);
    expect(status()).toBe('');
  });

  it('reports a 403 as the token case', async () => {
    const fetchImpl = vi.fn(async () => response({}, 403));
    const drill = createUsageDrill({ fetchImpl });
    await drill.open('stage', 'draft');
    expect(status()).toContain('web token');
  });

  it('ignores a click that finished a text selection inside the key (item 1)', async () => {
    const fetchImpl = vi.fn(async () => response(aggregate('stage', ['worker'])));
    createUsageDrill({ fetchImpl });
    const table = document.querySelector('#table-project') as HTMLTableElement;
    renderTable(table, aggregate('project', ['fba70edf-1234']), { drillAxis: 'project' });
    const trigger = table.querySelector('.drill-trigger') as HTMLButtonElement;
    const range = document.createRange();
    range.selectNodeContents(trigger);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    trigger.click();
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(panel().hidden).toBe(true);
    window.getSelection()!.removeAllRanges();
  });
});

describe('startUsageView wiring', () => {
  const byOf = (url: string) => new URL(url, 'http://x').searchParams.get('by');

  it('binds every listener once and removes them all on dispose (item 7)', async () => {
    const fetchImpl = vi.fn(async (url: string) => response(aggregate(byOf(url)!, ['OpenSwarm'])));
    const first = startUsageView({ fetchImpl: fetchImpl as never });
    first.dispose();
    const view = startUsageView({ fetchImpl: fetchImpl as never });
    await view.refresh();
    fetchImpl.mockClear();

    (document.querySelector('#table-project .drill-trigger') as HTMLButtonElement).click();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockClear();
    (document.querySelector('#refresh') as HTMLButtonElement).click();
    await flush(); await flush();
    // One page load (hour + five axes) plus one drill refresh — not two of each.
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    view.dispose();
  });

  it('makes the four breakdown tables drillable and leaves the task table plain', async () => {
    const fetchImpl = vi.fn(async (url: string) => response(aggregate(byOf(url)!, ['k'])));
    const view = startUsageView({ fetchImpl: fetchImpl as never });
    await view.refresh();
    for (const axis of ['model', 'stage', 'adapter', 'project']) {
      expect(document.querySelector(`#table-${axis} .drill-trigger`)).not.toBeNull();
    }
    expect(document.querySelector('#table-task .drill-trigger')).toBeNull();
    view.dispose();
  });
});
