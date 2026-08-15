/**
 * Convert arbitrary log values to a single physical line before sending them to
 * a terminal or daemon log. Task titles, provider output, and remote API errors
 * must not be able to forge a second log entry with CR/LF characters.
 */
export function formatLogValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`.replace(/[\r\n]/g, '');
  return String(value).replace(/[\r\n]/g, '');
}

export const safeConsole = {
  log: (...values: unknown[]): void => console.log(...values.map(formatLogValue)),
  info: (...values: unknown[]): void => console.info(...values.map(formatLogValue)),
  warn: (...values: unknown[]): void => console.warn(...values.map(formatLogValue)),
  error: (...values: unknown[]): void => console.error(...values.map(formatLogValue)),
};
