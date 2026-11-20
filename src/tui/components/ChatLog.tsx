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
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { tailToWidth, wrappedRows } from '../displayWidth.js';

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

/** Columns a message body or live-area line wraps at: the frame minus the 2-column indent. */
function bodyColumns(columns: number): number {
  return Math.max(1, columns - 2);
}

/**
 * Rows the live area takes right now: label, the activity lines shown, the
 * streaming tail (with its ellipsis line when cut) and the spinner. Measured,
 * not the worst case, so a short reply does not hide the whole history.
 * `activity` may be a count (one row each) or the lines themselves; with
 * `columns`, every line is counted with its soft wrap.
 */
export function liveAreaRows(
  streaming: string | null,
  activity: number | string[],
  busy: boolean,
  columns?: number,
): number {
  const width = columns === undefined ? Number.POSITIVE_INFINITY : bodyColumns(columns);
  const rowsOf = (text: string) => (width === Number.POSITIVE_INFINITY ? text.split('\n').length : wrappedRows(text, width));
  const activityRows = typeof activity === 'number'
    ? Math.min(activity, 5)
    : activity.slice(-5).reduce((sum, line) => sum + rowsOf(activityText(line)), 0);
  const tail = streaming ? rowsOf(streamingText(streaming)) : 0;
  return 1 + activityRows + tail + (busy ? 1 : 0);
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

/** One rendered tool-activity line. */
function activityText(line: string): string {
  return `${ICON.tool} ${truncateLine(sanitizeAndBoundTerminalText(line))}`;
}

/** The streaming preview as rendered: sanitised, line-truncated, last lines only. */
function streamingText(streaming: string): string {
  return tailLines(
    sanitizeAndBoundTerminalText(streaming).split('\n').map(truncateLine).join('\n'),
    STREAM_TAIL_LINES,
  );
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

/**
 * Rows one rendered message takes: label line + body rows + bottom margin.
 * With `columns`, each body line counts its soft wrap at the indented width.
 */
export function renderedMessageRows(body: string, columns?: number): number {
  const bodyRows = columns === undefined ? body.split('\n').length : wrappedRows(body, bodyColumns(columns));
  return 1 + bodyRows + 1;
}

/**
 * Tail-clip a rendered body to `maxBodyRows` rows (including a leading "…"
 * marker row). Whole lines are kept from the end; when even the last line is
 * too tall, its tail is kept at the rows that remain.
 */
export function clipBodyToRows(body: string, maxBodyRows: number, columns?: number): string {
  const rowBudget = Math.max(1, maxBodyRows - 1); // one row for the marker
  const width = columns === undefined ? Number.POSITIVE_INFINITY : bodyColumns(columns);
  const lines = body.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const need = width === Number.POSITIVE_INFINITY ? 1 : wrappedRows(lines[i], width);
    if (used + need <= rowBudget) {
      kept.push(lines[i]);
      used += need;
      continue;
    }
    if (kept.length === 0) kept.push(tailToWidth(lines[i], (rowBudget - used) * width));
    break;
  }
  return `…\n${kept.reverse().join('\n')}`;
}

/**
 * The newest messages that fit both budgets, oldest first. Rows are counted on
 * the rendered body, after Markdown expansion and soft wrap at `columns`: a
 * short reply with a list, a code block or a long line can take many more rows
 * than its source has lines, and counting source lines let a few such replies
 * push the input box off a full-screen frame. The newest message is always
 * shown; when it alone exceeds the budget its body is tail-clipped to fit
 * behind a "…" marker. (AGT-3494)
 */
export function selectVisibleMessages(
  history: ChatLine[],
  maxMessages: number,
  maxRows?: number,
  columns?: number,
): Array<{ line: ChatLine; body: string; index: number }> {
  if (maxMessages <= 0) return [];
  const picked: Array<{ line: ChatLine; body: string; index: number }> = [];
  let rows = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    let body = renderBody(history[i]);
    let need = renderedMessageRows(body, columns);
    if (maxRows !== undefined && picked.length > 0 && rows + need > maxRows) break;
    if (maxRows !== undefined && picked.length === 0 && need > maxRows) {
      // Label + margin take two rows; keep at least one body row.
      body = clipBodyToRows(body, Math.max(2, maxRows - 2), columns);
      need = renderedMessageRows(body, columns);
    }
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
  /** Terminal width used to count soft-wrapped rows. Defaults to the live terminal size. */
  columns?: number;
  /** Conversation messages dropped from the retained history; > 0 shows one notice line. */
  trimmedCount?: number;
}

/** The single notice shown while older messages are out of the retained history. */
export function trimmedNotice(count: number): string {
  return `${ICON.system} ${count} older message${count === 1 ? '' : 's'} trimmed from this view`;
}

export function ChatLog({
  history,
  streaming,
  activity = [],
  busy,
  maxMessages = 40,
  maxRows,
  columns: columnsProp,
  trimmedCount = 0,
}: ChatLogProps) {
  const { columns: terminalColumns } = useTerminalSize();
  const columns = columnsProp ?? terminalColumns;
  const live = streaming !== null || busy;
  const notice = trimmedCount > 0 ? trimmedNotice(trimmedCount) : null;
  // While a reply streams, its live area (label, up to 5 activity lines, the
  // streaming tail, spinner) shares the same frame, as does the trim notice.
  const budget = maxRows === undefined
    ? undefined
    : maxRows
      - (live ? liveAreaRows(streaming, activity, !!busy, columns) : 0)
      - (notice ? wrappedRows(notice, columns) : 0);
  const shown = selectVisibleMessages(history, maxMessages, budget, columns);
  return (
    <Box flexDirection="column">
      {notice ? <Text color={theme.dim}>{notice}</Text> : null}
      {shown.map(({ line, body, index }) => (
        <Message key={index} line={line} body={body} />
      ))}
      {live ? (
        <Box flexDirection="column">
          <Text color={theme.assistant} bold>{`${ICON.assistant} ${ROLE_LABEL.assistant}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {activity.slice(-5).map((line, i) => (
              <Text key={i} color={theme.dim}>{activityText(line)}</Text>
            ))}
            {streaming ? <Text>{streamingText(streaming)}</Text> : null}
            {busy ? <WorkingIndicator /> : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
