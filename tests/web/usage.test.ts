// @vitest-environment jsdom
//
// The page is a reader, so its whole value is whether a number arrives on
// screen correctly — and the numbers that matter here are derived, not served.
// `/api/usage` returns raw counters; cache rate, cost per call and calls per
// task are computed in the view, which is exactly where a divide-by-zero or a
// silent NaN turns a cost signal into a blank cell.
//
// Two of those derived numbers already found production defects: a 30.5% draft
// cache rate beside 83-88% (AGT-4286), and 13,287 calls over 239 tasks
// (AGT-4288). Both are asserted below against the shapes that produce them.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import {
  attributedTasks, cacheRate, costPerCall, formatCost, formatPercent, formatTokens,
  formatBucket, loadUsage, rateClass, renderDays, renderSummary, renderTable, share,
  timeAxisFor, WINDOWS,
  rowShare, startUsageView, truncationNote, UNATTRIBUTED, windowFromSearch,
} from '../../web/static/js/usage.mjs';

const SHELL = readFileSync(resolve(__dirname, '../../web/static/usage.html'), 'utf8');

function row(key: string, over: Record<string, number> = {}) {
  return {
    key, calls: 10, meteredCalls: 10, promptTokens: 1000, completionTokens: 100,
    cachedTokens: 800, reasoningTokens: 0, costUsd: 1, ...over,
  };
}

/** Mount the real shell so the tests bind to the same ids the page ships. */
// `UTC on the wire, local on screen` is invisible where the two coincide, and
// CI runners are UTC — a mutant that skips the conversion entirely passes
// there. Pinned to a non-zero offset so the assertion can fail everywhere.
// Only the offset is load-bearing; any non-UTC zone would do. (AGT-4296)
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Seoul'; });
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function mountShell(): void {
  document.body.innerHTML = SHELL.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
}

describe('derived numbers', () => {
  it('computes a cache rate from prompt tokens', () => {
    expect(cacheRate(row('a'))).toBeCloseTo(0.8);
  });

  it('returns null rather than dividing by zero when nothing was prompted', () => {
    // 0% would sit this row next to the genuinely uncached ones, which is the
    // comparison the page is for.
    expect(cacheRate(row('a', { promptTokens: 0, cachedTokens: 0 }))).toBeNull();
    expect(formatPercent(cacheRate(row('a', { promptTokens: 0 })))).toBe('—');
  });

  it('divides cost only over the calls that reported a price', () => {
    // Half the calls unmetered: the per-call price is over the metered half,
    // otherwise a free provider makes a paid one look cheap.
    expect(costPerCall(row('a', { calls: 20, meteredCalls: 10, costUsd: 5 }))).toBeCloseTo(0.5);
    expect(costPerCall(row('a', { meteredCalls: 0 }))).toBeNull();
  });

  it('has no share to report for a row that reported no price', () => {
    // The row-level twin of the case below. On the live ledger gpt-5.6-terra
    // carries 65% of all calls unmetered, and read `—` under 호출당 while
    // reading 0.0% under 점유 in the same row.
    expect(rowShare(row('a', { meteredCalls: 0, costUsd: 0 }), 10)).toBeNull();
    expect(formatPercent(rowShare(row('a', { meteredCalls: 0 }), 10))).toBe('—');
    expect(rowShare(row('a', { meteredCalls: 4, costUsd: 2.5 }), 10)).toBe(0.25);
  });

  it('has no share to report when there is no total, rather than reporting zero', () => {
    // Same argument cacheRate makes: on a window where nothing was metered,
    // 0.0% on every row reads as "these cost nothing relative to the rest"
    // when the truth is that no price was reported at all. Live state — all
    // four attributed tasks on the current ledger are unmetered.
    expect(share(0, 0)).toBeNull();
    expect(share(5, 0)).toBeNull();
    expect(formatPercent(share(5, 0))).toBe('—');
    expect(share(1, 4)).toBe(0.25);
  });

  it('buckets a rate, and refuses to bucket one it does not have', () => {
    expect(rateClass(0.305)).toBe('rate-low');   // the AGT-4286 draft rate
    expect(rateClass(0.5)).toBe('rate-mid');
    expect(rateClass(0.85)).toBe('rate-high');   // where every other stage sat
    expect(rateClass(null)).toBe('');
  });

  it('formats a cost small enough to round to zero without hiding it', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0043)).toBe('$0.0043');
    expect(formatCost(56.38)).toBe('$56.38');
    expect(formatCost(12345.67)).toBe('$12,345.67');   // grouped, like formatCount
  });

  it('does not print an exponential that is larger than the fixed range it escapes', () => {
    // toExponential(1) rounds 9.99e-5 up to 1.0e-4, which sat in the column
    // looking like a different kind of quantity than the $0.0001 beside it.
    expect(formatCost(0.0000999)).toBe('$0.0001');
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.0000036)).toBe('$3.6e-6');
  });

  it('abbreviates tokens, because the exact digit never matters', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(24_222)).toBe('24.2k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
  });
});

