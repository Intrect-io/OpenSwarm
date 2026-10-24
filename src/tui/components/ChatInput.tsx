// ChatInput — bordered prompt box, Claude-Code style (INT-1943).
// Controlled single-line input via useInput. Korean/IME caveat: terminals
// deliver committed code points, so typed/pasted Hangul appends fine; in-flight
// IME composition is terminal-dependent. Nav keys (Tab/arrows) are left to the
// App router; Enter submits, Backspace deletes.
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { theme, ICON } from '../theme.js';
import { sanitizeTerminalText } from '../sanitize.js';
import { inputDebugEnabled, appendInputDebug } from '../inputDebug.js';
import { dedupeDoubledGrapheme } from '../chatModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

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

/** Prompt icon (2) + cursor (1) + border padding (4) + border (2). */
export const CHAT_INPUT_DISPLAY_OVERHEAD = 2 + 1 + 4 + 2;

/**
 * Clip displayed chat input to the terminal-column budget while leaving the
 * full controlled value untouched for submit/editing.
 */
export function clipChatInputDisplay(value: string, columns: number): string {
  const maxDisplayLen = Math.max(10, columns - CHAT_INPUT_DISPLAY_OVERHEAD);
  return value.length > maxDisplayLen ? value.slice(0, maxDisplayLen - 1) + '…' : value;
}

export interface ChatInputProps {
  value: string;
  active: boolean;
  busy?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Command palette open state — Tab/arrows are consumed by the palette */
  paletteOpen?: boolean;
  onPaletteMove?: (delta: number) => void;
  onPaletteSelect?: () => void;
  onPaletteClose?: () => void;
}

export function ChatInput({
  value,
  active,
  busy = false,
  onChange,
  onSubmit,
  paletteOpen = false,
  onPaletteMove,
  onPaletteSelect,
  onPaletteClose,
}: ChatInputProps) {
  const { columns } = useTerminalSize();

  useInput(
    (input, key) => {
      if (INPUT_DEBUG) appendInputDebug(input, key);

      if (paletteOpen) {
        if (key.escape) {
          onPaletteClose?.();
          return;
        }
        if (key.return) {
          onPaletteSelect?.();
          return;
        }
        if (key.upArrow) {
          onPaletteMove?.(-1);
          return;
        }
        if (key.downArrow) {
          onPaletteMove?.(1);
          return;
        }
        // Tab cycles forward; Shift+Tab cycles backward
        if (key.tab) {
          onPaletteMove?.(key.shift ? -1 : 1);
          return;
        }
        // Any other key closes the palette and falls through to input
        onPaletteClose?.();
      }

      if (key.return) {
        if (value.trim()) onSubmit(value);
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

  // Clip displayed text to available terminal width, preserving the full
  // controlled value. Account for prompt icon (2 chars) + cursor (1 char)
  // + border padding (2 chars left/right = 4 chars) + border (2 chars).
  const displayValue = clipChatInputDisplay(value, columns);

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
          {value ? <Text>{sanitizeTerminalText(displayValue)}</Text> : <Text color={theme.dim}>{'type a message…   / for commands'}</Text>}
          {active ? <Text inverse> </Text> : null}
        </Box>
      )}
    </Box>
  );
}