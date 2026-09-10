// Usage dashboard — the token/cost ledger, on a screen. (AGT-4289)
//
// `/api/usage` has served six axes since AGT-4178 and had no frontend reader;
// the only consumer was the `openswarm cost` CLI. Two defects found by hand-
// querying that ledger over ssh were each a single number on an axis it
// already serves: a 30.5% draft cache rate beside 83-88% everywhere else
// (AGT-4286), and 13,287 draft calls across 239 tasks (AGT-4288).
//
// The endpoint groups by ONE axis per request, so this fetches several in
// parallel rather than changing the aggregate. The derived columns —
// cache rate, cost per call, calls per task — are the ones that carry the
// cost signal; the raw rows do not have them.

const AXES = ['day', 'model', 'stage', 'adapter', 'project', 'task'];

/**
 * cachedTokens / promptTokens, or null when there is nothing to divide.
 *
 * Null rather than 0: a stage that made no prompt-token calls has no cache
 * rate, and showing it as 0% would put it next to the genuinely uncached ones
 * this page exists to surface.
 */
export function cacheRate(row) {
  const prompt = row?.promptTokens ?? 0;
  if (prompt <= 0) return null;
  return (row.cachedTokens ?? 0) / prompt;
}

/**
 * A row's share of the total, or null when there is no total to be a share of.
 *
 * Null, not 0, for the reason `cacheRate` gives above: an unmetered window has
 * no cost to divide, and printing 0.0% puts every row of it beside rows that
 * genuinely cost nothing relative to their peers. On the ledger this was
 * written against all four attributed tasks are unmetered, so the whole 점유
 * column read 0.0% while 호출당 in the same row honestly read `—`.
 */
export function share(value, total) {
  if (!total || total <= 0) return null;
  return value / total;
}

/**
 * A row's share of `total`, or null when the row reported no price at all.
 *
 * `share` alone answers the aggregate-level question — is there a total to
 * divide? This answers the row-level one, and they are different: on the live
 * ledger `gpt-5.6-terra` carries 65% of all calls with no price reported, so
 * it read `—` under 호출당 ("we have no price") and `0.0%` under 점유 ("we
 * know its price and it is nothing") in the same row. Same gate `costPerCall`
 * uses, for the same reason.
 */
export function rowShare(row, total) {
  if ((row?.meteredCalls ?? 0) <= 0) return null;
  return share(row.costUsd ?? 0, total);
}

/** Cost divided over the calls that actually reported a price. */
export function costPerCall(row) {
  const metered = row?.meteredCalls ?? 0;
  if (metered <= 0) return null;
  return (row.costUsd ?? 0) / metered;
}

/** Bucket a rate for colouring. Unknown rates get no class rather than a bad one. */
export function rateClass(rate) {
  if (rate === null || rate === undefined) return '';
  if (rate < 0.4) return 'rate-low';
  if (rate < 0.7) return 'rate-mid';
  return 'rate-high';
}

