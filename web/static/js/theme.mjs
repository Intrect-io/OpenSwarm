// Theme state: resolve, apply, persist, toggle. (AGT-4201, §1.1/§6.4)
//
// themeBoot.js already stamped `data-theme` on <html> before first paint;
// this module owns everything after that — the toggle button, following the
// OS while no explicit choice is stored, and remembering the choice.

export const THEME_KEY = 'openswarm.theme';
export const THEMES = ['dark', 'light'];

/** Explicit stored choice wins; otherwise the OS preference; otherwise dark. */
export function resolveTheme({ stored, prefersLight }) {
  if (THEMES.includes(stored)) return stored;
  return prefersLight ? 'light' : 'dark';
}

export function applyTheme(doc, theme) {
  doc.documentElement.setAttribute('data-theme', theme);
}

function readStored(storage) {
  try { return storage?.getItem(THEME_KEY) ?? null; } catch { return null; }
}

function writeStored(storage, theme) {
  try { storage?.setItem(THEME_KEY, theme); } catch { /* storage blocked — the choice lives for this page only */ }
}

/**
 * Wire a toggle button. The button carries `aria-pressed` = "light mode is
 * on" and a spoken label that names the mode it will switch TO, so a screen
 * reader hears an action, not a state.
 */
export function installThemeToggle(doc, button, {
  storage = doc.defaultView?.localStorage,
  matchMedia = doc.defaultView?.matchMedia?.bind(doc.defaultView),
} = {}) {
  const query = matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;

  const current = () => doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  const paint = () => {
    const theme = current();
    if (!button) return;
    button.setAttribute('aria-pressed', String(theme === 'light'));
    button.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    button.title = button.getAttribute('aria-label');
  };

  const set = (theme) => {
    applyTheme(doc, theme);
    paint();
  };

  // Settle the initial state from the same rule the boot script used, so a
  // page that loaded without themeBoot.js (tests, embedded hosts) still lands
  // on the right theme.
  set(resolveTheme({ stored: readStored(storage), prefersLight: !!query?.matches }));

  button?.addEventListener('click', () => {
    const next = current() === 'light' ? 'dark' : 'light';
    writeStored(storage, next);
    set(next);
  });

  // Follow the OS only while the operator has not chosen explicitly.
  const onSystemChange = (event) => {
    if (THEMES.includes(readStored(storage))) return;
    set(event.matches ? 'light' : 'dark');
  };
  query?.addEventListener?.('change', onSystemChange);

  return {
    get theme() { return current(); },
    set,
    stop() { query?.removeEventListener?.('change', onSystemChange); },
  };
}
