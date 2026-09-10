// LogLine — render one daemon log line as colored Ink spans (INT-1974).
import { Text } from 'ink';
import { parseLogLine } from '../logFormat.js';
import { sanitizeTerminalText } from '../sanitize.js';

/** Hard cap on a single rendered daemon log line (chars). */
export const MAX_LOG_LINE_CHARS = 4_000;

/**
 * Flatten newlines/tabs and bound length before sanitization/render so a
 * malicious or oversized daemon log event cannot blow up Ink layout memory.
 */
export function prepareLogLine(line: string): string {
  const flattened = line.replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ');
  const bounded = flattened.length > MAX_LOG_LINE_CHARS
    ? `${flattened.slice(0, MAX_LOG_LINE_CHARS - 1)}…`
    : flattened;
  return sanitizeTerminalText(bounded);
}

export function LogLine({ line }: { line: string }) {
  return (
    <Text>
      {parseLogLine(prepareLogLine(line)).map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