describe('tables', () => {
  beforeEach(() => { document.body.innerHTML = '<table id="t"></table>'; });

  it('names the axis in the header instead of leaving the corner blank', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, { by: 'model', rows: [row('qwen')], total: row('total') }, { label: '모델' });
    expect(table.querySelector('thead th')?.textContent).toBe('모델');
    // Falls back to the axis the aggregate names when no label is given.
    renderTable(table, { by: 'stage', rows: [row('draft')], total: row('total') });
    expect(table.querySelector('thead th')?.textContent).toBe('stage');
  });

  it('renders a row per key with the derived columns', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, {
      rows: [row('qwen', { costUsd: 3 }), row('deepseek', { costUsd: 1 })],
      total: row('total', { costUsd: 4 }),
    });

    const cells = [...table.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent));
    expect(cells[0]?.[0]).toBe('qwen');
    expect(cells[0]?.[3]).toBe('80.0%');   // cache rate
    expect(cells[0]?.[6]).toBe('75.0%');   // share of a $4 total
    expect(cells[1]?.[0]).toBe('deepseek');
  });

  it('says so when the window holds nothing', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, { rows: [], total: row('total', { calls: 0, costUsd: 0 }) });
    expect(table.querySelector('td')?.textContent).toContain('사용량이 없습니다');
  });

  it('colours a low cache rate so it stands out from its peers', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, {
      rows: [row('draft', { promptTokens: 1000, cachedTokens: 305 })],
      total: row('total'),
    });
    expect(table.querySelector('td.rate-low')?.textContent).toBe('30.5%');
  });

  it('sorts by calls when asked, not by the cost order the API returns', () => {
    // The API orders by cost. Calls-per-task is a different question and the
    // task table exists to answer it.
    const table = document.querySelector('#t')!;
    renderTable(table, {
      rows: [row('cheap-but-chatty', { calls: 989, costUsd: 1.4 }), row('pricey', { calls: 5, costUsd: 9 })],
      total: row('total', { costUsd: 10.4 }),
    }, { sortBy: 'calls' });
    expect(table.querySelector('tbody td')?.textContent).toBe('cheap-but-chatty');
  });

  it('keeps a non-task out of a ranking of tasks', () => {
    // The unattributed bucket outweighs every real task, so without this it
    // sits at the top of "호출이 많은 순" and pushes them all below the fold.
    const table = document.querySelector('#t')!;
    renderTable(table, {
      rows: [row(UNATTRIBUTED, { calls: 1499 }), row('audit-3-4', { calls: 66 })],
      total: row('total'),
    }, { sortBy: 'calls', excludeUnattributed: true });

    const keys = [...table.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent);
    expect(keys).toEqual(['audit-3-4']);
  });

  it('still shows the unattributed bucket on axes where it is a real grouping', () => {
    // On stage/model it is genuine spend and must not vanish.
    const table = document.querySelector('#t')!;
    renderTable(table, { rows: [row(UNATTRIBUTED, { calls: 1499 })], total: row('total') });
    expect(table.querySelector('tbody td')?.textContent).toBe(UNATTRIBUTED);
  });

  it('caps how many rows it draws, and reports what it drew', () => {
    const table = document.querySelector('#t')!;
    const rows = Array.from({ length: 40 }, (_, i) => row(`m${i}`));
    expect(renderTable(table, { rows, total: row('total') }, { limit: 5 }))
      .toMatchObject({ rows: 40, drawn: 5, hidden: { count: 35 } });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(5);
  });

  it('names the rows it cut instead of dropping their spend silently', () => {
    // Live state, not hypothetical: the project axis returns 67 rows over 30
    // days and the panel draws 25 — 13% of spend, absent with no mention.
    expect(truncationNote({ count: 5, costUsd: 5 })).toContain('5개 항목');
    expect(truncationNote({ count: 5, costUsd: 5 })).toContain('$5.00');
    expect(truncationNote({ count: 0, costUsd: 0 })).toBe('');
    expect(truncationNote(undefined)).toBe('');
  });

  it('reports the cost of the rows IT hid, not of the aggregate tail', () => {
    // The API orders by cost; this panel orders by calls. Re-slicing the
    // aggregate therefore summed the cheapest rows instead of the hidden ones
    // — $0.05 printed for $50.00 of absent spend. Whoever decides the order
    // has to be the one who reports it.
    const table = document.querySelector('#t')!;
    const expensiveQuiet = Array.from({ length: 5 }, (_, i) =>
      row(`nightly-${i}`, { calls: 1, costUsd: 10 }));
    const cheapChatty = Array.from({ length: 30 }, (_, i) =>
      row(`chatty-${i}`, { calls: 500, costUsd: 0.01 }));

    const drew = renderTable(table, {
      rows: [...expensiveQuiet, ...cheapChatty],   // aggregate order: cost desc
      total: row('total', { costUsd: 50.3 }),
    }, { sortBy: 'calls', limit: 30 });

    // Sorted by calls, the five expensive-but-quiet rows fall off the end.
    expect(drew.hidden.count).toBe(5);
    expect(drew.hidden.costUsd).toBeCloseTo(50);
    expect(truncationNote(drew.hidden)).toContain('$50.00');
    const drawnKeys = [...table.querySelectorAll('tbody td:first-child')].map(td => td.textContent);
    expect(drawnKeys).not.toContain('nightly-0');
  });

  it('puts the key in as text here too — the day label is the other raw-key path', () => {
    // renderTable had this assertion; renderDays did not, and the mutation
    // survived the whole suite.
    document.body.innerHTML = '<div id="d"></div>';
    renderDays(document.querySelector('#d')!, {
      rows: [row('<img src=x onerror=alert(1)>')], total: row('total'),
    });
    expect(document.querySelector('#d .bar-day')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('#d img')).toBeNull();
  });

  it('puts the full value on hover for the column that clips, and only that one', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, { rows: [row('a-very-long-task-identifier-that-clips')], total: row('total') });
    const cells = [...table.querySelectorAll('tbody td')] as HTMLElement[];
    expect(cells[0].title).toBe('a-very-long-task-identifier-that-clips');
    expect(cells.slice(1).every(td => td.title === '')).toBe(true);
  });

  it('does not claim nothing happened when the filter removed everything', () => {
    // The task panel would otherwise print an exclusion note beside a table
    // saying no usage was recorded.
    const table = document.querySelector('#t')!;
    renderTable(table, { rows: [row(UNATTRIBUTED, { calls: 9 })], total: row('total') },
      { excludeUnattributed: true });
    expect(table.querySelector('td')?.textContent).toContain('작업에 귀속되지 않았습니다');

    renderTable(table, { rows: [], total: row('total') }, { excludeUnattributed: true });
    expect(table.querySelector('td')?.textContent).toContain('사용량이 없습니다');
  });

  it('measures share against what the panel ranks, not the global total', () => {
    // With the unattributed bucket excluded and holding all the spend, share
    // of the global total is 0.0% on every row — three dead columns.
    const table = document.querySelector('#t')!;
    renderTable(table, {
      rows: [row(UNATTRIBUTED, { costUsd: 100 }), row('a', { costUsd: 3 }), row('b', { costUsd: 1 })],
      total: row('total', { costUsd: 104 }),
    }, { excludeUnattributed: true });
    const shares = [...table.querySelectorAll('tbody tr')].map(tr => tr.querySelectorAll('td')[6].textContent);
    expect(shares).toEqual(['75.0%', '25.0%']);
  });

  it('puts ledger keys in as text, never as markup', () => {
    const table = document.querySelector('#t')!;
    renderTable(table, { rows: [row('<img src=x onerror=alert(1)>')], total: row('total') });
    expect(table.querySelector('tbody td')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(table.querySelector('img')).toBeNull();
  });
});

