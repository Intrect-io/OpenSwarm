// Issue list with multi-select → deploy. (INT-3388)
//
// WorkspaceShell-style class: DOM refs and fetch are injected so a jsdom test
// can drive it without a server; a renderSequence guard drops answers that
// arrive after the user has already switched repos.

export class IssueBoard {
  #listEl;
  #countEl;
  #summaryEl;
  #deployBtn;
  #fetchIssues;
  #dispatch;
  #onDeployed;
  #issues = [];
  #selected = new Set();
  #projectPath = '';
  #renderSequence = 0;
  #armed = false;
  #armTimer = null;

  constructor({ listEl, countEl, summaryEl, deployBtn, fetchIssues, dispatch, onDeployed }) {
    this.#listEl = listEl;
    this.#countEl = countEl;
    this.#summaryEl = summaryEl;
    this.#deployBtn = deployBtn;
    this.#fetchIssues = fetchIssues;
    this.#dispatch = dispatch;
    this.#onDeployed = onDeployed;

    this.#deployBtn.addEventListener('click', () => this.#deploy());
  }

  async loadFor(projectPath) {
    this.#projectPath = projectPath;
    this.#selected.clear();
    const seq = ++this.#renderSequence;
    this.#renderMessage('Loading issues…');
    let payload;
    try {
      payload = await this.#fetchIssues(projectPath);
    } catch (err) {
      if (seq !== this.#renderSequence) return;
      this.#renderMessage(err?.message ?? 'Failed to load issues');
      return;
    }
    if (seq !== this.#renderSequence) return;
    this.#issues = payload.issues ?? [];
    this.#render();
  }

  get selectedIds() {
    return [...this.#selected];
  }

  #render() {
    this.#countEl.textContent = this.#issues.length ? `${this.#issues.length} open` : '';
    if (!this.#issues.length) {
      this.#renderMessage('No dispatchable issues in this project.');
      this.#syncFooter();
      return;
    }
    const rows = this.#issues.map((issue) => this.#renderRow(issue));
    this.#listEl.replaceChildren(...rows);
    this.#syncFooter();
  }

  #renderRow(issue) {
    const row = document.createElement('label');
    row.className = 'issue-row';
    row.dataset.issueId = issue.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.#selected.add(issue.id);
      else this.#selected.delete(issue.id);
      row.classList.toggle('selected', checkbox.checked);
      this.#syncFooter();
    });

    const prio = document.createElement('span');
    prio.className = 'prio';
    prio.dataset.p = String(issue.priority || 0);
    prio.textContent = issue.priority ? `P${issue.priority}` : '—';

    const identifier = document.createElement('span');
    identifier.className = 'identifier';
    identifier.textContent = issue.identifier;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = issue.title;
    title.title = issue.title;

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = issue.state;

    row.append(checkbox, prio, identifier, title, state);
    return row;
  }

  #renderMessage(text) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = text;
    this.#listEl.replaceChildren(div);
  }

  #syncFooter() {
    this.#disarm();
    const n = this.#selected.size;
    this.#status(`${n} selected`);
    this.#deployBtn.disabled = n === 0;
    this.#deployBtn.textContent = n > 0 ? `Deploy ${n} agent${n > 1 ? 's' : ''}` : 'Deploy agents';
  }

  #status(text, isError = false) {
    this.#summaryEl.textContent = text;
    this.#summaryEl.classList.toggle('error', isError);
  }

  #disarm() {
    if (this.#armTimer) {
      clearTimeout(this.#armTimer);
      this.#armTimer = null;
    }
    this.#armed = false;
    this.#deployBtn.classList.remove('arm');
  }

  async #deploy() {
    const ids = this.selectedIds;
    if (!ids.length || !this.#projectPath) return;

    // Consent is an in-page two-step arm, NOT window.confirm: the Tauri shell's
    // WKWebView implements no JS dialogs, so confirm()/alert() return falsy
    // without showing anything — the deploy click was silently swallowed there.
    if (!this.#armed) {
      const identifiers = this.#issues
        .filter((issue) => this.#selected.has(issue.id))
        .map((issue) => issue.identifier);
      this.#armed = true;
      this.#deployBtn.classList.add('arm');
      this.#deployBtn.textContent = `Confirm: deploy ${ids.length}?`;
      this.#status(`${identifiers.join(', ')} → ${this.#projectPath} — click again to confirm.`);
      this.#armTimer = setTimeout(() => this.#syncFooter(), 6000);
      return;
    }

    this.#disarm();
    this.#deployBtn.disabled = true;
    this.#deployBtn.textContent = 'Deploying…';
    try {
      const result = await this.#dispatch(this.#projectPath, ids);
      this.#onDeployed?.(result);
      await this.loadFor(this.#projectPath);
      // After loadFor's re-render resets the footer, surface the outcome.
      this.#status(`Queued ${result?.queued ?? 0}, skipped ${result?.skipped ?? 0}.`);
    } catch (err) {
      this.#syncFooter();
      this.#status(err?.message ?? 'Dispatch failed', true);
    }
  }
}
