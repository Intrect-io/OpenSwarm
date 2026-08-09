// Sidebar list of sessions, grouped by repository. (INT-3402)
//
// Mirrors Orca's project > session tree. Renders only what the store actually
// knows — no placeholder rows for work the daemon never reported.

import { formatRelativeTime, truncate } from './format.mjs';

const PHASE_GLYPH = {
  queued: '·',
  running: '▸',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
  decomposed: '⑂',
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
      head.textContent = projectPath.split('/').filter(Boolean).pop() ?? projectPath;
      head.title = projectPath;

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
    glyph.textContent = PHASE_GLYPH[session.phase] ?? '·';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = session.issueIdentifier || truncate(session.title || session.taskId, 18);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatRelativeTime(session.completedAt ?? session.startedAt ?? session.updatedAt, nowMs);

    row.append(glyph, label, time);
    row.title = `${session.issueIdentifier ? `${session.issueIdentifier} — ` : ''}${session.title ?? ''}`;
    row.addEventListener('click', () => this.#onSelect(session.taskId));
    return row;
  }
}
