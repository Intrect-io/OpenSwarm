// OpenSwarm ADE workspace — view model.
//
// Pure functions only: no DOM, no Tauri, no clock unless passed in. app.js
// owns I/O and rendering; everything here is what the workspace decides about
// the daemon's data, so it is unit-tested (tests/desktop/adeModel.test.ts).

/** Cap on transcript lines kept per session in the page (the daemon keeps 1000). */
export const LOG_CAP = 2000;

const ACTIVE_ORDER = { running: 0, queued: 1 };

/**
 * One list of sessions from `/api/work/sessions`: running (newest first),
 * then queued, then recent (newest first). Rows keep only what the list shows.
 */
export function sessionRows(response) {
  const active = (response?.sessions ?? []).map((s) => ({
    taskId: s.taskId,
    title: s.title || s.taskId,
    issue: s.issueIdentifier ?? '',
    status: s.status === 'queued' ? 'queued' : 'running',
    stage: s.stage ?? '',
    model: s.model ?? '',
    branch: s.branch ?? '',
    project: projectName(s.projectPath),
    at: s.startedAt ?? 0,
    live: true,
  }));
  active.sort((a, b) => ACTIVE_ORDER[a.status] - ACTIVE_ORDER[b.status] || b.at - a.at);
  const recent = (response?.recent ?? []).map((r) => ({
    taskId: r.taskId,
    title: r.title || r.taskId,
    issue: r.issueIdentifier ?? '',
    status: r.status,
    finalStatus: r.finalStatus ?? '',
    stage: '',
    model: '',
    branch: '',
    project: projectName(r.projectPath),
    at: r.completedAt ?? 0,
    costUsd: typeof r.costUsd === 'number' ? r.costUsd : undefined,
    failureCause: r.failureCause ?? '',
    live: false,
  }));
  recent.sort((a, b) => b.at - a.at);
  // A task can be both running again and in the recent list; the live row wins.
  const seen = new Set(active.map((row) => row.taskId));
  return [...active, ...recent.filter((row) => !seen.has(row.taskId))];
}

/** Last path segment, for a compact project label. */
export function projectName(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Merge transcript lines by their daemon sequence number: duplicates (a live
 * line that is also in the next snapshot) collapse, order follows `seq`, and
 * only the newest `cap` lines are kept. Lines from another daemon generation
 * replace the old ones — sequences only mean anything within one process.
 */
export function mergeLog(current, incoming, cap = LOG_CAP) {
  const generation = incoming.find((l) => l.gen)?.gen;
  const base = generation && current.some((l) => l.gen && l.gen !== generation)
    ? []
    : current;
  const bySeq = new Map();
  for (const line of [...base, ...incoming]) {
    if (typeof line?.seq !== 'number') continue;
    bySeq.set(line.seq, line);
  }
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Lines of a `/api/work/sessions/:id/log` snapshot, tagged with its generation. */
export function snapshotLines(snapshot) {
  const gen = snapshot?.gen;
  return (snapshot?.lines ?? []).map((l) => ({ ...l, gen }));
}

/** The transcript line a relayed `log` event carries for `taskId`, or null. */
export function logLineFromEvent(event, taskId) {
  if (event?.type !== 'log' || !event.data || event.data.taskId !== taskId) return null;
  const { stage, line, ts, seq, gen } = event.data;
  if (typeof seq !== 'number') return null;
  return { stage: stage ?? '', line: line ?? '', ts: ts ?? 0, seq, gen };
}

/** Whether an event changes the session list (a task started, finished, changed stage). */
export function eventChangesSessions(event) {
  return ['task:queued', 'task:started', 'task:completed', 'pipeline:stage'].includes(event?.type);
}

/**
 * A unified diff split per file, each line classified for rendering.
 * `meta` = the `diff --git`/index/---/+++ header, `hunk` = `@@ … @@`.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(raw);
      file = { path: match ? match[1] : raw.slice(11), additions: 0, deletions: 0, lines: [] };
      files.push(file);
      file.lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('@@')) file.lines.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ')
      || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity')
      || raw.startsWith('rename ') || raw.startsWith('Binary files')) {
      file.lines.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      file.additions++;
      file.lines.push({ kind: 'add', text: raw });
    } else if (raw.startsWith('-')) {
      file.deletions++;
      file.lines.push({ kind: 'del', text: raw });
    } else if (raw !== '' || file.lines.length > 0) {
      file.lines.push({ kind: 'ctx', text: raw });
    }
  }
  // A trailing empty context line is the split's artefact, not content.
  for (const f of files) {
    while (f.lines.length && f.lines[f.lines.length - 1].kind === 'ctx' && f.lines[f.lines.length - 1].text === '') f.lines.pop();
  }
  return files;
}

// Every durable RunState (src/automation/runLedgerTypes.ts RUN_STATES).
const RUN_TONE = {
  CLAIMED: 'live', EXECUTING: 'live', VERIFYING: 'live', PUBLISHING: 'live', SYNC_PENDING: 'live',
  DISCOVERED: 'idle', READY: 'idle', CANCELLED: 'idle',
  DONE: 'ok', DECOMPOSED: 'ok',
  RETRY_AT: 'warn', WAITING_EXTERNAL: 'warn', NEEDS_RECONCILE: 'warn',
  NEEDS_SPEC: 'bad', NEEDS_ENV: 'bad', NEEDS_HUMAN: 'bad',
};

/**
 * The verdict line for `/api/automation/runs/:id`: the durable state, a tone
 * for colour, and the one reason a person needs (why it is parked, when it
 * retries, or where the PR is).
 */
export function summarizeRun(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return { state: 'UNKNOWN', tone: 'idle', detail: 'No durable run record' };
  const state = String(run.state ?? 'UNKNOWN');
  const tone = RUN_TONE[state] ?? 'idle';
  let detail = '';
  const reason = run.lastErrorMessage ?? run.lastErrorCode;
  if (state === 'RETRY_AT' && typeof run.retryAt === 'number') {
    detail = run.retryAt > now ? `retries in ${formatDuration(run.retryAt - now)}` : 'retry due';
  } else if (reason) {
    detail = String(reason);
  } else if (run.prUrl) {
    detail = String(run.prUrl);
  }
  return {
    state,
    tone,
    detail,
    attempt: typeof run.attemptNo === 'number' ? run.attemptNo : undefined,
    prUrl: safeExternalUrl(run.prUrl) ?? undefined,
  };
}

/** `1h 4m`, `3m 12s`, `45s` — the precision a glance needs. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Relative age for list rows: `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function formatAge(at, now = Date.now()) {
  if (!at) return '';
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

/** Only http(s) PR/issue links leave the app; anything else is not a link. */
export function safeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const VERIFY_STAGE = /^(?:tester|test|verify|verification|deterministic)/i;
const VERIFY_FAIL = /\b(?:fail(?:ed|ure)?|error|✗|×)\b/i;
const VERIFY_PASS = /\b(?:pass(?:ed)?|ok|✓|green)\b/i;

/**
 * The verification part of a transcript: lines from the tester/verify stages,
 * newest `limit`, each classified as pass / fail / info for colour.
 */
export function verificationLines(lines, limit = 40) {
  const picked = lines.filter((l) => VERIFY_STAGE.test(l.stage ?? ''));
  return picked.slice(-limit).map((l) => ({
    seq: l.seq,
    text: l.line,
    kind: VERIFY_FAIL.test(l.line) ? 'fail' : VERIFY_PASS.test(l.line) ? 'pass' : 'info',
  }));
}
