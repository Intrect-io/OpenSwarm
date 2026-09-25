/** Integers from start to end. */
export function range(start, end) {
  const out = [];
  for (let i = start; i < end; i += 1) out.push(i);
  return out;
}
