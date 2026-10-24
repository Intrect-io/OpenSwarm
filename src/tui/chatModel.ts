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
}

export const initialChatState: ChatState = { history: [], streaming: null };

/** Retained / persisted / prompt chat-history budget (newest kept). */
export const MAX_CHAT_HISTORY = 200;

/** Keep the newest `MAX_CHAT_HISTORY` lines; no-op when already within budget. */
export function boundChatHistory<T>(history: T[], max = MAX_CHAT_HISTORY): T[] {
  return history.length <= max ? history : history.slice(-max);
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
      return {
        ...state,
        history: boundChatHistory([...state.history, { role: 'user', content: action.content }]),
      };
    case 'system':
      return {
        ...state,
        history: boundChatHistory([...state.history, { role: 'system', content: action.content }]),
      };
    case 'stream':
      return { ...state, streaming: (state.streaming ?? '') + action.chunk };
    case 'commit':
      return state.streaming === null
        ? state
        : {
            history: boundChatHistory([...state.history, { role: 'assistant', content: state.streaming }]),
            streaming: null,
          };
    case 'clear':
      return initialChatState;
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
