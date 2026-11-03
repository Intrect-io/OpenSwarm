// OpenSwarm ADE workspace — I/O and rendering. Decisions live in model.js.
//
// All daemon reads go through the shell (`ade_get`, allowlisted read-only
// paths) and live events arrive as `ade-event`; this page never fetches the
// network itself. Rendering uses textContent only, never innerHTML: log lines
// and diffs are repository- and agent-controlled text.

import * as model from './model.js';
import { availableActions, performAction } from './actions.js';

const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  selected: null,
  log: [],
  refreshTimer: null,
  detailTimer: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(container, message) {
  container.replaceChildren(el('p', 'error', message));
}

async function read(path, query) {
  return invoke('ade_get', { path, query: query ?? null });
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function refreshSessions() {
  const list = $('session-list');
  try {
    const response = await read('/api/work/sessions', { limit: '50' });
    state.rows = model.sessionRows(response);
  } catch (error) {
    showError(list, `Could not load runs: ${error}`);
    return;
  }
  renderSessions();
  if (!state.selected && state.rows.length) select(state.rows[0].taskId);
}

function renderSessions() {
  const list = $('session-list');
  const now = Date.now();
  list.replaceChildren(...state.rows.map((row) => {
    const item = el('li', 'session');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(row.taskId === state.selected));
    item.dataset.taskId = row.taskId;
    const title = el('span', 'title');
    const dot = el('span', 'dot');
    dot.dataset.status = row.status;
    title.append(dot, document.createTextNode(row.issue ? `${row.issue} · ${row.title}` : row.title));
    const sub = el('span', 'sub');
    sub.append(
      el('span', '', row.status === 'running' && row.stage ? row.stage : row.finalStatus || row.status),
      el('span', '', row.project),
      el('span', '', model.formatAge(row.at, now)),
    );
    item.append(title, sub);
    item.addEventListener('click', () => select(row.taskId));
    return item;
  }));
  $('session-count').textContent = state.rows.length ? String(state.rows.length) : '';
  $('session-empty').hidden = state.rows.length > 0;
}

// ── Selected run: log, run status, diff, verification ─────────────────────

async function select(taskId) {
  state.selected = taskId;
  state.log = [];
  $('action-message').hidden = true;
  renderSessions();
  const row = state.rows.find((r) => r.taskId === taskId);
  $('crumb').textContent = row ? (row.issue || row.title) : taskId;
  $('log-title').textContent = row ? row.title : 'Log';
  $('log-body').replaceChildren();
  await Promise.all([loadLog(taskId), loadDetails(taskId)]);
}

async function loadLog(taskId) {
  try {
    const snapshot = await read(`/api/work/sessions/${taskId}/log`);
    if (state.selected !== taskId) return;
    state.log = model.mergeLog(state.log, model.snapshotLines(snapshot));
    $('log-meta').textContent = snapshot.truncated ? 'older lines dropped' : '';
  } catch (error) {
    if (state.selected !== taskId) return;
    $('log-meta').textContent = String(error).includes('404') ? 'transcript expired' : '';
  }
  renderLog();
}

function renderLog() {
  const body = $('log-body');
  const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.replaceChildren(...state.log.map(lineNode));
  $('log-empty').hidden = state.log.length > 0;
  $('log-empty').textContent = state.selected ? 'No transcript lines yet.' : 'Select a run to follow its transcript.';
  if (pinned) body.scrollTop = body.scrollHeight;
  renderVerification();
}

function lineNode(line) {
  const node = el('div', 'log-line');
  if (/\b(?:fail|error)\b/i.test(line.line)) node.classList.add('fail');
  node.append(el('span', 'stage', line.stage), el('span', 'text', line.line));
  return node;
}

function renderVerification() {
  const lines = model.verificationLines(state.log);
  $('verify-lines').replaceChildren(...lines.map((l) => el('li', l.kind, l.text)));
  $('verify-empty').hidden = lines.length > 0;
}

async function loadDetails(taskId) {
  await Promise.all([loadRun(taskId), loadDiff(taskId)]);
}

