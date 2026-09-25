/** Lowercase URL slug: words joined by single dashes, no leading/trailing dash. */
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
