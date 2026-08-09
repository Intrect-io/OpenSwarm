// Hash-based view routing for the cockpit. (INT-3402)
//
// No router library and no history rewriting: the hash IS the state, so a
// reload or a deep link lands on the same view (and, for a session, the same
// tab). Views live side by side in the DOM and are switched with a single
// `data-view` attribute on <body>, which keeps CSS in charge of visibility.

export const VIEWS = ['sessions', 'issues'];
const DEFAULT_VIEW = 'issues';

/** '#/sessions/abc' → { view: 'sessions', taskId: 'abc' }. Unknown → default. */
export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  const [view, ...rest] = raw.split('/').filter(Boolean);
  if (!VIEWS.includes(view)) return { view: DEFAULT_VIEW, taskId: null };
  let taskId = null;
  if (rest.length) {
    const encoded = rest.join('/');
    // A hand-edited or truncated URL can carry a malformed escape ('%', '%zz').
    // decodeURIComponent throws on those, and this runs inside the bootstrap —
    // an unguarded throw would leave the page with no view rendered at all.
    try {
      taskId = decodeURIComponent(encoded);
    } catch {
      taskId = encoded;
    }
  }
  return { view, taskId: view === 'sessions' ? taskId : null };
}

export function buildHash(view, taskId) {
  if (view === 'sessions' && taskId) return `#/sessions/${encodeURIComponent(taskId)}`;
  return `#/${VIEWS.includes(view) ? view : DEFAULT_VIEW}`;
}

export class Nav extends EventTarget {
  #root;
  #buttons;
  /** Last hash actually rendered — dedupes the hashchange that follows show(). */
  #applied = null;

  constructor({ root = document.body, buttons = [] } = {}) {
    super();
    this.#root = root;
    this.#buttons = buttons;
    for (const button of buttons) {
      button.addEventListener('click', () => this.show(button.dataset.view));
    }
    window.addEventListener('hashchange', () => this.#applyFromHash());
  }

  get current() {
    return parseHash(window.location.hash);
  }

  /**
   * Navigate and render NOW. Writing the hash alone would defer the render to
   * the hashchange task, so callers could not rely on the view being current
   * on the next line; the dedupe below makes the trailing event a no-op.
   */
  show(view, taskId = null) {
    window.location.hash = buildHash(view, taskId);
    this.#applyFromHash({ force: true });
  }

  /** Render whatever the current hash says — call once at startup. */
  start() {
    this.#applyFromHash({ force: true });
  }

  #applyFromHash({ force = false } = {}) {
    const hash = window.location.hash;
    if (!force && hash === this.#applied) return;
    this.#applied = hash;
    const { view, taskId } = this.current;
    this.#root.dataset.view = view;
    for (const button of this.#buttons) {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { view, taskId } }));
  }
}
