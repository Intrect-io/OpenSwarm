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

export const MAX_LINE_WIDTH = 120;

function truncateLine(text: string): string {
  if (!text) return '';
  return text.length <= MAX_LINE_WIDTH ? text : text.slice(0, MAX_LINE_WIDTH) + '...';
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `…\n${lines.slice(-n).join('\n')}`;
}

function Message({ line }: { line: ChatLine }) {
  // Bound lines + total payload before markdown so hostile content cannot blow the frame.
  const safeContent = sanitizeAndBoundTerminalText(line.content)
    .split('\n')
    .map(truncateLine)
    .join('\n');
  const body = line.role === 'assistant' ? renderMarkdown(safeContent) : safeContent;
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
}

function ChatLog({ history, streaming, activity = [], busy, maxMessages = 40 }: ChatLogProps) {
  const live = streaming !== null || busy;
  const shown = maxMessages > 0 ? history.slice(-maxMessages) : [];
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Message key={history.length - shown.length + i} line={line} />
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

export { ChatLog };
export default ChatLog;
