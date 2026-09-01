// LogLine — render one daemon log line as colored Ink spans (INT-1974).
import { Text } from 'ink';
import { parseLogLine } from '../logFormat.js';
import { sanitizeTerminalText } from '../sanitize.js';

// Maximum size of a log line in bytes before truncation
const MAX_LOG_LINE_BYTES = 16 * 1024; // 16 KiB

export function LogLine({ line }: { line: string }) {
  // Truncate long lines to prevent memory issues
  const truncated = line.length > MAX_LOG_LINE_BYTES 
    ? line.slice(0, MAX_LOG_LINE_BYTES) 
    : line;
    
  return (
    <Text>
      {parseLogLine(sanitizeTerminalText(truncated)).map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
