// LogLine — render one daemon log line as colored Ink spans (INT-1974).
import { Text } from 'ink';
import { parseLogLine } from '../logFormat.js';
import { sanitizeTerminalText } from '../sanitize.js';

export function LogLine({ line }: { line: string }) {
  return (
    <Text>
      {parseLogLine(sanitizeTerminalText(line)).map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
