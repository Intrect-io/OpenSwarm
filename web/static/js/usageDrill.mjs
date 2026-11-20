// Usage drill-down — one row of an axis, broken down by another. (AGT-4297)
//
// `/api/usage` groups by one axis per request, so "where does OpenSwarm's
// 36.5% cache rate come from?" could only be answered by fetching
// `by=project` and `by=stage` separately and inventing the correlation by eye.
// The server half (PR #825) accepts `?by=stage&project=OpenSwarm` and groups
// the filtered rows with the same key function as the parent table, so the
// drill-down total equals the parent row. This module is the reader for it.
//
// Round-3 review findings this file is written against (numbers from the issue):
//   1/2 the key stays selectable and ellipsised — see `.drill-trigger` in usage.css;
//   3   a response repaints the table and status only, never the panel, so a
//       focused Close button keeps focus;
//   4   close() clears `open`, so a later refresh cannot resurrect the panel;
//   5   the catch branch has its own sequence guard, so a cancelled request's
//       403 cannot repaint a closed or newer panel;
//   6   aria-live sits on the one-line status, not on the result table;
//   7   every listener is registered through one AbortSignal;
//   8   the footer names axes by their table labels, not raw axis ids.

import { formatDateTime } from './format.mjs';
import { renderTable, truncationNote } from './usage.mjs';

/** What each drillable table breaks down into. */
export const DRILL_TARGET = Object.freeze({ project: 'stage', model: 'stage', adapter: 'stage', stage: 'project' });

/** The labels the tables above use, so the panel speaks the same words. */
export const AXIS_LABELS = Object.freeze({ model: 'Model', stage: 'Stage', adapter: 'Adapter', project: 'Project', task: 'Task' });

export function isDrillable(axis) {
  return Object.prototype.hasOwnProperty.call(DRILL_TARGET, axis);
}

/** `/api/usage?since=24h&by=stage&project=OpenSwarm` for one row. */
export function drillUrl(since, axis, key) {
  const params = new URLSearchParams({ since: String(since), by: DRILL_TARGET[axis] });
  params.set(axis, String(key));
  return `/api/usage?${params.toString()}`;
}

/** Footer line: which row, broken down by what, over the bounds the server actually used. */
export function drillFooter(axis, key, data) {
  const child = DRILL_TARGET[axis];
  const bounds = data?.since && data?.until ? ` · ${formatDateTime(data.since)} – ${formatDateTime(data.until)}` : '';
  return `${AXIS_LABELS[child] ?? child} breakdown of ${AXIS_LABELS[axis] ?? axis} ${key}${bounds}`;
}

/**
 * The key cell a click landed on, unless the click finished a text selection
 * inside it: dragging across a worktree UUID to copy it is a copy, not a drill.
 */
export function drillTriggerFor(event) {
  const trigger = event?.target?.closest?.('.drill-trigger');
  if (!trigger) return null;
  const selection = globalThis.getSelection?.();
  if (selection && String(selection) && trigger.contains(selection.anchorNode)) return null;
  return trigger;
}

/**
 * Bind the drill panel. Returns `{ open, close, refresh, current }`.
 *
 * `signal` removes every listener this registers; `getSince` reads the window
 * the page is showing so a drill always matches the tables beside it.
 */
export function createUsageDrill({ root = document, fetchImpl = globalThis.fetch, getSince = () => '24h', signal } = {}) {
  const panel = root.querySelector('#drill-panel');
  const title = root.querySelector('#drill-title');
  const status = root.querySelector('#drill-status');
  const table = root.querySelector('#drill-table');
  const footer = root.querySelector('#drill-footer');
  const closeButton = root.querySelector('#drill-close');

  /** The row the panel shows, or null when it is closed. */
  let open = null;
  let latest = 0;
  const say = (text) => { if (status) status.textContent = text; };

  async function load() {
    if (!open) return;
    const { axis, key } = open;
    const since = getSince();
    const seq = ++latest;
    say('Loading…');
    try {
      const res = await fetchImpl(drillUrl(since, axis, key));
      if (!res.ok) throw new Error(`/api/usage → ${res.status}`);
      const data = await res.json();
      if (seq !== latest) return;
      const child = DRILL_TARGET[axis];
      // A row can age out of the window between refreshes; the server answers
      // that with an empty aggregate, which reads as "no calls", not an error.
      const drew = table ? renderTable(table, data, { label: AXIS_LABELS[child] ?? child, emptyText: 'No calls in this window.' }) : null;
      if (footer) footer.textContent = [drillFooter(axis, key, data), truncationNote(drew?.hidden)].filter(Boolean).join(' · ');
      say('');
    } catch (err) {
      if (seq !== latest) return;
      const message = String(err?.message ?? err);
      say(message.includes('403') ? 'This browser needs a web token. Add it in Settings.' : `Breakdown did not load: ${message}`);
    }
  }

  function openRow(axis, key) {
    if (!isDrillable(axis) || !panel) return Promise.resolve();
    open = { axis, key };
    const child = DRILL_TARGET[axis];
    if (title) title.textContent = `${AXIS_LABELS[axis] ?? axis} ${key} by ${(AXIS_LABELS[child] ?? child).toLowerCase()}`;
    // Clear the previous row's numbers so they never sit under the new title.
    table?.replaceChildren();
    if (footer) footer.textContent = '';
    panel.hidden = false;
    return load();
  }

  function close() {
    open = null;
    latest += 1;   // anything in flight belongs to a panel that no longer exists
    if (panel) panel.hidden = true;
    say('');
  }

  root.addEventListener('click', (event) => {
    const trigger = drillTriggerFor(event);
    if (trigger) openRow(trigger.dataset.axis, trigger.dataset.key);
  }, { signal });
  closeButton?.addEventListener('click', close, { signal });

  return { open: openRow, close, refresh: load, current: () => open };
}