export function formatCost(usd) {
  const n = usd ?? 0;
  if (n === 0) return '$0';
  // Per-call costs get small as a window gets large: at 132k calls for $0.47
  // every row rounds to $0.0000 with four places, and the column goes dead
  // exactly when the window is big enough to be worth reading.
  // Below the point where toExponential(1) would round the mantissa to 10 and
  // print $1.0e-4 for a value smaller than the $0.0001 shown as fixed.
  if (Math.abs(n) < 0.00005) return `$${n.toExponential(1)}`;
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  // Group thousands, like formatCount does — these sit in adjacent columns.
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCount(n) {
  return (n ?? 0).toLocaleString('en-US');
}

/** Tokens are large and their exact value never matters — 1.2M reads, 1203481 does not. */
export function formatTokens(n) {
  const v = n ?? 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

export function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function cell(text, className, { titled = false } = {}) {
  const td = document.createElement('td');
  td.textContent = text;
  // Only the key column clips (max-width + overflow hidden, and the cell does
  // not scroll), so only it needs the full value on hover. Numbers are short
  // and a tooltip on each would be seven redundant ones per row.
  if (titled) td.title = text;
  if (className) td.className = className;
  return td;
}

/**
 * Render one axis as a table.
 *
 * Values go in through textContent: every key here is ledger data — a model
 * id, a task identifier, a project directory name — and none of it is ours.
 */
/**
 * Say what a table left out.
 *
 * Takes the tally `renderTable` returns rather than re-deriving it. The first
 * version re-sliced the aggregate, which is ordered by cost — but the task
 * panel sorts by calls inside `renderTable`, so the caller summed the cheapest
 * tail instead of the rows actually hidden and printed $0.05 for $50.00 of
 * absent spend. Whoever decides the order has to be the one who reports it.
 */
export function truncationNote(hidden) {
  if (!hidden || hidden.count <= 0) return '';
  return `그 외 ${formatCount(hidden.count)}개 항목(${formatCost(hidden.costUsd)})은 표시하지 않았습니다.`;
}

export function renderTable(table, aggregate, { limit = 25, sortBy = 'cost', label = '', excludeUnattributed = false } = {}) {
  table.replaceChildren();
  // A ranking of tasks must not be topped by the bucket for calls that named
  // no task: it outweighs every real row and pushes them all below the fold.
  const rows = [...(aggregate?.rows ?? [])].filter(r => !excludeUnattributed || r.key !== UNATTRIBUTED);
  // Share is of what this panel ranks. Against the global total, every row in
  // a panel whose excluded bucket holds all the spend reads 0.0%.
  const shareBase = excludeUnattributed
    ? rows.reduce((n, r) => n + (r.costUsd ?? 0), 0)
    : (aggregate?.total?.costUsd ?? 0);
  if (rows.length === 0) {
    // "No usage recorded" is false when there WAS usage and the filter removed
    // it — the task panel would otherwise print an exclusion note beside a
    // table claiming nothing happened.
    const filteredAll = excludeUnattributed && (aggregate?.rows?.length ?? 0) > 0;
    const body = document.createElement('tbody');
    const tr = document.createElement('tr');
    const td = cell(filteredAll
      ? '이 기간의 호출은 모두 작업에 귀속되지 않았습니다.'
      : '이 기간에 기록된 사용량이 없습니다.', 'usage-empty');
    td.colSpan = 7;
    tr.append(td);
    body.append(tr);
    table.append(body);
    return { rows: 0, drawn: 0, hidden: { count: 0, costUsd: 0 } };
  }
  if (sortBy === 'calls') rows.sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0));

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of [label || aggregate?.by || '', '호출', '토큰', '캐시', '호출당', '비용', '점유']) {
    const th = document.createElement('th');
    th.textContent = heading;
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  const drawn = rows.slice(0, limit);
  const cut = rows.slice(limit);
  for (const row of drawn) {
    const tr = document.createElement('tr');
    const rate = cacheRate(row);
    const per = costPerCall(row);
    tr.append(
      cell(row.key, 'key', { titled: true }),
      cell(formatCount(row.calls), 'num'),
      cell(formatTokens((row.promptTokens ?? 0) + (row.completionTokens ?? 0)), 'num'),
      cell(formatPercent(rate), `num ${rateClass(rate)}`.trim()),
      cell(per === null ? '—' : formatCost(per), 'num'),
      cell(formatCost(row.costUsd), 'num'),
      cell(formatPercent(rowShare(row, shareBase)), 'num'),
    );
    body.append(tr);
  }
  table.append(head, body);
  return {
    rows: rows.length,
    drawn: drawn.length,
    hidden: { count: cut.length, costUsd: cut.reduce((n, r) => n + (r.costUsd ?? 0), 0) },
  };
}

/** Render the day axis as bars, oldest first — a series read left to right in time. */
export function renderDays(container, aggregate) {
  container.replaceChildren();
  const rows = [...(aggregate?.rows ?? [])].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'usage-empty';
    p.textContent = '이 기간에 기록된 사용량이 없습니다.';
    container.append(p);
    return;
  }
  // Scale to the busiest day, not to the total: the shape of the series is
  // what is being read, and a fixed scale would flatten every quiet day.
  //
  // Cost is the axis because cost is what this page is for, but it is also
  // optional — only metered providers report a price, and on the ledger this
  // was written against two thirds of calls had none. A day of 170 unmetered
  // calls costs $0 and would draw an empty track, which reads as "no data"
  // rather than "no charge". Every row here has at least one call (the
  // aggregate creates no row otherwise), so any row that drew nothing gets a
  // marker instead: present, and not worth measuring.
  const peak = Math.max(...rows.map(r => r.costUsd ?? 0), 0);
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'bar-row';

    const day = document.createElement('span');
    day.className = 'bar-day';
    day.textContent = row.key;

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    const fraction = peak > 0 ? (row.costUsd ?? 0) / peak : 0;
    fill.style.width = `${fraction * 100}%`;
    if (fraction === 0) fill.classList.add('bar-fill-unmetered');
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = `${formatCost(row.costUsd)} · ${formatCount(row.calls)}회`;

    line.append(day, track, value);
    container.append(line);
  }
}

/** The bucket `usageLedger` gives every call that named no task. */
export const UNATTRIBUTED = '(unattributed)';

