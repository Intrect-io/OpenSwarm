// Worktree diff for the selected session. (INT-3402)
//
// Renders GET /api/work/diff — the changes an agent has made in its isolated
// worktree. A minimal unified-diff parser lives here rather than a vendored
// highlighter: the shape is small and stable, and the page ships no bundler.

/** Split a unified diff into rows the renderer can style. Pure. */
export function parseUnifiedDiff(text) {
  const rows = [];
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('index ')) {
      rows.push({ type: 'file', text: line });
    } else if (line.startsWith('@@')) {
      rows.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ type: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line });
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line });
    } else {
      rows.push({ type: 'context', text: line });
    }
  }
  // A trailing newline yields one empty context row — drop it.
  if (rows.length && rows.at(-1).text === '') rows.pop();
  return rows;
}

/** "3 files · +42 −7" from the API's per-file counts. Pure. */
export function summarizeFiles(files) {
  if (!files?.length) return 'No file changes';
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return `${files.length} file${files.length > 1 ? 's' : ''} · +${added} −${deleted}`;
}

export class DiffPanel {
  #el;
  #fetchDiff;
  #taskId = null;
  /**
   * Only the newest request may paint. A taskId comparison is not enough —
   * re-opening the SAME session starts a second request with the same id, and
   * a stale failure resolving late would overwrite the newer render.
   */
  #requestId = 0;

  constructor(el, { fetchDiff }) {
    this.#el = el;
    this.#fetchDiff = fetchDiff;
  }

  get element() {
    return this.#el;
  }

  async load(taskId) {
    this.#taskId = taskId;
    const requestId = ++this.#requestId;
    this.#message('Loading diff…');
    let payload;
    try {
      payload = await this.#fetchDiff(taskId);
    } catch (err) {
      // 409 = the worktree exists but git could not read it; anything else is
      // reported verbatim rather than shown as "no changes".
      if (requestId === this.#requestId) {
        this.#message(err?.message ?? 'Could not read the worktree diff.');
      }
      return;
    }
    if (requestId !== this.#requestId) return; // superseded mid-flight
    if (!payload) {
      this.#message('This daemon does not expose worktree diffs.');
      return;
    }
    this.#render(payload);
  }

  clear() {
    this.#taskId = null;
    // Nothing in flight may paint over a cleared panel either.
    this.#requestId++;
    this.#el.replaceChildren();
  }

  #message(text) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = text;
    this.#el.replaceChildren(el);
  }

  #render(payload) {
    const fragment = document.createDocumentFragment();

    const summary = document.createElement('div');
    summary.className = 'diff-summary';
    summary.textContent = summarizeFiles(payload.files);
    if (payload.branch) summary.textContent += ` · ${payload.branch}`;
    if (payload.truncated) summary.textContent += ' · truncated';
    fragment.appendChild(summary);

    for (const file of payload.files ?? []) {
      const row = document.createElement('div');
      row.className = 'diff-file';
      row.textContent = `${file.isNew ? 'new ' : ''}${file.file}  +${file.added ?? 0} −${file.deleted ?? 0}`;
      fragment.appendChild(row);
    }

    if (!payload.diff) {
      // Files with no patch text is a real state (binary, or committed already).
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = payload.files?.length
        ? 'No patch text for these changes.'
        : 'Working tree is clean.';
      fragment.appendChild(note);
      this.#el.replaceChildren(fragment);
      return;
    }

    const pre = document.createElement('div');
    pre.className = 'diff-body';
    for (const row of parseUnifiedDiff(payload.diff)) {
      const line = document.createElement('div');
      line.className = `diff-line ${row.type}`;
      line.textContent = row.text;
      pre.appendChild(line);
    }
    fragment.appendChild(pre);
    this.#el.replaceChildren(fragment);
  }
}
