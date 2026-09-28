// SelectList — a titled, single-select list with a highlighted row. Used by the
// /provider and /model switchers (INT-1960/INT-1961). Key handling lives in the
// caller (ChatInput's palette routing); this is pure presentation.
import { Box, Text, useStdout } from 'ink';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import { theme } from '../theme.js';

export function SelectList({
  title,
  items,
  selectedIndex = 0,
}: {
  title: string;
  items: string[];
  selectedIndex?: number;
}) {
  const { stdout } = useStdout();
  if (items.length === 0) return null;
  // One item is one row: a title/item may carry newlines or run past the
  // terminal, which would wrap the list into many rows. Item budget: the `❯ `
  // prefix + the reserved last column. (AGT-3458)
  const columns = stdout?.columns ?? 80;
  const itemWidth = Math.max(10, columns - 3);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.system}>{truncateLine(oneLine(title), Math.max(10, columns - 1))}</Text>
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={item} inverse={selected}>
            {`${selected ? '❯ ' : '  '}${truncateLine(oneLine(item), itemWidth)}`}
          </Text>
        );
      })}
      <Text dimColor>{'  ↑/↓ select · Enter confirm · Esc cancel'}</Text>
    </Box>
  );
}
