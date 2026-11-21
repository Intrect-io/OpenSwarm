import { ELLIPSIS } from './ellipsis.mjs';

/** Shorten `text` to at most `max` characters, marking the cut. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + ELLIPSIS;
}
