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

/** Columns the input box uses besides the text: prompt icon (2) + cursor (1) + paddingX (2) + border (2). */
export const CHAT_INPUT_DISPLAY_OVERHEAD = 2 + 1 + 2 + 2;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
];

/** Terminal columns one code point takes: 2 for East Asian wide and emoji, else 1. */
function charColumns(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
}

/**
 * The part of the input that fits the terminal width. Only the rendered text is
 * clipped; the controlled value the user edits and submits stays whole. Keeps
 * the tail, where the cursor is, and marks the cut with a leading ellipsis.
 * Hangul and other wide characters count as two columns.
 */
export function clipChatInputDisplay(value: string, columns: number): string {
  const budget = Math.max(10, columns - CHAT_INPUT_DISPLAY_OVERHEAD);
  const chars = Array.from(value);
  let width = 0;
  for (const ch of chars) width += charColumns(ch);
  if (width <= budget) return value;
  const kept: string[] = [];
  let used = 1; // the ellipsis
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charColumns(chars[i]);
    if (used + w > budget) break;
    kept.push(chars[i]);
    used += w;
  }
  return `…${kept.reverse().join('')}`;
}

/**
 * The input box is one row and a submit is one message, so a pasted chunk's
 * line breaks become single spaces instead of reaching the value. A terminal
 * that delivers a paste as one chunk would otherwise put raw newlines into the
 * controlled value and the submitted prompt.
 */
export function toSingleLineChatInput(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ');
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
  const { columns } = useTerminalSize();
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
        onSubmit(toSingleLineChatInput(value));
        return;
      }
      if (key.backspace || key.delete) {
        onChange(deleteLastGrapheme(value));
        return;
      }
      if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.escape) return;
      // dedupeDoubledGrapheme: mobile-SSH multibyte doubling mitigation (INT-1964).
      if (input && !key.ctrl && !key.meta) onChange(value + toSingleLineChatInput(dedupeDoubledGrapheme(input)));
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
          {value ? <Text>{sanitizeTerminalText(clipChatInputDisplay(value, columns))}</Text> : <Text color={theme.dim}>{'type a message…   / for commands'}</Text>}
          {active ? <Text inverse> </Text> : null}
        </Box>
      )}
    </Box>
  );
}
