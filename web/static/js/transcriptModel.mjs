// Per-session transcript: classification, tool grouping, bounded history.
// (INT-3402)
//
// The data half of the work-card console (INT-3397), generalized for the
// cockpit: same ring bound and stage boundaries, plus vega's activity-row
// idea — consecutive tool lines collapse into one summarized group instead of
// scrolling the reasoning off screen.
//
// DOM-free; transcriptView renders the entries this produces.

export const TRANSCRIPT_MAX_ENTRIES = 500;

// Daemon line prefixes. Kept in one place: the emitters may change glyphs, and
// a stale copy would silently mis-style every line.
const THINKING_PREFIX = '💭';
const TOOL_PREFIX = '🔧';

/** 'thinking' | 'tool' | 'plain' — drives styling, not behavior. */
export function classifyLine(line) {
  if (typeof line !== 'string') return 'plain';
  const trimmed = line.trimStart();
  if (trimmed.startsWith(THINKING_PREFIX)) return 'thinking';
  if (trimmed.startsWith(TOOL_PREFIX)) return 'tool';
  return 'plain';
}

/**
 * Summarize a run of tool lines: "Read 4 files" when they share a verb,
 * "7 tool calls" when mixed. Mirrors vega's activity-row vocabulary.
 */
export function summarizeToolGroup(lines) {
  const count = lines.length;
  if (count === 1) return stripToolPrefix(lines[0]);
  const verbs = new Set(lines.map(toolVerb).filter(Boolean));
  if (verbs.size === 1) {
    const verb = [...verbs][0];
    return `${verb} ×${count}`;
  }
  return `${count} tool calls`;
}

function stripToolPrefix(line) {
  return line.trimStart().slice(TOOL_PREFIX.length).trim() || line.trim();
}

/** First token of a tool line, e.g. "🔧 read_file: src/a.ts" → "read_file". */
function toolVerb(line) {
  const body = stripToolPrefix(line);
  const match = body.match(/^([A-Za-z_][\w-]*)/);
  return match ? match[1] : '';
}

/**
 * Entries are one of:
 *   { kind: 'stage',  stage }                      — a stage boundary marker
 *   { kind: 'line',   type: 'thinking'|'plain', text, stage }
 *   { kind: 'tools',  lines: string[], stage }     — a collapsible run
 *
 * A tool group stays OPEN (appendable) until a non-tool line or a stage change
 * flushes it, so a burst of calls renders as one row.
 */
export class TranscriptModel extends EventTarget {
  // taskId -> { entries, raw, lastStage, openTools, maxSeq }
  #byTask = new Map();
  #maxEntries;

  constructor({ maxEntries = TRANSCRIPT_MAX_ENTRIES } = {}) {
    super();
    this.#maxEntries = maxEntries;
  }

  entries(taskId) {
    return this.#byTask.get(taskId)?.entries ?? [];
  }

  /**
   * Flat {stage, line, ts, seq} history, in arrival order — the shape `replace`
   * accepts. Lets a caller reconcile a server snapshot with lines that
   * streamed in while the request was in flight instead of dropping them.
   */
  rawLines(taskId) {
    return this.#byTask.get(taskId)?.raw ?? [];
  }

  has(taskId) {
    return this.#byTask.has(taskId);
  }

  clear(taskId) {
    this.#byTask.delete(taskId);
  }

  /** Replace a task's history wholesale (REST snapshot wins over live noise). */
  replace(taskId, lines) {
    this.#byTask.delete(taskId);
    for (const entry of lines ?? []) {
      this.append(taskId, entry, { silent: true });
    }
    this.dispatchEvent(new CustomEvent('replace', { detail: { taskId } }));
  }

  append(taskId, { stage, line, ts, seq }, { silent = false } = {}) {
    if (typeof line !== 'string' || !line) return;
    let state = this.#byTask.get(taskId);
    if (!state) {
      state = { entries: [], raw: [], lastStage: null, openTools: null, maxSeq: 0 };
      this.#byTask.set(taskId, state);
    }

    // Idempotent on the daemon's per-line sequence. The same line can reach us
    // more than once — the SSE replay buffer on connect, a snapshot merge, a
    // reconnect that replays — and rendering it twice is a visible lie about
    // what the agent did. Sequences arrive in order within a task, so the
    // high-water mark is enough; lines from a daemon that stamps none fall
    // through unchanged.
    if (typeof seq === 'number') {
      if (seq <= state.maxSeq) return;
      state.maxSeq = seq;
    }

    state.raw.push({ stage, line, ts, seq });
    while (state.raw.length > this.#maxEntries) state.raw.shift();

    if (stage && stage !== state.lastStage) {
      state.lastStage = stage;
      state.openTools = null; // a new stage always starts a fresh group
      state.entries.push({ kind: 'stage', stage });
    }

    const type = classifyLine(line);
    if (type === 'tool') {
      if (state.openTools) {
        state.openTools.lines.push(line);
      } else {
        state.openTools = { kind: 'tools', lines: [line], stage: state.lastStage };
        state.entries.push(state.openTools);
      }
    } else {
      state.openTools = null;
      state.entries.push({ kind: 'line', type, text: line, stage: state.lastStage });
    }

    // Evict whole entries — never half a tool group.
    while (state.entries.length > this.#maxEntries) {
      const dropped = state.entries.shift();
      if (dropped === state.openTools) state.openTools = null;
    }

    if (!silent) {
      this.dispatchEvent(new CustomEvent('append', { detail: { taskId } }));
    }
  }
}
