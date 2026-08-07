// Per-task progress cards folded from pipeline:stage SSE events. (INT-3388)
//
// Honest feedback: cards only ever show stages the daemon actually reported —
// no synthetic spinners. `seed()` replays the /api/stages snapshot so a page
// reload recovers in-flight work.

const STATUS_GLYPH = { start: '▸', complete: '✓', fail: '✗' };

export class WorkCards {
  #container;
  #cards = new Map(); // taskId -> { el, stages: Map<stage, lineEl> }

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
      card.el.appendChild(line);
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
        card.el.appendChild(errorEl);
      }
      errorEl.textContent = data.error;
    }
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
    head.append(identifier, title);
    el.appendChild(head);
    this.#container.prepend(el);

    card = { el, stages: new Map() };
    this.#cards.set(data.taskId, card);
    return card;
  }
}
