// ============================================
// OpenSwarm - Chat model (EPIC INT-1813 S4 / INT-1937)
// Pure chat state + input parsing for the Ink Chat tab. No React/ink/network —
// the streaming reducer and slash parser are unit-tested; ChatPanel wires them
// to chatSession.callChatModel.
// ============================================

import type { Message } from '../support/chatSession.js';

export interface ChatLine {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Convert chat history to persistable messages: only user/assistant turns are
 * saved. System lines (slash-command output, UI notices) are transient and
 * dropped — they aren't part of the conversation to resume. (INT-2014)
 */
export function historyToMessages(history: ChatLine[]): Message[] {
  return history
    .filter((l): l is ChatLine & { role: 'user' | 'assistant' } => l.role === 'user' || l.role === 'assistant')
    .map((l) => ({ role: l.role, content: l.content }));
}

/** Restore persisted messages back to chat history lines. (INT-2014) */
export function messagesToHistory(messages: Message[]): ChatLine[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export interface ChatState {
  /** Finalized lines — rendered in <Static> (no re-render, no flicker). */
  history: ChatLine[];
  /** In-flight assistant text being streamed, or null when idle. */
  streaming: string | null;
  /**
   * User/assistant messages trimmed out of the retained history in this view
   * (drives the one "N older messages trimmed" notice). Reset by `clear`.
   */
  trimmed?: number;
  /**
   * Same count, but never reset: the oldest `dropped` conversation messages
   * seen by this view are gone from memory. ChatPanel uses it to archive the
   * part of a resumed session file a save would otherwise delete.
   */
  dropped?: number;
}

export const initialChatState: ChatState = { history: [], streaming: null };

/** Retained / persisted / prompt chat-history budget (newest kept). */
export const MAX_CHAT_HISTORY = 200;

/**
 * Character budget for the same history. The count cap alone still lets 200
 * very long replies hold megabytes in memory, on disk and in every prompt.
 */
export const MAX_CHAT_HISTORY_CHARS = 400_000;

const CLIPPED_MESSAGE_SUFFIX = ' …[clipped]';

/** Clip to at most `maxUnits` UTF-16 units without splitting a surrogate pair. */
function clipToUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, maxUnits);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function totalChars(lines: ReadonlyArray<{ content: string }>): number {
  let total = 0;
  for (const line of lines) total += line.content.length;
  return total;
}

/** User/assistant lines in `history` (system lines are transient UI output). */
export function conversationCount(history: ReadonlyArray<{ role: string }>): number {
  let n = 0;
  for (const line of history) if (line.role !== 'system') n += 1;
  return n;
}

/**
 * Drop oldest lines until the history fits `maxChars`: transient system lines
 * first, then conversation from the front, cut on a turn boundary. The newest
 * line is never dropped; when it alone exceeds the budget it is clipped.
 */
function boundChatHistoryChars<T extends { role: string; content: string }>(history: T[], maxChars: number): T[] {
  let total = totalChars(history);
  if (total <= maxChars || history.length === 0) return history;
  const newest = history.length - 1;
  const kept = history.filter((line, i) => {
    if (total > maxChars && line.role === 'system' && i !== newest) {
      total -= line.content.length;
      return false;
    }
    return true;
  });
  if (total <= maxChars) return kept;
  let start = 0;
  while (total > maxChars && start < kept.length - 1) {
    total -= kept[start].content.length;
    start += 1;
  }
  // Start the kept window at a user line when one exists before the newest line.
  let turnStart = start;
  while (turnStart < kept.length - 1 && kept[turnStart].role !== 'user') turnStart += 1;
  const window = kept.slice(kept[turnStart].role === 'user' ? turnStart : start);
  if (totalChars(window) <= maxChars) return window;
  // Only the newest line is left and it alone is over budget: clip it.
  const last = window[window.length - 1];
  const room = Math.max(0, maxChars - CLIPPED_MESSAGE_SUFFIX.length);
  return [{ ...last, content: `${clipToUnits(last.content, room)}${CLIPPED_MESSAGE_SUFFIX}` }];
}

/**
 * Keep at most `max` entries and `maxChars` characters, newest first, without
 * breaking the conversation. (AGT-3472, AGT-3494)
 *
 * - Transient `system` lines (slash-command output, notices) go first, so a
 *   burst of them cannot push user/assistant turns out of the window.
 * - Conversation is then cut on a turn boundary: the kept window starts at a
 *   `user` line, never at an assistant reply whose question was cut away.
 * - The newest line always survives; it is clipped if it alone exceeds `maxChars`.
 *
 * No-op when already within both budgets.
 */
export function boundChatHistory<T extends { role: string; content: string }>(
  history: T[],
  max = MAX_CHAT_HISTORY,
  maxChars = MAX_CHAT_HISTORY_CHARS,
): T[] {
  return boundChatHistoryChars(boundChatHistoryCount(history, max), maxChars);
}

function boundChatHistoryCount<T extends { role: string }>(history: T[], max: number): T[] {
  if (history.length <= max) return history;
  let excess = history.length - max;
  const newest = history.length - 1;
  // 1. Oldest system lines first — never the newest line, or a notice that
  //    arrives at the cap would be dropped the moment it is added.
  const kept = history.filter((line, i) => {
    if (excess > 0 && line.role === 'system' && i !== newest) {
      excess -= 1;
      return false;
    }
    return true;
  });
  if (excess === 0) return kept;
  // 2. Then whole turns from the front: cut `excess`, then up to the next user line.
  let start = excess;
  while (start < kept.length && kept[start].role !== 'user') start += 1;
  // No user line left to start from: plain newest window rather than nothing.
  return start < kept.length ? kept.slice(start) : kept.slice(-max);
}

/**
 * Bound `next` and record how many conversation messages the bound removed,
 * so the view can say so and the session can archive them.
 */
function withBoundedHistory(state: ChatState, next: ChatLine[], streaming: string | null): ChatState {
  const history = boundChatHistory(next);
  const lost = conversationCount(next) - conversationCount(history);
  if (lost <= 0) return { ...state, history, streaming };
  return {
    ...state,
    history,
    streaming,
    trimmed: (state.trimmed ?? 0) + lost,
    dropped: (state.dropped ?? 0) + lost,
  };
}

/** Initial state for a view that resumes `history` (bounded, with the trim recorded). */
export function initChatState(history?: ChatLine[]): ChatState {
  if (!history || history.length === 0) return initialChatState;
  return withBoundedHistory(initialChatState, history, null);
}

/** Build a multi-turn prompt from messages (caller should already apply history budget). */
export function buildConversationPrompt(messages: Message[]): string {
  if (messages.length <= 1) return messages[0]?.content ?? '';
  return [
    'Use the following conversation history as context. Continue by answering the latest user message.',
    '',
    messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n'),
  ].join('\n');
}

export type ChatAction =
  | { type: 'user'; content: string }
  | { type: 'system'; content: string }
  | { type: 'stream'; chunk: string }
  | { type: 'commit' }
  | { type: 'clear' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user':
      return withBoundedHistory(state, [...state.history, { role: 'user', content: action.content }], state.streaming);
    case 'system':
      return withBoundedHistory(state, [...state.history, { role: 'system', content: action.content }], state.streaming);
    case 'stream':
      return { ...state, streaming: (state.streaming ?? '') + action.chunk };
    case 'commit':
      return state.streaming === null
        ? state
        : withBoundedHistory(state, [...state.history, { role: 'assistant', content: state.streaming }], null);
    case 'clear':
      // `dropped` survives a clear: it maps onto the resumed file's prefix.
      return state.dropped ? { ...initialChatState, dropped: state.dropped } : initialChatState;
  }
}

