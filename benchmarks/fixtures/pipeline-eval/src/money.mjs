/** Format integer cents as dollars, e.g. 105 -> "$1.05", -250 -> "-$2.50". */
export function formatCents(cents) {
  return `$${cents / 100}`;
}
