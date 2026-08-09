// Renders a session's transcript entries. (INT-3402)
//
// Scroll contract (vega INT-1411): follow the tail only while the viewer is
// already near the bottom, and never `scroll-behavior: smooth` — smooth
// scrolling fires intermediate scroll events that make "am I at the bottom?"
// unanswerable, so the view would keep yanking a reader back down.

import { summarizeToolGroup } from './transcriptModel.mjs';

const FOLLOW_THRESHOLD_PX = 80;

export class TranscriptView {
  #el;
  #model;
  #taskId = null;

  constructor(el, { model }) {
    this.#el = el;
    this.#model = model;
    model.addEventListener('append', (event) => {
      if (event.detail.taskId === this.#taskId) this.render();
    });
    model.addEventListener('replace', (event) => {
      if (event.detail.taskId === this.#taskId) this.render({ toBottom: true });
    });
  }

  get taskId() {
    return this.#taskId;
  }

  /** The scroll container, so a host panel can mount it in its own layout. */
  get element() {
    return this.#el;
  }

  show(taskId) {
    this.#taskId = taskId;
    this.render({ toBottom: true });
  }

  clear() {
    this.#taskId = null;
    this.#el.replaceChildren();
  }

  render({ toBottom = false } = {}) {
    if (!this.#taskId) return;
    const following = toBottom || this.#isFollowing();
    const entries = this.#model.entries(this.#taskId);

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No output captured for this session yet.';
      this.#el.replaceChildren(empty);
      return;
    }

    // Full re-render: bounded at the model's ring size, and it keeps the DOM
    // an exact projection of the model (no incremental drift to debug). Groups
    // the reader expanded must survive it — collapsing them on every incoming
    // line would make an open group unreadable during live output.
    const openGroups = new Set();
    this.#el.querySelectorAll('details.activity-row[open]').forEach((el) => {
      if (el.dataset.groupKey) openGroups.add(el.dataset.groupKey);
    });

    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => fragment.appendChild(this.#renderEntry(entry, index, openGroups)));
    this.#el.replaceChildren(fragment);

    if (following) this.#el.scrollTop = this.#el.scrollHeight;
  }

  #renderEntry(entry, index, openGroups) {
    if (entry.kind === 'stage') {
      const el = document.createElement('div');
      el.className = 'transcript-stage';
      el.textContent = `── ${entry.stage} ──`;
      return el;
    }
    if (entry.kind === 'tools') {
      const details = document.createElement('details');
      details.className = 'activity-row';
      // Index is a stable key while entries only append/evict from the front;
      // an evicted head shifts keys, which at worst re-collapses a group.
      details.dataset.groupKey = String(index);
      if (openGroups?.has(String(index))) details.open = true;
      const summary = document.createElement('summary');
      // Vocabulary lives with the model so labels have one owner.
      summary.textContent = summarizeToolGroup(entry.lines);
      details.appendChild(summary);
      for (const line of entry.lines) {
        const child = document.createElement('div');
        child.className = 'activity-line';
        child.textContent = line;
        details.appendChild(child);
      }
      return details;
    }
    const el = document.createElement('div');
    el.className = `transcript-line ${entry.type}`;
    el.textContent = entry.text;
    return el;
  }

  #isFollowing() {
    const distance = this.#el.scrollHeight - this.#el.scrollTop - this.#el.clientHeight;
    return distance <= FOLLOW_THRESHOLD_PX;
  }
}
