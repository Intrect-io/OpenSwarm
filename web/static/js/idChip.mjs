// A long machine identifier (issue UUID, correlation id, hash) shown short,
// with the full value one press away. Redesign step 7: raw UUIDs in headings
// and meta lines were the loudest noise on the page, but an operator still
// needs the whole value to grep a log or paste into a tracker.

const LONG_ID = /^[0-9a-f-]{13,}$/i;

/** "bb4c009a…" for a long hex/UUID id; anything human-readable is returned as is. */
export function shortId(id) {
  const text = String(id ?? '');
  return LONG_ID.test(text) ? `${text.slice(0, 8)}…` : text;
}

/** The last path segment ("cgf-portal"), so a repository reads as a name. */
export function repoName(path) {
  const text = String(path ?? '');
  // A repository cell key ("git:<hash>") has no name to show; shorten it.
  const key = text.match(/^git:([0-9a-f]{13,})$/i);
  if (key) return `git:${shortId(key[1])}`;
  return text.split('/').filter(Boolean).pop() ?? text;
}

/**
 * `<span class="id-chip">` holding the short form and, for a long id, a copy
 * button. `clipboard` is injectable for tests; it defaults to the browser's.
 */
export function idChip(doc, id, { clipboard } = {}) {
  const full = String(id ?? '');
  const chip = doc.createElement('span');
  chip.className = 'id-chip';
  const label = doc.createElement('span');
  label.className = 'id-chip-text';
  label.textContent = shortId(full);
  chip.appendChild(label);
  if (shortId(full) === full) return chip;
  label.title = full;
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'id-chip-copy';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy the full ID ${full}`);
  copy.addEventListener('click', async (event) => {
    event.stopPropagation();
    const target = clipboard ?? doc.defaultView?.navigator?.clipboard;
    try {
      await target.writeText(full);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    doc.defaultView?.setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  });
  chip.appendChild(copy);
  return chip;
}
