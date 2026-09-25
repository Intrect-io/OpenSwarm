/** Clamp value into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
