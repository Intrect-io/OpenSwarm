/**
 * A per-invocation record of what an agent actually did.
 *
 * Before this, nothing held a worker's prompts, tool calls or output. The
 * stage logs carry timings and one-line verdicts; `automation_attempts` carries
 * a status and an error message; `agentPair`'s sessions are an in-memory map
 * that dies with the process. So when the worker edited a failing contract test
 * to skip the rows it objected to (2026-09-18), the only record was the file's
 * name in one log line, and the edit itself was recoverable solely because a
 * worktree diff was taken by hand before the next iteration overwrote it
 * (AGT-4442).
 *
 * Three properties make this record trustworthy rather than decorative:
 *
 * - **Append-only, written as events happen.** Not an end-of-run snapshot of
 *   the loop's `messages`: that array is mutated in place by compaction and
 *   tool-output trimming, so a snapshot shows the surviving window instead of
 *   what the agent did.
 * - **Bounded, and honest about it.** Caps cut content, never the count. The
 *   `end` event reports how many events were truncated and how many dropped,
 *   so a short file can never be mistaken for a short session.
 * - **Never throws.** A log that can fail a run is worse than no log. Same
 *   contract as `usageLedger.recordUsage`.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One recorded step. `seq` orders them within a session. */
export interface SessionLogEvent {
  type: 'start' | 'assistant' | 'tool' | 'notice' | 'end';
  /** Free-form payload; string fields are clipped to the per-event cap. */
  [key: string]: unknown;
}

export interface SessionRecorder {
  /** Absolute path of the file this recorder appends to. */
  readonly path: string;
  record(event: SessionLogEvent): void;
  /** Writes the `end` event with the drop counts. Idempotent. */
  close(summary?: Record<string, unknown>): void;
}

/** Per string field. A single tool output can be megabytes. */
export const SESSION_LOG_FIELD_CHARS = 20_000;
/**
 * The prompt notice gets more room than the rest, because there is exactly one
 * per invocation and it is what an audit is anchored to.
 *
 * Measured on a real review (2026-09-18): the prompt runs 15k chars with a 6k
 * diff, and reaches ~25k once the diff hits its own 16k ceiling — so the shared
 * 20k cap could not hold the evidence even after this file stopped cutting the
 * tail. One measured worker invocation wrote 1 notice against 153 tool events,
 * so raising this cap alone barely moves a session's size. (AGT-4446)
 */
export const SESSION_LOG_NOTICE_FIELD_CHARS = 64_000;
/**
 * Greppable opener of the notice a clipped field carries in place of its middle.
 *
 * An operator reading a transcript sees the cut rather than inferring it from a
 * `truncated: true` sitting elsewhere in the record.
 */
export const SESSION_LOG_TRUNCATION_MARKER = '[session-log:';
/** Head room for the marker text plus its count, so a clip stays under the cap. */
const TRUNCATION_MARKER_RESERVE = 80;
/** Per session. One measured worker invocation carried 7.3M input tokens. */
export const SESSION_LOG_BYTE_CAP = 8 * 1024 * 1024;
/** Files older than this are pruned. */
export const SESSION_LOG_RETENTION_DAYS = 14;
/** A sweep never touches this window, so an active session cannot be pruned. */
const PRUNE_SAFETY_WINDOW_MS = 60 * 60_000;

export function sessionLogDir(): string {
  return process.env.OPENSWARM_SESSION_LOG_DIR ?? join(homedir(), '.openswarm', 'sessions');
}

/** Explicitly disabled with `OPENSWARM_SESSION_LOG=0`; on otherwise. */
export function sessionLogEnabled(): boolean {
  return process.env.OPENSWARM_SESSION_LOG !== '0';
}

/**
 * Filesystem-safe, and never empty, so a path cannot collapse to the directory.
 *
 * Leading and trailing dots go too: a segment of `..` would be a traversal, and
 * a task identifier is attacker-adjacent input (it arrives from an issue).
 */
function safeSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

/**
 * Keep both ends of an over-long field and say what went missing.
 *
 * Cutting only the head looks harmless until you ask what lives at the tail.
 * The reviewer prompt renders the diff under review last, deliberately, so that
 * a template-level cut eats the diff rather than the verdict-bearing fields
 * (AGT-4443) — and this recorder cut from the opposite end, so a review
 * transcript kept the boilerplate and threw away the change under review. That
 * is the one thing an operator opens a review transcript to audit: reading one,
 * I concluded the diff wiring had never fired in production when it had. A
 * transparency record that argues for a wrong conclusion is worse than one that
 * admits it does not know. (AGT-4446)
 */
