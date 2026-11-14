// ChatLog — Claude-Code-style conversation (INT-1943).
// Renders the recent message history (assistant text as markdown) plus a live
// area with the streaming reply, inline tool activity, and a spinner.
//
// NOTE: this deliberately does NOT use Ink's <Static>. <Static> prints items to
// the scrollback ABOVE the live region, which is incompatible with the
// full-screen alternate-screen buffer (fullscreen-ink) — the next full-frame
// render wipes them, so messages never accumulate. The reconciler already
// diff-renders, so a normal (windowed) map keeps history without flicker.
import { Box, Text } from 'ink';
import type { ChatLine } from '../chatModel.js';
import { renderMarkdown } from '../markdown.js';
import { theme, ICON } from '../theme.js';
import { WorkingIndicator } from './WorkingIndicator.js';
import { sanitizeAndBoundTerminalText } from '../sanitize.js';

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

// Cap the in-flight streaming preview so a long reply (or reasoning spill) can't
// fill the full-screen frame and push the input box off-screen. The finalized
// message renders in full once committed to history. (INT-2014 / INT-2013)
const STREAM_TAIL_LINES = 14;

/**
 * Rows the live area takes right now: label, the activity lines shown, the
 * streaming tail (with its ellipsis line when cut) and the spinner. Measured,
 * not the worst case, so a short reply does not hide the whole history.
 */
export function liveAreaRows(streaming: string | null, activityCount: number, busy: boolean): number {
  const streamLines = streaming ? streaming.split('\n').length : 0;
  const tail = streamLines > STREAM_TAIL_LINES ? STREAM_TAIL_LINES + 1 : streamLines;
  return 1 + Math.min(activityCount, 5) + tail + (busy ? 1 : 0);
}

export const MAX_LINE_WIDTH = 120;

function truncateLine(text: string): string {
  if (!text) return '';
  return text.length <= MAX_LINE_WIDTH ? text : text.slice(0, MAX_LINE_WIDTH) + '...';
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `…\n${lines.slice(-n).join('\n')}`;
}

/** The text a message renders, after sanitising, line truncation and Markdown. */
function renderBody(line: ChatLine): string {
  // Bound lines + total payload before markdown so hostile content cannot blow the frame.
  const safeContent = sanitizeAndBoundTerminalText(line.content)
    .split('\n')
    .map(truncateLine)
    .join('\n');
  return line.role === 'assistant' ? renderMarkdown(safeContent) : safeContent;
}

/** Rows one rendered message takes: label line + body lines + bottom margin. */
export function renderedMessageRows(body: string): number {
  return 1 + body.split('\n').length + 1;
}

/**
 * The newest messages that fit both budgets, oldest first. Rows are counted on
 * the rendered body, after Markdown expansion: a short reply with a list or a
 * code block can take many more rows than its source has lines, and counting
 * source lines let a few such replies push the input box off a full-screen
 * frame. The newest message is always shown. (AGT-3494)
 */
export function selectVisibleMessages(
  history: ChatLine[],
  maxMessages: number,
  maxRows?: number,
): Array<{ line: ChatLine; body: string; index: number }> {
  if (maxMessages <= 0) return [];
  const picked: Array<{ line: ChatLine; body: string; index: number }> = [];
  let rows = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const body = renderBody(history[i]);
    const need = renderedMessageRows(body);
    if (maxRows !== undefined && picked.length > 0 && rows + need > maxRows) break;
    rows += need;
    picked.push({ line: history[i], body, index: i });
  }
  return picked.reverse();
}

function Message({ line, body }: { line: ChatLine; body: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={ROLE_COLOR[line.role]} bold>{`${ROLE_ICON[line.role]} ${ROLE_LABEL[line.role]}`}</Text>
      <Box paddingLeft={2}>
        <Text>{body}</Text>
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
  /** Row budget for finished messages, counted after Markdown rendering. Unset = no row bound. */
  maxRows?: number;
}

export function ChatLog({ history, streaming, activity = [], busy, maxMessages = 40, maxRows }: ChatLogProps) {
  const live = streaming !== null || busy;
  // While a reply streams, its live area (label, up to 5 activity lines, the
  // streaming tail, spinner) shares the same frame.
  const budget = maxRows === undefined ? undefined : maxRows - (live ? liveAreaRows(streaming, activity.length, !!busy) : 0);
  const shown = selectVisibleMessages(history, maxMessages, budget);
  return (
    <Box flexDirection="column">
      {shown.map(({ line, body, index }) => (
        <Message key={index} line={line} body={body} />
      ))}
      {live ? (
        <Box flexDirection="column">
          <Text color={theme.assistant} bold>{`${ICON.assistant} ${ROLE_LABEL.assistant}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {activity.slice(-5).map((line, i) => {
              const safeLine = truncateLine(sanitizeAndBoundTerminalText(line));
              return (
                <Text key={i} color={theme.dim}>{`${ICON.tool} ${safeLine}`}</Text>
              );
            })}
            {streaming ? (
              <Text>{tailLines(
                sanitizeAndBoundTerminalText(streaming)
                  .split('\n')
                  .map(truncateLine)
                  .join('\n'),
                STREAM_TAIL_LINES,
              )}</Text>
            ) : null}
            {busy ? <WorkingIndicator /> : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