async function loadRun(taskId) {
  const card = $('run-card');
  let run = null;
  try {
    run = await read(`/api/automation/runs/${taskId}`);
  } catch {
    run = null;
  }
  if (state.selected !== taskId) return;
  const summary = model.summarizeRun(run);
  card.hidden = false;
  $('run-state').textContent = summary.state;
  $('run-state').dataset.tone = summary.tone;
  $('run-attempt').textContent = summary.attempt ? `attempt ${summary.attempt}` : '';
  $('run-detail').textContent = summary.detail;
  renderActions(taskId, run);
}

function renderActions(taskId, run) {
  const row = state.rows.find((r) => r.taskId === taskId);
  const bar = $('run-actions');
  bar.replaceChildren(...availableActions(row, run).map((action) => {
    const button = el('button', '', action.label);
    button.type = 'button';
    button.dataset.action = action.id;
    button.addEventListener('click', async () => {
      for (const b of bar.querySelectorAll('button')) b.disabled = true;
      const result = await performAction(invoke, action, row);
      const message = $('action-message');
      message.hidden = !result.message;
      message.dataset.kind = result.kind;
      message.textContent = result.message;
      for (const b of bar.querySelectorAll('button')) b.disabled = false;
      if (result.kind === 'done' && action.id !== 'openPr') {
        scheduleSessions();
        scheduleDetails();
      }
    });
    return button;
  }));
}

async function loadDiff(taskId) {
  const body = $('diff-body');
  let response;
  try {
    response = await read('/api/work/diff', { taskId, maxBytes: '131072' });
  } catch (error) {
    if (state.selected !== taskId) return;
    const message = String(error);
    body.replaceChildren();
    $('diff-meta').textContent = '';
    $('diff-empty').hidden = false;
    $('diff-empty').textContent = message.includes('404') ? 'No worktree for this run (finished or not started).' : `Could not load the diff: ${message}`;
    return;
  }
  if (state.selected !== taskId) return;
  const files = model.parseUnifiedDiff(response.diff);
  $('diff-meta').textContent = [response.branch, response.truncated ? 'truncated' : ''].filter(Boolean).join(' · ');
  body.replaceChildren(...files.map((file) => {
    const details = el('details', 'diff-file');
    details.open = files.length <= 4;
    const summary = el('summary');
    summary.append(el('span', 'path', file.path), el('span', 'adds', `+${file.additions}`), el('span', 'dels', `−${file.deletions}`));
    const pre = el('div', 'diff-lines');
    pre.append(...file.lines.map((line) => el('div', line.kind, line.text)));
    details.append(summary, pre);
    return details;
  }));
  $('diff-empty').hidden = files.length > 0;
  $('diff-empty').textContent = 'No working-tree changes for this run.';
}

// ── Live updates ───────────────────────────────────────────────────────────

function scheduleSessions() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshSessions, 500);
}

function scheduleDetails() {
  clearTimeout(state.detailTimer);
  const taskId = state.selected;
  if (taskId) state.detailTimer = setTimeout(() => loadDetails(taskId), 1500);
}

async function startEvents() {
  await tauri.event.listen('ade-event', ({ payload }) => {
    const line = state.selected ? model.logLineFromEvent(payload, state.selected) : null;
    if (line) {
      state.log = model.mergeLog(state.log, [line]);
      renderLog();
    }
    if (model.eventChangesSessions(payload)) {
      scheduleSessions();
      if (payload.data?.taskId === state.selected) scheduleDetails();
    }
  });
  await tauri.event.listen('ade-events-status', ({ payload }) => {
    const status = $('stream-status');
    status.dataset.state = payload.connected ? 'live' : 'down';
    status.textContent = payload.connected ? 'Live' : `Reconnecting… ${payload.detail ?? ''}`.trim();
    if (payload.connected) {
      refreshSessions();
      if (state.selected) loadLog(state.selected);
    }
  });
  await invoke('ade_subscribe_events');
}

refreshSessions();
startEvents().catch((error) => {
  $('stream-status').dataset.state = 'down';
  $('stream-status').textContent = `Live updates unavailable: ${error}`;
});
// The event stream is the primary signal; this catches a missed event.
setInterval(refreshSessions, 15_000);
setInterval(() => { if (state.selected) loadDetails(state.selected); }, 20_000);
