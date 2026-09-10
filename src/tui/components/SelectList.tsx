// SelectList — a titled, single-select list with a highlighted row. Used by the
// /provider and /model switchers (INT-1960/INT-1961). Key handling lives in the
// caller (ChatInput's palette routing); this is pure presentation.
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { sanitizeTerminalText } from '../sanitize.js';

const MAX_OPTIONS = 64;
const MAX_OPTION_CHARS = 120;

function normalizeOptions(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    // Flatten nested / multi-line labels into a single clipped row.
    const flat = sanitizeTerminalText(String(raw ?? ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_OPTION_CHARS);
    if (!flat || seen.has(flat)) continue;
    seen.add(flat);
    out.push(flat);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

export function SelectList({
  title,
  items,
  selectedIndex = 0,
}: {
  title: string;
  items: string[];
  selectedIndex?: number;
}) {
  const options = normalizeOptions(items);
  if (options.length === 0) return null;
  const safeIndex = Math.min(Math.max(0, selectedIndex), options.length - 1);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.system}>{sanitizeTerminalText(title).slice(0, MAX_OPTION_CHARS)}</Text>
      {options.map((item, i) => {
        const selected = i === safeIndex;
        return (
          <Text key={`${i}:${item}`} inverse={selected}>
            {`${selected ? '❯ ' : '  '}${item}`}
          </Text>
        );
      })}
      <Text dimColor>{'  ↑/↓ select · Enter confirm · Esc cancel'}</Text>
    </Box>
  );
}
