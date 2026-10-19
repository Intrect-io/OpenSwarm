// Status marks as inline SVG (redesign step 10). The board's craft floor bans
// unicode glyphs and emoji as icons: they render in whatever fallback font the
// OS picks, at a different weight and baseline on every machine. One set of
// 12px strokes keeps every status mark in the same hand.

const svg = (body) => `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  check: svg('<path d="M2.5 6.2 5 8.6l4.5-5"/>'),
  cross: svg('<path d="M3 3l6 6M9 3 3 9"/>'),
  play: svg('<path d="M4 2.5v7L9 6z" fill="currentColor" stroke="none"/>'),
  dot: svg('<circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none"/>'),
  cancel: svg('<circle cx="6" cy="6" r="4"/><path d="M3.2 8.8l5.6-5.6"/>'),
  fork: svg('<circle cx="6" cy="2.5" r="1"/><circle cx="3" cy="9.5" r="1"/><circle cx="9" cy="9.5" r="1"/><path d="M6 3.5v2.5M6 6 3.5 8.6M6 6l2.5 2.6"/>'),
};

/** A detached element holding `name`'s icon, for DOM-building callers. */
export function iconElement(doc, name, className = 'glyph') {
  const span = doc.createElement('span');
  span.className = className;
  span.innerHTML = ICONS[name] ?? ICONS.dot;
  return span;
}