/** Tasks and their calls, with the unattributed bucket excluded from both. */
export function attributedTasks(aggregate) {
  const rows = (aggregate?.rows ?? []).filter(r => r.key !== UNATTRIBUTED);
  return { tasks: rows.length, calls: rows.reduce((n, r) => n + (r.calls ?? 0), 0) };
}

/** Fill the four summary cards from the model axis, plus calls-per-task. */
export function renderSummary(root, { model, task }) {
  const total = model?.total ?? {};
  const set = (id, text) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.textContent = text;
  };
  set('sum-cost', formatCost(total.costUsd));
  const unmetered = (total.calls ?? 0) - (total.meteredCalls ?? 0);
  set('sum-cost-note', unmetered > 0 ? `${formatCount(unmetered)}회는 가격 미보고` : '');

  set('sum-calls', formatCount(total.calls));
  // The AGT-4288 number. It is the ratio, not the total, that reads as wrong —
  // so the ratio has to be right. `usageLedger` buckets every call with no
  // taskId under one '(unattributed)' key, which is not a task: counting it as
  // one, and its calls as task calls, read 340.6 against a true 53.3 on the
  // ledger this was written from.
  const attributed = attributedTasks(task);
  // Name the remainder, the way the 비용 card names its unmetered calls. The
  // headline is every call; the ratio is over attributed calls only, and a
  // reader dividing the headline by the task count lands 8x off.
  const loose = (total.calls ?? 0) - attributed.calls;
  set('sum-calls-note', attributed.tasks > 0
    ? `${formatCount(attributed.tasks)}개 작업 · 작업당 ${(attributed.calls / attributed.tasks).toFixed(1)}회`
      + (loose > 0 ? ` · ${formatCount(loose)}회 미귀속` : '')
    : '');

  set('sum-tokens', formatTokens((total.promptTokens ?? 0) + (total.completionTokens ?? 0)));
  set('sum-tokens-note', `프롬프트 ${formatTokens(total.promptTokens)} · 출력 ${formatTokens(total.completionTokens)}`);

  const rate = cacheRate(total);
  set('sum-cache', formatPercent(rate));
  const cacheEl = root.querySelector('#sum-cache');
  if (cacheEl) cacheEl.className = `stat-value ${rateClass(rate)}`.trim();
}

/**
 * Fetch every axis for one window.
 *
 * `Promise.all`, so one failed axis fails the load. The realistic failure is a
 * 403, which hits all six identically and is reported as the token case; a
 * partial render for the rarer per-request failures is a separate change.
 */
export async function loadUsage(since, fetchImpl = globalThis.fetch) {
  const results = await Promise.all(AXES.map(async (by) => {
    const res = await fetchImpl(`/api/usage?since=${encodeURIComponent(since)}&by=${by}`);
    if (!res.ok) throw new Error(`/api/usage?by=${by} → ${res.status}`);
    return [by, await res.json()];
  }));
  return Object.fromEntries(results);
}

/** Windows the selector offers. A hand-typed `?since=` outside this set is ignored. */
export const WINDOWS = ['24h', '7d', '30d'];

/** The window named by the URL, or null when it names nothing valid. */
export function windowFromSearch(search) {
  const value = new URLSearchParams(search ?? '').get('since');
  return WINDOWS.includes(value) ? value : null;
}

/**
 * Put the rendered window in the URL so the view can be linked and reloaded.
 *
 * replaceState, not push: flipping the window is not a navigation, and a back
 * button that walks through every window the operator tried is noise.
 */
function writeWindowToUrl(value) {
  try {
    const url = new URL(globalThis.location?.href ?? 'http://localhost/usage');
    url.searchParams.set('since', value);
    globalThis.history?.replaceState?.(null, '', `${url.pathname}${url.search}`);
  } catch { /* no history in a test document; rendering still proceeds */ }
}