describe('day series', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="days"></div>'; });

  it('orders oldest first and scales the bars to the busiest day', () => {
    const days = document.querySelector('#days')!;
    renderDays(days, {
      rows: [row('2026-09-10', { costUsd: 25 }), row('2026-09-09', { costUsd: 50 })],
      total: row('total', { costUsd: 75 }),
    });
    const labels = [...days.querySelectorAll('.bar-day')].map(el => el.textContent);
    expect(labels).toEqual(['2026-09-09', '2026-09-10']);
    const widths = [...days.querySelectorAll('.bar-fill')].map(el => (el as HTMLElement).style.width);
    expect(widths).toEqual(['100%', '50%']);
  });

  it('does not divide by a zero peak when every day cost nothing', () => {
    const days = document.querySelector('#days')!;
    renderDays(days, { rows: [row('2026-09-10', { costUsd: 0 })], total: row('total', { costUsd: 0 }) });
    expect((days.querySelector('.bar-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('marks a day whose calls were free, so it does not read as no data', () => {
    // Only metered providers report a price. A day of 170 unmetered calls
    // draws a 0%-wide bar, which looks exactly like a day that never ran.
    const days = document.querySelector('#days')!;
    renderDays(days, {
      rows: [row('2026-09-08', { calls: 170, meteredCalls: 0, costUsd: 0 }), row('2026-09-07', { costUsd: 4 })],
      total: row('total', { costUsd: 4 }),
    });
    // Oldest first: 09-07 carries the cost and sets the peak, 09-08 is the free day.
    const fills = [...days.querySelectorAll('.bar-fill')];
    expect(fills[0].classList.contains('bar-fill-unmetered')).toBe(false);
    expect(fills[1].classList.contains('bar-fill-unmetered')).toBe(true);
  });

  it('says so when the window holds nothing', () => {
    const days = document.querySelector('#days')!;
    renderDays(days, { rows: [], total: row('total') });
    expect(days.textContent).toContain('사용량이 없습니다');
  });
});

describe('attributed tasks (AGT-4288 number)', () => {
  it('excludes the unattributed bucket from both the count and the calls', () => {
    // `usageLedger` buckets every call with no taskId under one key. Counting
    // it as a task, and its calls as task calls, read 340.6 calls/task against
    // a true 53.3 on the ledger this was written from — 6.4x wrong, on the
    // exact card written to reproduce AGT-4288.
    const got = attributedTasks({
      rows: [
        row(UNATTRIBUTED, { calls: 1490 }),
        row('audit-1-4', { calls: 60 }), row('audit-2-4', { calls: 53 }),
        row('audit-3-4', { calls: 50 }), row('audit-4-4', { calls: 50 }),
      ],
      total: row('total', { calls: 1703 }),
    });

    expect(got).toEqual({ tasks: 4, calls: 213 });
    expect(got.calls / got.tasks).toBeCloseTo(53.25);
  });

  it('reports nothing rather than zero tasks when only unattributed calls exist', () => {
    expect(attributedTasks({ rows: [row(UNATTRIBUTED, { calls: 9 })], total: row('total') }))
      .toEqual({ tasks: 0, calls: 0 });
  });
});

describe('summary', () => {
  beforeEach(mountShell);

  it('reports calls per task — the ratio that reads as wrong, not the total', () => {
    // AGT-4288's number: 13,287 calls over 239 tasks. The unattributed bucket
    // rides along in the same axis and must not be counted as a 240th task.
    renderSummary(document, {
      model: { rows: [], total: row('total', { calls: 13287, meteredCalls: 13287, costUsd: 57.09 }) },
      task: {
        rows: [
          row(UNATTRIBUTED, { calls: 4000 }),
          ...Array.from({ length: 239 }, (_, i) => row(`t${i}`, { calls: 55 })),
        ],
        total: row('total'),
      },
    });
    expect(document.querySelector('#sum-calls')?.textContent).toBe('13,287');
    expect(document.querySelector('#sum-calls-note')?.textContent).toContain('239개 작업');
    expect(document.querySelector('#sum-calls-note')?.textContent).toContain('55.0회');
    // The headline is every call; the ratio is over attributed calls only.
    // Without naming the remainder a reader divides 13,287/239 and lands 4x off.
    expect(document.querySelector('#sum-calls-note')?.textContent).toContain('미귀속');
    expect(document.querySelector('#sum-cost')?.textContent).toBe('$57.09');
  });

  it('names the unmetered calls instead of quietly under-reporting cost', () => {
    renderSummary(document, {
      model: { rows: [], total: row('total', { calls: 100, meteredCalls: 60, costUsd: 3 }) },
      task: { rows: [], total: row('total') },
    });
    expect(document.querySelector('#sum-cost-note')?.textContent).toContain('40');
  });

  it('survives a window with no tasks at all', () => {
    renderSummary(document, {
      model: { rows: [], total: row('total', { calls: 0, meteredCalls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 }) },
      task: { rows: [], total: row('total') },
    });
    expect(document.querySelector('#sum-calls-note')?.textContent).toBe('');
    expect(document.querySelector('#sum-cache')?.textContent).toBe('—');
  });
});

describe('loading', () => {
  beforeEach(mountShell);

  const ok = (by: string) => ({
    ok: true,
    json: async () => ({ since: '2026-09-09T00:00:00.000Z', until: '2026-09-10T00:00:00.000Z', by, rows: [row(`${by}-a`)], total: row('total') }),
  });

  it('asks for every axis in one window', async () => {
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    const data = await loadUsage('7d', fetchImpl as never);

    const asked = fetchImpl.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('by'));
    // 7d is past the hourly ceiling, so the time axis is still `day`.
    expect(asked.sort()).toEqual(['adapter', 'day', 'model', 'project', 'stage', 'task']);
    expect(fetchImpl.mock.calls.every(([url]) => (url as string).includes('since=7d'))).toBe(true);
    expect(data.model.rows[0].key).toBe('model-a');
  });

  it('fills the page from a fetched window', async () => {
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    await startUsageView({ fetchImpl: fetchImpl as never }).refresh();

    expect(document.querySelector('#table-model tbody td')?.textContent).toBe('model-a');
    expect(document.querySelector('#table-stage tbody td')?.textContent).toBe('stage-a');
    // The default window is 24h, so the series comes off the hour axis.
    expect(document.querySelector('#days .bar-day')?.textContent).toBe('hour-a');
    expect(document.querySelector('#days-title')?.textContent).toBe('시간별');
    expect(document.querySelector('#status')?.textContent).toContain('기준');
  });

  it('names the token case instead of reading as a dead daemon', async () => {
    // A 403 from a Tailscale browser is the missing-token case. Reporting it
    // as a generic failure is what made the dashboard look dead before.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await startUsageView({ fetchImpl: fetchImpl as never }).refresh();
    expect(document.querySelector('#status')?.textContent).toContain('웹 토큰');
  });

  it('applies a pasted token through the wrapper, not a second storage key', async () => {
    // The panel markup shipped with warehouse.html; copying it without wiring
    // it would leave a field that looks like it does something and does not.
    // Attach to the real jsdom window and take it back off. Replacing
    // `globalThis.window` outright would clobber the document every later test
    // in this file renders into.
    const storeToken = vi.fn();
    (window as unknown as Record<string, unknown>).OpenSwarmWebToken = { storeToken };
    onTestFinished(() => { delete (window as unknown as Record<string, unknown>).OpenSwarmWebToken; });
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });

    (document.querySelector('#web-token') as HTMLInputElement).value = 'secret';
    (document.querySelector('#save-token') as HTMLButtonElement).click();

    expect(storeToken).toHaveBeenCalledWith('secret');
    // Cleared from the field so the credential does not sit in the DOM.
    expect((document.querySelector('#web-token') as HTMLInputElement).value).toBe('');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    (document.querySelector('#clear-token') as HTMLButtonElement).click();
    expect(storeToken).toHaveBeenLastCalledWith('');
  });

  it('lets the newest window win when a slow one lands second', async () => {
    // Pick 7d, change your mind, pick 24h. The 7d response arrives last and
    // would paint over the 24h one — leaving the select, the URL and the
    // status line all naming a window that none of the numbers belong to.
    let release: (() => void) | undefined;
    const slow = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const since = u.searchParams.get('since');
      const by = u.searchParams.get('by')!;
      if (since === '7d') await slow;
      return {
        ok: true,
        json: async () => ({ by, rows: [row(`${by}-from-${since}`)], total: row('total') }),
      };
    });
    const view = startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });
    const select = document.querySelector('#window') as HTMLSelectElement;

    select.value = '7d';
    const first = view.refresh();
    select.value = '24h';
    await view.refresh();
    release!();
    await first;

    expect(document.querySelector('#table-model tbody td')?.textContent).toBe('model-from-24h');
  });

  it('refuses an empty 적용 instead of deleting the token that is working', async () => {
    // `storeToken('')` is the wrapper's REMOVE path, and the field is empty in
    // exactly the case that matters — it is cleared after each use and the
    // wrapper's own prompt never fills it. One stray click would log a
    // Tailscale operator out page-wide.
    const storeToken = vi.fn();
    (window as unknown as Record<string, unknown>).OpenSwarmWebToken = { storeToken };
    onTestFinished(() => { delete (window as unknown as Record<string, unknown>).OpenSwarmWebToken; });
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });

    (document.querySelector('#web-token') as HTMLInputElement).value = '   ';
    (document.querySelector('#save-token') as HTMLButtonElement).click();

    expect(storeToken).not.toHaveBeenCalled();
    expect(document.querySelector('#status')?.textContent).toContain('입력한 뒤');
    // 지우기 is still an explicit, separate action.
    (document.querySelector('#clear-token') as HTMLButtonElement).click();
    expect(storeToken).toHaveBeenCalledWith('');
  });

  it('rewrites a window the API would accept but the page does not offer', async () => {
    // `?since=90m` parses server-side but is not in the selector, so the page
    // rendered 24h under a URL claiming 90m — silently, on a shared link.
    const replaceState = vi.fn();
    const history = { replaceState };
    const original = globalThis.history;
    Object.defineProperty(globalThis, 'history', { value: history, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(globalThis, 'history', { value: original, configurable: true });
    });
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));

    startUsageView({ fetchImpl: fetchImpl as never, location: { search: '?since=90m' } as never });

    expect(replaceState).toHaveBeenCalled();
    expect(String(replaceState.mock.calls[0][2])).toContain('since=24h');
  });

  it('orders the task table by calls at the call site, not just when asked directly', async () => {
    // The heading says "호출이 많은 순". Dropping the option at the call site
    // silently orders by cost and no existing test noticed.
    const fetchImpl = vi.fn(async (url: string) => {
      const by = new URL(url, 'http://x').searchParams.get('by')!;
      const rows = by === 'task'
        ? [row('pricey', { calls: 5, costUsd: 9 }), row('chatty', { calls: 989, costUsd: 1.4 })]
        : [row(`${by}-a`)];
      return { ok: true, json: async () => ({ by, rows, total: row('total', { costUsd: 10.4 }) }) };
    });

    await startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never }).refresh();

    expect(document.querySelector('#table-task tbody td')?.textContent).toBe('chatty');
  });

  it('names the calls it left out of the task ranking instead of just dropping them', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const by = new URL(url, 'http://x').searchParams.get('by')!;
      const rows = by === 'task'
        ? [row(UNATTRIBUTED, { calls: 1499, costUsd: 0.47 }), row('audit-3-4', { calls: 66 })]
        : [row(`${by}-a`)];
      return { ok: true, json: async () => ({ by, rows, total: row('total') }) };
    });

    await startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never }).refresh();

    const note = document.querySelector('#task-note')?.textContent ?? '';
    expect(note).toContain('1,499');
    expect(note).toContain('$0.47');
    expect(document.querySelector('#table-task tbody td')?.textContent).toBe('audit-3-4');
  });

  it('keeps the controls on the window whose numbers are on screen when a load fails', async () => {
    // The other half of the race the sequence token fixes. Switching to a
    // window that fails left the select and the URL naming it while every
    // figure was still the previous load's.
    let failNext = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (failNext) throw new Error('network down');
      return ok(new URL(url, 'http://x').searchParams.get('by')!);
    });
    const replaceState = vi.fn();
    const original = globalThis.history;
    Object.defineProperty(globalThis, 'history', { value: { replaceState }, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(globalThis, 'history', { value: original, configurable: true });
    });

    const view = startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });
    await view.refresh();                       // 24h renders
    const select = document.querySelector('#window') as HTMLSelectElement;
    select.value = '30d';
    failNext = true;
    await view.refresh();                       // 30d fails

    expect(select.value).toBe('24h');
    expect(String(replaceState.mock.calls.at(-1)?.[2])).toContain('since=24h');
    expect(document.querySelector('#status')?.textContent).toContain('24h 데이터를 유지합니다');
    expect(document.querySelector('#table-model tbody td')?.textContent).toBe('model-a');
  });

  it('does not let a slow failure clear a newer good render', async () => {
    // The catch path needs the sequence guard too.
    let release: (() => void) | undefined;
    const slow = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      if (u.searchParams.get('since') === '7d') { await slow; throw new Error('slow failure'); }
      return ok(u.searchParams.get('by')!);
    });
    const view = startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });
    const select = document.querySelector('#window') as HTMLSelectElement;

    select.value = '7d';
    const first = view.refresh();
    select.value = '24h';
    await view.refresh();
    release!();
    await first;

    expect(document.querySelector('#status')?.textContent).toContain('기준');
    expect(select.value).toBe('24h');
  });

  it('reports a failed axis rather than leaving the page on 불러오는 중', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    await startUsageView({ fetchImpl: fetchImpl as never }).refresh();
    expect(document.querySelector('#status')?.textContent).toContain('network down');
  });

  it('opens on the window the URL names, so a 30-day view can be linked', async () => {
    // Also the only way to tell an empty window from a broken page: ask for a
    // window you know has data.
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    await startUsageView({ fetchImpl: fetchImpl as never, location: { search: '?since=30d' } as never }).refresh();
    expect((document.querySelector('#window') as HTMLSelectElement).value).toBe('30d');
    expect(fetchImpl.mock.calls[0][0] as string).toContain('since=30d');
  });

  it('ignores a window the selector does not offer', () => {
    expect(windowFromSearch('?since=30d')).toBe('30d');
    expect(windowFromSearch('?since=99y')).toBeNull();
    expect(windowFromSearch('')).toBeNull();
    expect(windowFromSearch(undefined)).toBeNull();
  });

  it('reloads when the window changes', async () => {
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    startUsageView({ fetchImpl: fetchImpl as never });
    const select = document.querySelector('#window') as HTMLSelectElement;
    select.value = '30d';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect((fetchImpl.mock.calls[0][0] as string)).toContain('since=30d');
  });
});

