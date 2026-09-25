/** Clamp value into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(min, Math.max(max, value));
}