export function startUsageView({ root = document, fetchImpl = globalThis.fetch, location: loc = globalThis.location } = {}) {
  // Only the newest request may paint. Windows differ in cost — 24h opens one
  // day file, 30d up to thirty — so picking 7d then 24h lands the 7d response
  // second, and every control on the page would then deny the numbers on it.
  let latest = 0;
  const status = root.querySelector('#status');
  const windowSelect = root.querySelector('#window');
  const say = (text) => { if (status) status.textContent = text; };

  // The window is state, so it belongs in the URL: a 30-day view can be linked
  // and reloaded. It also makes an empty window distinguishable from a broken
  // page — you can ask for a window you know has data.
  const fromUrl = windowFromSearch(loc?.search);
  if (fromUrl && windowSelect) windowSelect.value = fromUrl;
  // `parseUsageSince` accepts more than the selector offers ('90m', an ISO
  // date). Landing on one of those showed 24h data under a URL claiming
  // otherwise, silently — so rewrite the URL to the window actually rendered.
  else if (loc?.search?.includes('since=')) writeWindowToUrl(windowSelect?.value ?? '24h');

  /** The window whose data is currently on screen, so a failure can go back to it. */
  let rendered = null;

  async function refresh() {
    const since = windowSelect?.value ?? '24h';
    const seq = ++latest;
    say('불러오는 중…');
    try {
      const data = await loadUsage(since, fetchImpl);
      if (seq !== latest) return;   // a newer window is already in flight
      renderSummary(root, data);
      renderDays(root.querySelector('#days'), data.day);
      const LABELS = { model: '모델', stage: '스테이지', adapter: '어댑터', project: '프로젝트' };
      for (const axis of ['model', 'stage', 'adapter', 'project']) {
        const table = root.querySelector(`#table-${axis}`);
        if (!table) continue;
        const drew = renderTable(table, data[axis], { label: LABELS[axis] });
        const note = root.querySelector(`#note-${axis}`);
        if (note) note.textContent = truncationNote(drew.hidden);
      }
      const taskTable = root.querySelector('#table-task');
      if (taskTable) {
        const drew = renderTable(taskTable, data.task,
          { sortBy: 'calls', limit: 30, label: '작업', excludeUnattributed: true });
        // Excluded, not hidden: name what was left out and how big it was.
        const loose = (data.task?.rows ?? []).find(r => r.key === UNATTRIBUTED);
        const note = root.querySelector('#task-note');
        if (note) {
          const parts = [];
          if (loose) parts.push(`작업에 귀속되지 않은 호출 ${formatCount(loose.calls)}회(${formatCost(loose.costUsd)})는 제외했습니다.`);
          const cut = truncationNote(drew.hidden);
          if (cut) parts.push(cut);
          note.textContent = parts.join(' ');
        }
      }
      rendered = since;
      // `기준` names when the data ends. Falling back to `since` would print
      // the window's START under that label, which is the opposite.
      const until = data.model?.until;
      say(until ? `기준 ${new Date(until).toLocaleString('ko-KR')}` : '');
    } catch (err) {
      if (seq !== latest) return;
      // Put the controls back on the window the numbers actually came from.
      // Otherwise a failed switch leaves the select and the URL naming 30d
      // while every figure on screen is still the 24h load — the exact state
      // the sequence token above exists to prevent, reached the other way.
      if (rendered && rendered !== since && windowSelect) {
        windowSelect.value = rendered;
        writeWindowToUrl(rendered);
      }
      // A 403 here is the token case, not a dead daemon — say which.
      const message = String(err?.message ?? err);
      const scope = rendered && rendered !== since ? `${since} 조회 실패 — ${rendered} 데이터를 유지합니다. ` : '';
      say(message.includes('403')
        ? `${scope}접근 권한이 없습니다. 아래에서 웹 토큰을 입력하세요.`
        : `${scope}사용량을 불러오지 못했습니다: ${message}`);
    }
  }

  // The token panel. `webToken.js` already wraps fetch and prompts on a 403,
  // so this is the explicit path rather than the only one — but shipping the
  // markup without wiring it would leave a field that silently does nothing.
  // Go through the wrapper's own store so there is one definition of where a
  // token lives, not a second copy of the storage key.
  const tokenStore = () => globalThis.window?.OpenSwarmWebToken;
  const tokenInput = root.querySelector('#web-token');
  root.querySelector('#save-token')?.addEventListener('click', () => {
    // `storeToken('')` is the wrapper's REMOVE path, and this field is empty in
    // exactly the case that matters: it is cleared after each use and the
    // wrapper's own prompt never fills it. One stray click would otherwise
    // delete a working credential page-wide — and if the prompt had been
    // dismissed once, `declined` is latched and it does not come back.
    const token = tokenInput?.value?.trim();
    if (!token) { say('토큰을 입력한 뒤 적용을 누르세요.'); return; }
    tokenStore()?.storeToken(token);
    if (tokenInput) tokenInput.value = '';
    refresh();   // says '불러오는 중…' itself; a confirmation here would be overwritten
  });
  root.querySelector('#clear-token')?.addEventListener('click', () => {
    tokenStore()?.storeToken('');
    say('이 탭의 토큰을 지웠습니다.');
  });

  windowSelect?.addEventListener('change', () => {
    writeWindowToUrl(windowSelect.value);
    refresh();
  });
  root.querySelector('#refresh')?.addEventListener('click', refresh);
  return { refresh };
}

if (typeof document !== 'undefined' && document.querySelector('#days')) {
  startUsageView().refresh();
}
