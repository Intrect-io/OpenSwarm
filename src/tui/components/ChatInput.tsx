// ChatInput — bordered prompt box, Claude-Code style (INT-1943).
// Controlled single-line input via useInput. Korean/IME caveat: terminals
// deliver committed code points, so typed/pasted Hangul appends fine; in-flight
// IME composition is terminal-dependent. Nav keys (Tab/arrows) are left to the
// App router; Enter submits, Backspace deletes.
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { theme, ICON } from '../theme.js';
import { sanitizeTerminalText } from '../sanitize.js';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import { inputDebugEnabled, appendInputDebug } from '../inputDebug.js';
import { dedupeDoubledGrapheme } from '../chatModel.js';

// Read once at module load — toggling mid-session isn't a use case. (INT-1964)
const INPUT_DEBUG = inputDebugEnabled();
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function deleteLastGrapheme(value: string): string {
  if (!value) return '';
  if (!GRAPHEME_SEGMENTER) return Array.from(value).slice(0, -1).join('');

  let lastIndex = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(value)) lastIndex = segment.index;
  return value.slice(0, lastIndex);
}

export interface ChatInputProps {
  value: string;
  active: boolean;
  busy?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Command palette is open — ↑/↓ navigate, Enter/Tab select instead of submit. (INT-1959) */
  paletteOpen?: boolean;
  onPaletteMove?: (delta: number) => void;
  onPaletteSelect?: () => void;
  onPaletteClose?: () => void;
}

export function ChatInput({
  value,
  active,
  busy,
  onChange,
  onSubmit,
  paletteOpen,
  onPaletteMove,
  onPaletteSelect,
  onPaletteClose,
}: ChatInputProps) {
  const { stdout } = useStdout();
  useInput(
    (input, key) => {
      // Diagnostics for mobile-SSH multibyte doubling (OPENSWARM_DEBUG_INPUT). (INT-1964)
      if (INPUT_DEBUG) appendInputDebug(input, key);
      // When the palette is open it claims navigation + selection keys (INT-1959).
      if (paletteOpen) {
        if (key.upArrow) return onPaletteMove?.(-1);
        if (key.downArrow) return onPaletteMove?.(1);
        if (key.tab || key.return) return onPaletteSelect?.();
        if (key.escape) return onPaletteClose?.();
      }
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(deleteLastGrapheme(value));
        return;
      }
      if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.escape) return;
      // dedupeDoubledGrapheme: mobile-SSH multibyte doubling mitigation (INT-1964).
      if (input && !key.ctrl && !key.meta) onChange(value + dedupeDoubledGrapheme(input));
    },
    { isActive: active && !busy },
  );

  return (
    <Box borderStyle="round" borderColor={active ? theme.borderActive : theme.border} paddingX={1}>
      {busy ? (
        <Text color={theme.dim}>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text>{' working… (input paused)'}</Text>
        </Text>
      ) : (
        <Box>
          <Text color={theme.accent}>{`${ICON.prompt} `}</Text>
          {/* Display-only clip: the box is one row tall, so a pasted multi-line /
              over-long value must not wrap it; Enter still submits the full
              controlled value. Budget: 2 border columns + 2 paddingX + the `› `
              prompt + the cursor cell + the reserved last column. (AGT-3458) */}
          {value ? (
            <Text>{truncateLine(oneLine(sanitizeTerminalText(value)), Math.max(10, (stdout?.columns ?? 80) - 8))}</Text>
          ) : (
            <Text color={theme.dim}>{'type a message…   / for commands'}</Text>
          )}
          {active ? <Text inverse> </Text> : null}
        </Box>
      )}
    </Box>
  );
}