function clipString(value: string, cap: number): string {
  const budget = cap - TRUNCATION_MARKER_RESERVE;
  // Only reachable if the cap is configured smaller than the marker itself.
  if (budget < 2) return value.slice(0, cap);
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const dropped = value.length - head - tail;
  return `${value.slice(0, head)}\n${SESSION_LOG_TRUNCATION_MARKER} ${dropped} chars omitted]\n${value.slice(value.length - tail)}`;
}

/** Clip every string in the payload, one level deep plus arrays of strings. */
function clipEvent(event: SessionLogEvent): SessionLogEvent {
  const out: SessionLogEvent = { type: event.type };
  const cap = event.type === 'notice' ? SESSION_LOG_NOTICE_FIELD_CHARS : SESSION_LOG_FIELD_CHARS;
  let truncated = false;
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    if (typeof value === 'string' && value.length > cap) {
      out[key] = clipString(value, cap);
      truncated = true;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (typeof item === 'string' && item.length > cap) {
          truncated = true;
          return clipString(item, cap);
        }
        return item;
      });
    } else {
      out[key] = value;
    }
  }
  if (truncated) out.truncated = true;
  return out;
}

/**
 * Open a recorder for one agent invocation, or return undefined when logging
 * is off or the directory cannot be created.
 *
 * One file per invocation: a task has many iterations and attempts, and a
 * single per-task file would conflate separate invocations into one apparent
 * run. The random suffix is what lets sixteen concurrent slots share a task
 * directory without a lock.
 */
export function createSessionRecorder(input: {
  taskId?: string;
  stage?: string;
  adapter?: string;
  model?: string;
  cwd?: string;
  /** CLI adapters can only observe their process boundary, not inner turns. */
  recordingLevel?: 'cli';
}): SessionRecorder | undefined {
  if (!sessionLogEnabled()) return undefined;

  const dir = join(sessionLogDir(), safeSegment(input.taskId, 'adhoc'));
  const name = [
    new Date().toISOString().replace(/[:.]/g, '-'),
    safeSegment(input.stage, 'stage'),
    randomUUID().slice(0, 8),
  ].join('_');
  const path = join(dir, `${name}.jsonl`);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // An unwritable state directory is not a reason to fail the agent.
    return undefined;
  }

  let seq = 0;
  let bytes = 0;
  let truncatedEvents = 0;
  let droppedEvents = 0;
  let closed = false;

  const write = (event: SessionLogEvent): void => {
    const clipped = clipEvent(event);
    if (clipped.truncated) truncatedEvents += 1;
    const line = `${JSON.stringify({ seq: seq++, ts: new Date().toISOString(), ...clipped })}\n`;
    bytes += Buffer.byteLength(line);
    try {
      appendFileSync(path, line);
    } catch {
      // Disk full, permissions revoked mid-run: stop counting on it, keep going.
      droppedEvents += 1;
    }
  };

  write({
    type: 'start',
    adapter: input.adapter,
    stage: input.stage,
    model: input.model,
    taskId: input.taskId,
    cwd: input.cwd,
    ...(input.recordingLevel ? { recordingLevel: input.recordingLevel } : {}),
  });

  return {
    path,
    record(event) {
      if (closed) return;
      // Past the cap the session keeps counting but stops growing, so the
      // `end` event can say how much is missing.
      if (bytes >= SESSION_LOG_BYTE_CAP) {
        droppedEvents += 1;
        return;
      }
      write(event);
    },
    close(summary) {
      if (closed) return;
      closed = true;
      write({ type: 'end', ...summary, truncatedEvents, droppedEvents, bytes });
    },
  };
}

/**
 * Drop session files older than `retentionDays`.
 *
 * Skips anything modified inside the safety window: a live recorder appends to
 * its file for as long as its agent runs, and mtime alone cannot tell a
 * finished session from a slow one.
 */
export function pruneSessionLogs(
  retentionDays = SESSION_LOG_RETENTION_DAYS,
  dir = sessionLogDir(),
  now = Date.now(),
): number {
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  let taskDirs: string[];
  try {
    taskDirs = readdirSync(dir);
  } catch {
    return 0; // Nothing written yet.
  }
  for (const taskDir of taskDirs) {
    const full = join(dir, taskDir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(full, entry);
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime >= cutoff || now - mtime < PRUNE_SAFETY_WINDOW_MS) continue;
        rmSync(file, { force: true });
        removed += 1;
      } catch {
        continue;
      }
    }
    try {
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
  return removed;
}
