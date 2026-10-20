// Sidebar list of sessions, grouped by repository. (INT-3402)
//
// Mirrors Orca's project > session tree. Renders only what the store actually
// knows — no placeholder rows for work the daemon never reported.

import { formatRelativeTime, truncate } from './format.mjs';
import { ICONS } from './icons.mjs';

const PHASE_ICON = {
  queued: 'dot',
  running: 'play',
  completed: 'check',
  failed: 'cross',
  cancelled: 'cancel',
  decomposed: 'fork',
};

export class SessionTree {
  #el;
  #store;
  #onSelect;
  #selectedId = null;

  constructor(el, { store, onSelect }) {
    this.#el = el;
    this.#store = store;
    this.#onSelect = onSelect;
    store.addEventListener('change', () => this.render());
  }

  select(taskId) {
    this.#selectedId = taskId;
    this.render();
  }

  render(nowMs = Date.now()) {
    const sessions = this.#store.list();
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'No sessions yet.';
      this.#el.replaceChildren(empty);
      return;
    }

    const byProject = new Map();
    for (const session of sessions) {
      const key = session.projectPath || 'unknown';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(session);
    }

    const fragment = document.createDocumentFragment();
    for (const [projectPath, group] of byProject) {
      const head = document.createElement('div');
      head.className = 'tree-project';
      head.textContent = projectPath === 'unknown'
        ? 'No repository recorded'
        : projectPath.split('/').filter(Boolean).pop() ?? projectPath;
      head.title = projectPath === 'unknown' ? 'The daemon did not report a repository for these runs' : projectPath;

      const runningCount = group.filter((s) => s.phase === 'running').length;
      if (runningCount) {
        const badge = document.createElement('span');
        badge.className = 'tree-badge';
        badge.textContent = String(runningCount);
        badge.title = `${runningCount} running`;
        head.appendChild(badge);
      }
      fragment.appendChild(head);

      for (const session of group) fragment.appendChild(this.#renderRow(session, nowMs));
    }
    this.#el.replaceChildren(fragment);
  }

  #renderRow(session, nowMs) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tree-session';
    row.dataset.phase = session.phase;
    row.dataset.taskId = session.taskId;
    if (session.taskId === this.#selectedId) row.classList.add('selected');

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.innerHTML = ICONS[PHASE_ICON[session.phase] ?? 'dot'];
    glyph.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = session.issueIdentifier || truncate(session.title || session.taskId, 18);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatRelativeTime(session.completedAt ?? session.startedAt ?? session.updatedAt, nowMs);

    row.append(glyph, label, time);
    row.setAttribute('aria-label', `${label.textContent}, ${session.phase}, ${time.textContent}`);
    row.title = `${session.issueIdentifier ? `${session.issueIdentifier} — ` : ''}${session.title ?? ''}`;
    row.addEventListener('click', () => this.#onSelect(session.taskId));
    return row;
  }
}
