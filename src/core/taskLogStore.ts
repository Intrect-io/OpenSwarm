// ============================================
// OpenSwarm - Per-task log ring buffers (INT-3402)
// ============================================
//
// The hub's global replay keeps only ~50 log lines across ALL tasks, so a page
// reload loses most of a session's transcript. This store keeps a bounded ring
// per task, fed by broadcastEvent's 'log' case, and serves the cockpit's
// GET /api/work/sessions/:taskId/log.
//
// Deliberately import-free: eventHub imports this module, and route modules
// import both — any import from here would be a cycle waiting to happen.
//
// Memory bound is threefold: per-line truncation x per-task ring x LRU buffer
// cap. Worst case 24 x 1000 x (~400 UTF-16 chars + object overhead) ≈ 22 MB;
// observed agent lines average ~80 chars, so typical usage is 1–3 MB.

export interface TaskLogLine {
  stage: string;
  line: string;
  ts: number;
  /**
   * Strictly increasing across every line this process appends. A wall-clock
   * `ts` is not enough to reconcile a snapshot with a live stream: an agent
   * easily emits several lines inside one millisecond, and a `> lastTs` merge
   * silently drops the ties. (INT-3402)
   */
  seq: number;
}

export interface TaskLogSnapshot {
  taskId: string;
  lines: TaskLogLine[];
  /** True when the ring dropped older lines (or a line was cut to the char cap). */
  truncated: boolean;
}

export const TASK_LOG_RING_SIZE = 1000;
export const TASK_LOG_MAX_LINE_CHARS = 400;
export const TASK_LOG_MAX_BUFFERS = 24;
export const TASK_LOG_RETENTION_MS = 10 * 60_000;

interface TaskLogBuffer {
  lines: TaskLogLine[];
  truncated: boolean;
  /** Set once the task completed and a cleanup timer is pending — the only
   * buffers eligible for LRU eviction. */
  completed: boolean;
  lastAppendAt: number;
}

// Map iteration order is insertion order; entries are re-inserted on append so
// the first eligible entry found is the least recently used.
const buffers = new Map<string, TaskLogBuffer>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();
let nextSeq = 1;

function evictIfNeeded(): void {
  if (buffers.size < TASK_LOG_MAX_BUFFERS) return;
  // Only completed buffers are eviction candidates: evicting a running task's
  // buffer would silently hole its transcript. If every buffer belongs to a
  // running task (unrealistic beyond ~24 concurrent), exceed the cap instead.
  let oldest: string | undefined;
  for (const [taskId, buffer] of buffers) {
    if (buffer.completed) {
      oldest = taskId;
      break;
    }
  }
  if (oldest !== undefined) {
    buffers.delete(oldest);
    cancelTaskLogCleanup(oldest);
  }
}

/** Returns the sequence assigned to the line (0 when nothing was stored). */
export function appendTaskLog(taskId: string, stage: string, line: string, now = Date.now()): number {
  if (!taskId || typeof line !== 'string') return 0;
  let buffer = buffers.get(taskId);
  if (!buffer) {
    evictIfNeeded();
    buffer = { lines: [], truncated: false, completed: false, lastAppendAt: now };
    buffers.set(taskId, buffer);
  } else {
    // Refresh LRU position and mark live again — a task id that logs after
    // completion (retry reusing the id) must not be reaped by a stale timer.
    buffers.delete(taskId);
    buffers.set(taskId, buffer);
    cancelTaskLogCleanup(taskId);
    buffer.lastAppendAt = now;
  }

  let text = line;
  if (text.length > TASK_LOG_MAX_LINE_CHARS) {
    text = `${text.slice(0, TASK_LOG_MAX_LINE_CHARS)}…`;
    buffer.truncated = true;
  }
  const seq = nextSeq++;
  buffer.lines.push({ stage, line: text, ts: now, seq });
  if (buffer.lines.length > TASK_LOG_RING_SIZE) {
    buffer.lines.shift();
    buffer.truncated = true;
  }
  return seq;
}

/** Snapshot copy (safe to serialize while appends continue). Null → 404. */
export function getTaskLog(taskId: string): TaskLogSnapshot | null {
  const buffer = buffers.get(taskId);
  if (!buffer) return null;
  return { taskId, lines: buffer.lines.slice(), truncated: buffer.truncated };
}

/** Called on task:completed — keep the transcript readable for a grace window. */
export function scheduleTaskLogCleanup(taskId: string, delayMs = TASK_LOG_RETENTION_MS): void {
  const buffer = buffers.get(taskId);
  if (!buffer) return;
  // Replace any prior timer directly — cancelTaskLogCleanup would also clear
  // the completed flag this function is about to set.
  const prior = cleanupTimers.get(taskId);
  if (prior) clearTimeout(prior);
  buffer.completed = true;
  const timer = setTimeout(() => {
    cleanupTimers.delete(taskId);
    // The completed flag is cleared whenever the task id came back to life —
    // never delete a buffer that has gone live again.
    if (buffers.get(taskId)?.completed) buffers.delete(taskId);
  }, delayMs);
  timer.unref?.();
  cleanupTimers.set(taskId, timer);
}

/** Called on task:started / new log lines — the task id is live (again). */
export function cancelTaskLogCleanup(taskId: string): void {
  const timer = cleanupTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(taskId);
  }
  const buffer = buffers.get(taskId);
  if (buffer) buffer.completed = false;
}

export function __resetTaskLogsForTests(): void {
  for (const timer of cleanupTimers.values()) clearTimeout(timer);
  cleanupTimers.clear();
  buffers.clear();
}
