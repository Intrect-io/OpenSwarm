// ChatLog — Claude-Code-style conversation (INT-1943).
// Renders the recent message history (assistant text as markdown) plus a live
// area with the streaming reply, inline tool activity, and a spinner.
//
// NOTE: this deliberately does NOT use Ink's <Static>. <Static> prints items to
// the scrollback ABOVE the live region, which is incompatible with the
// full-screen alternate-screen buffer (fullscreen-ink) — the next full-frame
// render wipes them, so messages never accumulate. The reconciler already
// diff-renders, so a normal (windowed) map keeps history without flicker.
import { Box, Text, useStdout } from 'ink';
import { useMemo } from 'react';
import type { ChatLine } from '../chatModel.js';
import { renderMarkdown } from '../markdown.js';
import { theme, ICON } from '../theme.js';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import { WorkingIndicator } from './WorkingIndicator.js';
import { sanitizeTerminalText } from '../sanitize.js';

const ROLE_COLOR: Record<ChatLine['role'], string> = {
  user: theme.user,
  assistant: theme.assistant,
  system: theme.system,
};
const ROLE_LABEL: Record<ChatLine['role'], string> = {
  user: 'you',
  assistant: 'openswarm',
  system: 'system',
};
const ROLE_ICON: Record<ChatLine['role'], string> = {
  user: ICON.user,
  assistant: ICON.assistant,
  system: ICON.system,
};

// Height budgets are terminal ROWS, never code units. The old bound was source
// LINES only: one value carrying hundreds of newlines — or a single unbroken
// multi-KB line Ink wraps — still expanded to thousands of rows, and every
// commit re-laid-out and re-diffed them. The viewport minus the chrome (context
// bar, tab bar, padding, input box, help bar) is one pool, split between the
// transcript and the live area, so the frame as a whole fits — not just one
// message. `maxMessages` still bounds the message count. (AGT-3458)
const CHROME_ROWS = 10;
const MESSAGE_CHROME_ROWS = 2; // role label + trailing margin
/** Longest streaming preview, so a long reply can't fill the frame. (INT-2014) */
const LIVE_MAX_ROWS = 14;
/** The live block's `openswarm` label row. */
const STREAM_LABEL_ROWS = 1;
const TRANSCRIPT_MIN_ROWS = MESSAGE_CHROME_ROWS + 1;

/** Rendered rows in `text` — markdown output is line-per-row once clipped. */
const rowCount = (text: string) => text.split('\n').length;

/** One message's body, rendered exactly as `Message` will (also drives the fit). */
function messageBody(line: ChatLine, width: number): string {
  const safe = clipColumns(sanitizeTerminalText(line.content), width);
  return line.role === 'assistant' ? renderMarkdown(safe, width) : safe;
}

/** Total rows one message occupies: its label + margin + ≤`budget` content rows. */
function messageRows(line: ChatLine, width: number, budget: number): number {
  const content = Math.min(rowCount(messageBody(line, width)), Math.max(1, budget - MESSAGE_CHROME_ROWS));
  return content + MESSAGE_CHROME_ROWS;
}

/**
 * The tail of `history` whose TOTAL rows (labels included) fit `budget`: newest
 * first, capped at `maxMessages`, always keeping the newest message so a single
 * huge one still shows (clipped) rather than leaving the transcript empty.
 */
function fitHistory(history: ChatLine[], maxMessages: number, budget: number, width: number): ChatLine[] {
  const out: ChatLine[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && out.length < maxMessages; i -= 1) {
    const rows = messageRows(history[i], width, budget);
    if (out.length > 0 && used + rows > budget) break;
    out.unshift(history[i]);
    used += rows;
  }
  return out;
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `…\n${lines.slice(-n).join('\n')}`;
}

function headLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `${lines.slice(0, n).join('\n')}\n…`;
}

/** Clip every source line to a column budget, so markdown/Ink cannot wrap it. */
function clipColumns(text: string, width: number): string {
  return text.split('\n').map((line) => truncateLine(line, width)).join('\n');
}

function Message({ line, width, budget }: { line: ChatLine; width: number; budget: number }) {
  // `width` also drives the reflow, so prose lands near the terminal width; the
  // reflow counts code units (and skips lists/code), so `wrap="truncate"` is the
  // final ANSI-safe clip — one row per line however wide the glyphs are. (AGT-3458)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={ROLE_COLOR[line.role]} bold>{`${ROLE_ICON[line.role]} ${ROLE_LABEL[line.role]}`}</Text>
      <Box paddingLeft={2}>
        <Text wrap="truncate">{headLines(messageBody(line, width), Math.max(1, budget - MESSAGE_CHROME_ROWS))}</Text>
      </Box>
    </Box>
  );
}

export interface ChatLogProps {
  history: ChatLine[];
  streaming: string | null;
  /** Recent tool-activity lines shown under the in-flight reply. */
  activity?: string[];
  busy?: boolean;
  /** Keep the last N messages on screen (bounds height in the full-screen layout). */
  maxMessages?: number;
}

export function ChatLog({ history, streaming, activity = [], busy, maxMessages = 40 }: ChatLogProps) {
  const { stdout } = useStdout();
  // `- 6` covers the `paddingLeft={2}` indent plus markdown's own decoration
  // (`  * ` list marker, 2-space code indent) and reserves the last column.
  const bodyWidth = Math.max(10, (stdout?.columns ?? 80) - 6);
  const live = streaming !== null || busy;
  // One pool for the content area. The live block is charged for what it will
  // actually render (label, ≤LIVE_MAX_ROWS preview, ≤5 activity lines,
  // indicator), and the transcript takes the rest — so the frame as a whole
  // fits, while ordinary history keeps its rows instead of yielding to a cap.
  const contentRows = Math.max(TRANSCRIPT_MIN_ROWS, (stdout?.rows ?? 24) - CHROME_ROWS);
  const activityRows = live ? Math.min(5, activity.length) : 0;
  const wantedLive = live
    ? STREAM_LABEL_ROWS + activityRows + (streaming ? Math.min(rowCount(streaming), LIVE_MAX_ROWS) : 0) + (busy ? 1 : 0)
    : 0;
  const liveRows = Math.min(wantedLive, Math.max(0, contentRows - TRANSCRIPT_MIN_ROWS));
  const streamRows = Math.max(
    1,
    liveRows - STREAM_LABEL_ROWS - activityRows - (busy && liveRows > STREAM_LABEL_ROWS + activityRows ? 1 : 0),
  );
  const transcriptRows = Math.max(TRANSCRIPT_MIN_ROWS, contentRows - liveRows);
  // Fitting re-renders the tail, so only redo it when the inputs actually change.
  const shown = useMemo(
    () => (maxMessages > 0 ? fitHistory(history, maxMessages, transcriptRows, bodyWidth) : []),
    [history, maxMessages, transcriptRows, bodyWidth],
  );
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Message key={history.length - shown.length + i} line={line} width={bodyWidth} budget={transcriptRows} />
      ))}
      {live ? (
        <Box flexDirection="column">
          <Text color={theme.assistant} bold>{`${ICON.assistant} ${ROLE_LABEL.assistant}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {activity.slice(-5).map((line, i) => (
              <Text key={i} color={theme.dim}>
                {`${ICON.tool} ${truncateLine(oneLine(sanitizeTerminalText(line)), bodyWidth - 2)}`}
              </Text>
            ))}
            {streaming ? (
              <Text wrap="truncate">{tailLines(clipColumns(sanitizeTerminalText(streaming), bodyWidth), streamRows)}</Text>
            ) : null}
            {busy ? <WorkingIndicator /> : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