export interface SlashCommand {
  name: string;
  args: string;
  desc: string;
}

/** Slash commands offered in the Ink palette (mirrors the blessed TUI). */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/goal', args: '<goal>', desc: 'Set a goal & pursue it autonomously' },
  { name: '/plan', args: '<goal>', desc: 'Decompose a goal & dispatch to the loop' },
  { name: '/model', args: '', desc: 'Switch model (interactive)' },
  { name: '/provider', args: '', desc: 'Switch provider (interactive)' },
  { name: '/clear', args: '', desc: 'Clear the conversation' },
  { name: '/help', args: '', desc: 'Show all commands' },
];

export type ParsedInput =
  | { kind: 'chat'; text: string }
  | { kind: 'command'; name: string; args: string };

/** Classify a submitted input line as free chat or a slash command. */
export function parseInput(raw: string): ParsedInput | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('/')) {
    const sp = t.indexOf(' ');
    return sp === -1
      ? { kind: 'command', name: t, args: '' }
      : { kind: 'command', name: t.slice(0, sp), args: t.slice(sp + 1).trim() };
  }
  return { kind: 'chat', text: t };
}

/**
 * Whether an adapter log line is internal loop chatter that shouldn't surface in
 * the chat activity feed. Hides the "▸ API call #N" turns and the per-adapter
 * "[GPT] N API calls, …" summary; real tool activity (🔧 read_file, edit
 * results, errors) still shows. (INT-1813 follow-up)
 */
export function isActivityNoise(line: string): boolean {
  const t = line.trim();
  return /^▸\s*API call/i.test(t) || /\bAPI calls?\b,/i.test(t);
}

/** Normalize a typed confirm answer to the PlanIO decision vocabulary. */
export function normalizeConfirm(input: string): 'yes' | 'no' | 'edit' {
  const t = input.trim().toLowerCase();
  if (t === 'y' || t === 'yes') return 'yes';
  if (t === 'e' || t === 'edit') return 'edit';
  return 'no';
}

/**
 * Mobile-SSH multibyte input mitigation (INT-1964, extended INT-2012). Some
 * terminals deliver a multibyte keystroke as the character(s) doubled in one
 * input event, so Hangul appears doubled while ASCII is fine. Two observed shapes:
 *
 *   (A) one grapheme repeated N times      — '이' → '이이' or '이이이'
 *   (B) each grapheme doubled in place     — '이렇게' → '이이렇렇게게'
 *
 * Collapse both back to the intended text. Only NON-ASCII graphemes are touched;
 * ASCII, single graphemes, odd-length mixed events, and differing graphemes pass
 * through untouched, so normal typing is unaffected.
 */
export function dedupeDoubledGrapheme(input: string): string {
  const g = Array.from(input);
  if (g.length < 2) return input;

  // (A) a single non-ASCII grapheme repeated N times → one.
  if ((g[0].codePointAt(0) ?? 0) > 0x7f && g.every((c) => c === g[0])) {
    return g[0];
  }

  // (B) even-length event where every adjacent pair is the same non-ASCII
  // grapheme → keep one of each pair.
  if (g.length % 2 === 0) {
    for (let i = 0; i < g.length; i += 2) {
      if (g[i] !== g[i + 1] || (g[i].codePointAt(0) ?? 0) <= 0x7f) {
        return input;
      }
    }
    return g.filter((_, i) => i % 2 === 0).join('');
  }

  return input;
}

/** Wrap-around move of the palette selection index. Returns 0 for an empty list. (INT-1959) */
export function movePaletteSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/** Slash commands whose name prefix-matches the current input (palette). */
export function matchSlash(input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const q = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}
