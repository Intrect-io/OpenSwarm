// Per-task progress cards folded from pipeline:stage SSE events, each with a
// live console of the agent's own output. (INT-3388, console INT-3397)
//
// Honest feedback: cards only ever show stages the daemon actually reported —
// no synthetic spinners. `seed()` replays the /api/stages snapshot so a page
// reload recovers in-flight work; console history comes from the SSE replay
// buffer alone (see main.mjs — seeding it twice duplicated every line).

import { PendingLogBuffer } from './pendingLogBuffer.mjs';

const STATUS_GLYPH = { start: '▸', complete: '✓', fail: '✗' };

// Ring buffer per card. The agent stream is chatty (one line per tool call and
// per reasoning chunk); an unbounded console would grow without limit across a
// long run.
const CONSOLE_MAX_LINES = 500;

// A console counts as "following" while the viewer is within this many pixels
// of the bottom. Scrolling up parks it — the classic terminal contract, so a
// line you are reading is never yanked away.
const FOLLOW_THRESHOLD_PX = 24;

export class WorkCards {
  #container;
  #cards = new Map(); // taskId -> { el, stages: Map<stage, lineEl>, console, lastLogStage }
  #pendingLogs = new PendingLogBuffer(); // lines awaiting their card (see module doc)

  constructor(container) {
    this.#container = container;
  }

  seed(stageEvents) {
    for (const raw of stageEvents ?? []) {
      // /api/stages returns hub-event wrappers ({type:'pipeline:stage', data})
      // while live SSE handlers receive the bare data — accept both.
      const event = raw && typeof raw.taskId === 'string'
        ? raw
        : (raw?.type === 'pipeline:stage' && raw.data && typeof raw.data.taskId === 'string' ? raw.data : null);
      if (event) this.onStage(event);
    }
  }

  onStage(data) {
    const card = this.#ensureCard(data);
    if (data.title || data.issueIdentifier) {
      card.el.querySelector('.title').textContent = data.title ?? '';
      card.el.querySelector('.identifier').textContent = data.issueIdentifier ?? '';
    }

    let line = card.stages.get(data.stage);
    if (!line) {
      line = document.createElement('div');
      line.className = 'stage-line';
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      const label = document.createElement('span');
      label.className = 'label';
      line.append(glyph, label);
      card.stagesEl.appendChild(line);
      card.stages.set(data.stage, line);
    }
    line.dataset.status = data.status;
    line.querySelector('.glyph').textContent = STATUS_GLYPH[data.status] ?? '·';
    const details = [];
    if (data.status === 'complete' && data.summary) details.push(data.summary);
    if (data.durationMs) details.push(`${Math.round(data.durationMs / 1000)}s`);
    if (typeof data.costUsd === 'number') details.push(`$${data.costUsd.toFixed(2)}`);
    line.querySelector('.label').textContent = details.length
      ? `${data.stage} — ${details.join(' · ')}`
      : data.stage;

    if (data.status === 'fail' && data.error) {
      let errorEl = card.el.querySelector('.error');
      if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.className = 'error';
        card.stagesEl.appendChild(errorEl);
      }
      errorEl.textContent = data.error;
    }
  }

  /**
   * Append one agent output line to its task's console.
   *
   * Logs for an unknown task never CREATE a card: the hub broadcasts every
   * task the daemon runs, and synthesizing cards here would fill the board
   * with work the user never deployed. They are parked in a bounded pending
   * buffer instead and flushed if that task's card materializes later — a
   * replayed line must not be lost just because its stage event lost the
   * snapshot/replay race (review finding).
   */
  onLog(data) {
    if (typeof data.taskId !== 'string' || typeof data.line !== 'string' || !data.line) return;
    const card = this.#cards.get(data.taskId);
    if (!card) {
      this.#pendingLogs.park(data.taskId, { stage: data.stage, line: data.line });
      return;
    }
    this.#appendLine(card, data);
  }

  #appendLine(card, { stage, line }) {
    const consoleEl = card.console;
    const following = this.#isFollowing(consoleEl);

    // Mark stage transitions so a long stream stays readable.
    if (stage && stage !== card.lastLogStage) {
      card.lastLogStage = stage;
      const divider = document.createElement('div');
      divider.className = 'console-stage';
      divider.textContent = `── ${stage} ──`;
      consoleEl.appendChild(divider);
    }

    const lineEl = document.createElement('div');
    lineEl.className = 'console-line';
    lineEl.textContent = line;
    consoleEl.appendChild(lineEl);

    while (consoleEl.childElementCount > CONSOLE_MAX_LINES) {
      consoleEl.removeChild(consoleEl.firstElementChild);
    }
    if (following) consoleEl.scrollTop = consoleEl.scrollHeight;
  }


  #isFollowing(consoleEl) {
    const distance = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight;
    // A console that has never been scrolled (or is shorter than its box)
    // reports 0 and follows.
    return distance <= FOLLOW_THRESHOLD_PX;
  }

  #ensureCard(data) {
    let card = this.#cards.get(data.taskId);
    if (card) return card;

    // First card replaces the placeholder.
    if (this.#cards.size === 0) this.#container.replaceChildren();

    const el = document.createElement('div');
    el.className = 'work-card';

    const head = document.createElement('div');
    head.className = 'head';
    const identifier = document.createElement('span');
    identifier.className = 'identifier';
    identifier.textContent = data.issueIdentifier ?? '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = data.title ?? data.taskId;
    const toggle = document.createElement('button');
    toggle.className = 'console-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Hide output';
    toggle.setAttribute('aria-expanded', 'true');
    head.append(identifier, title, toggle);
    el.appendChild(head);

    const stagesEl = document.createElement('div');
    stagesEl.className = 'stages';
    el.appendChild(stagesEl);

    const consoleEl = document.createElement('div');
    consoleEl.className = 'console';
    consoleEl.setAttribute('role', 'log');
    consoleEl.setAttribute('aria-label', `Agent output for ${data.issueIdentifier ?? data.taskId}`);
    el.appendChild(consoleEl);

    toggle.addEventListener('click', () => {
      const hidden = el.classList.toggle('console-hidden');
      toggle.textContent = hidden ? 'Show output' : 'Hide output';
      toggle.setAttribute('aria-expanded', String(!hidden));
      // Reopening lands at the newest output, not wherever it was parked.
      if (!hidden) consoleEl.scrollTop = consoleEl.scrollHeight;
    });

    this.#container.prepend(el);

    card = { el, stagesEl, console: consoleEl, stages: new Map(), lastLogStage: null };
    this.#cards.set(data.taskId, card);

    // Flush lines that arrived before the card existed (moved, not copied —
    // no duplication with the live stream).
    for (const entry of this.#pendingLogs.takeFor(data.taskId)) {
      this.#appendLine(card, entry);
    }
    return card;
  }
}
