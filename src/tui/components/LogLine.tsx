// LogLine — render one daemon log line as colored Ink spans (INT-1974).
import { Text, useStdout } from 'ink';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import { parseLogLine } from '../logFormat.js';
import { sanitizeTerminalText } from '../sanitize.js';

export function LogLine({ line }: { line: string }) {
  const { stdout } = useStdout();
  // A daemon log line carries embedded newlines/tabs (stack traces, pretty JSON),
  // and Ink wraps whatever is left at the terminal width — either one turns a
  // single line into many physical rows and blows the frame. Flatten it to one
  // row and clip by display COLUMNS, reserving the last column so the write
  // can't auto-wrap. (AGT-3458)
  const row = truncateLine(oneLine(sanitizeTerminalText(line)), Math.max(10, (stdout?.columns ?? 80) - 1));
  return (
    <Text>
      {parseLogLine(row).map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
