// CommandPalette — slash-command suggestions for the current input (S4).
// Interactive: the selected row (↑/↓) is highlighted; Enter/Tab completes it. (INT-1959)
import { Box, Text, useStdout } from 'ink';
import { oneLine, truncateLine, displayWidth } from '../../cli/reviewProgress.js';
import { theme } from '../theme.js';
import type { SlashCommand } from '../chatModel.js';

export function CommandPalette({ matches, selectedIndex = 0 }: { matches: SlashCommand[]; selectedIndex?: number }) {
  const { stdout } = useStdout();
  if (matches.length === 0) return null;
  // One suggestion is one row. Each span is clipped against what's LEFT of the
  // budget after the spans before it, so the composed row (pointer + name + args
  // + description) stays within terminal COLUMNS and reserves the last column —
  // while keeping the palette's three-span coloring. (AGT-3458)
  const width = Math.max(10, (stdout?.columns ?? 80) - 3);
  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.map((c, i) => {
        const selected = i === selectedIndex;
        const name = truncateLine(oneLine(c.name), width);
        const args = c.args ? ` ${oneLine(c.args)}` : '';
        const desc = `  ${oneLine(c.desc)}`;
        const argsBudget = Math.max(0, width - displayWidth(name));
        const clippedArgs = truncateLine(args, argsBudget);
        const clippedDesc = truncateLine(desc, Math.max(0, argsBudget - displayWidth(clippedArgs)));
        return (
          <Text key={c.name} inverse={selected}>
            <Text color={theme.accent}>{`${selected ? '❯ ' : '  '}${name}`}</Text>
            {clippedArgs ? <Text dimColor>{clippedArgs}</Text> : null}
            <Text dimColor>{clippedDesc}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
