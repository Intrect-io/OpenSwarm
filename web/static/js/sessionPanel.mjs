// The selected session: header, status line, and live transcript. (INT-3402)
//
// Transcript history is seeded lazily, on selection, from
// GET /api/work/sessions/:taskId/log — the daemon's per-task ring holds far
// more than the SSE replay's global 50 lines. The snapshot and the live
// stream are merged on the daemon's per-line sequence, so history is complete
// and no line renders twice.

import { formatCost, formatDuration, formatRelativeTime, shortenPath, formatTokens } from './format.mjs';

const PHASE_LABEL = {
  queued: 'Queued',
  running: 'Working',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  decomposed: 'Decomposed',
};

export class SessionPanel {
  #root;
  #store;
  #transcripts;
  #view;
  #diff;
  #fetchLog;
  #taskId = null;
  #tab = 'transcript';
  #seeded = new Set();

  constructor(root, { store, transcripts, transcriptView, diffPanel, fetchLog }) {
    this.#root = root;
    this.#store = store;
    this.#transcripts = transcripts;
    this.#view = transcriptView;
    this.#diff = diffPanel;
    this.#fetchLog = fetchLog;
    store.addEventListener('change', (event) => {
      if (event.detail.session.taskId === this.#taskId) this.#renderHeader();
    });
  }

  get taskId() {
    return this.#taskId;
  }

  async show(taskId) {
    this.#taskId = taskId;
    this.#mount();
    this.#renderHeader();
    this.#view.show(taskId);
    this.#diff?.clear();
    // Selecting a session always lands on its output; the diff is one click
    // away and fetched only when asked for.
    this.#setTab('transcript');
    await this.#seedTranscript(taskId);
  }

  showEmpty(message) {
    this.#taskId = null;
    this.#view.clear();
    this.#diff?.clear();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = message;
    this.#root.replaceChildren(empty);
  }

  async #seedTranscript(taskId) {
    // Once per session per page: re-seeding would re-do the merge below for no
    // gain (and briefly re-render history the user is already reading).
    if (this.#seeded.has(taskId)) return;
    this.#seeded.add(taskId);
    try {
      const snapshot = await this.#fetchLog(taskId);
      const snapshotLines = snapshot?.lines ?? [];
      if (!snapshotLines.length) return;

      // Lines can stream in WHILE the request is in flight. Replacing outright
      // would drop exactly those. Both sides carry the daemon's own monotonic
      // sequence (broadcastEvent stamps the ring and the SSE copy together),
      // so keep live lines after the snapshot's last one — no loss, no
      // duplicate. Sequence, not timestamp: an agent emits several lines per
      // millisecond, and a ts comparison silently drops the ties.
      const lastSeq = snapshotLines.at(-1)?.seq;
      const live = this.#transcripts.rawLines(taskId);
      const tail = typeof lastSeq === 'number'
        ? live.filter((entry) => typeof entry.seq === 'number' && entry.seq > lastSeq)
        // No sequence (daemon predates the stamp): keeping live lines could
        // duplicate the overlap, so the snapshot alone is the honest answer.
        : [];
      this.#transcripts.replace(taskId, [...snapshotLines, ...tail]);
    } catch {
      // Older daemon or expired retention — live lines are all we get.
    }
  }

  #mount() {
    if (this.#root.querySelector('.session-header')) return;
    const header = document.createElement('div');
    header.className = 'session-header';
    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const tabs = document.createElement('div');
    tabs.className = 'session-tabs';
    for (const [tab, label] of [['transcript', 'Transcript'], ['diff', 'Diff']]) {
      if (tab === 'diff' && !this.#diff) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-tab';
      button.dataset.tab = tab;
      button.textContent = label;
      button.addEventListener('click', () => this.#setTab(tab));
      tabs.appendChild(button);
    }

    const children = [header, meta, tabs, this.#view.element];
    if (this.#diff) children.push(this.#diff.element);
    this.#root.replaceChildren(...children);
  }

  #setTab(tab) {
    this.#tab = tab;
    for (const button of this.#root.querySelectorAll('.session-tab')) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    this.#view.element.hidden = tab !== 'transcript';
    if (!this.#diff) return;
    this.#diff.element.hidden = tab !== 'diff';
    // Fetch on demand: a diff is a git call per view, not something to poll.
    if (tab === 'diff' && this.#taskId) void this.#diff.load(this.#taskId);
  }

  #renderHeader() {
    const session = this.#store.get(this.#taskId);
    if (!session) return;
    const header = this.#root.querySelector('.session-header');
    const meta = this.#root.querySelector('.session-meta');
    if (!header || !meta) return;

    header.replaceChildren();
    const identifier = document.createElement('span');
    identifier.className = 'identifier';
    identifier.textContent = session.issueIdentifier ?? '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = session.title || session.taskId;
    const phase = document.createElement('span');
    phase.className = 'phase';
    phase.dataset.phase = session.phase;
    phase.textContent = session.currentStage && session.phase === 'running'
      ? `${PHASE_LABEL[session.phase]} — ${session.currentStage}`
      : PHASE_LABEL[session.phase] ?? session.phase;
    header.append(identifier, title, phase);

    // Right-hand usage strip, vega's usage-meta in one line. Only facts the
    // daemon actually reported appear.
    const bits = [
      session.model,
      session.branch,
      session.worktreePath ? shortenPath(session.worktreePath) : '',
      session.inputTokens ? `${formatTokens(session.inputTokens)} in` : '',
      formatCost(session.costUsd),
      formatDuration(session.durationMs),
      session.completedAt ? formatRelativeTime(session.completedAt) : '',
      session.failureCause ? `cause: ${session.failureCause}` : '',
      session.error ?? '',
    ].filter(Boolean);
    meta.textContent = bits.join(' · ');
  }
}
