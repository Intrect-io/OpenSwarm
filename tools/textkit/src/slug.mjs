/** Lowercase URL slug: words joined by single dashes, no leading/trailing dash. */
export function slugify(input) {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return slug.replace(/^-+|-+$/g, '');
}