describe('windows and the time axis (AGT-4296)', () => {
  beforeEach(mountShell);

  const ok = (by: string) => ({
    ok: true,
    json: async () => ({ since: '2026-09-09T00:00:00.000Z', until: '2026-09-10T00:00:00.000Z', by, rows: [row(`${by}-a`)], total: row('total') }),
  });

  it('picks the finest axis that still draws a series, and stops before it is a texture', () => {
    expect(timeAxisFor('1h')).toBe('hour');
    expect(timeAxisFor('2h')).toBe('hour');
    expect(timeAxisFor('48h')).toBe('hour');
    expect(timeAxisFor('49h')).toBe('day');
    expect(timeAxisFor('7d')).toBe('day');
    expect(timeAxisFor('90m')).toBe('hour');
    // A hand-typed ISO date can name a window of any length, so it takes the
    // coarse axis rather than a guess. Same for a missing value.
    expect(timeAxisFor('2026-09-01')).toBe('day');
    expect(timeAxisFor(undefined)).toBe('day');
  });

  it('offers the short windows the selector was missing', () => {
    expect(WINDOWS.slice(0, 3)).toEqual(['1h', '2h', '6h']);
    const offered = [...document.querySelectorAll('#window option')].map(o => (o as HTMLOptionElement).value);
    expect(offered).toEqual(WINDOWS);
    // Every option is a window the URL parser will accept back.
    expect(offered.every(v => windowFromSearch(`?since=${v}`) === v)).toBe(true);
  });

  it('asks for the hour axis on a short window and renders it as the series', async () => {
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    const data = await loadUsage('2h', fetchImpl as never);

    const asked = fetchImpl.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('by'));
    expect(asked).toContain('hour');
    expect(asked).not.toContain('day');
    expect(data.timeAxis).toBe('hour');
    expect(data.time).toBe(data.hour);
  });

  it("renders a UTC hour bucket on the reader's clock, and leaves a day alone", () => {
    // A literal, not the implementation's own expression: recomputing the
    // expected value with the code under test says "the code equals the code"
    // and would not notice a wrong `timeZone`. 14:00Z is 23시 in the pinned zone.
    expect(formatBucket('2026-09-10T14')).toBe('9. 10. 23시');
    // A day key must NOT be converted — shifting it by the offset relabels the
    // day, which is AGT-4293's scope, not this change's.
    expect(formatBucket('2026-09-10')).toBe('2026-09-10');
    expect(formatBucket('not-a-bucket')).toBe('not-a-bucket');
    expect(formatBucket(undefined)).toBe('');
  });

  it('keeps the raw bucket key reachable after formatting it', () => {
    document.body.innerHTML = '<div id="d"></div>';
    renderDays(document.querySelector('#d')!, { rows: [row('2026-09-10T14')], total: row('total') });
    const label = document.querySelector('#d .bar-day') as HTMLElement;
    expect(label.title).toBe('2026-09-10T14');
    expect(label.textContent).toBe('9. 10. 23시');
  });

  it('heads the card with the axis it actually drew', async () => {
    const fetchImpl = vi.fn(async (url: string) => ok(new URL(url, 'http://x').searchParams.get('by')!));
    const view = startUsageView({ fetchImpl: fetchImpl as never, location: { search: '' } as never });
    (document.querySelector('#window') as HTMLSelectElement).value = '7d';
    await view.refresh();
    expect(document.querySelector('#days-title')?.textContent).toBe('일별');

    (document.querySelector('#window') as HTMLSelectElement).value = '1h';
    await view.refresh();
    expect(document.querySelector('#days-title')?.textContent).toBe('시간별');
  });
});
