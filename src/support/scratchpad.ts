/**
 * A working area for the worker that is not the code it is editing.
 *
 * Why this exists: an agent that needs somewhere to put a throwaway script or a
 * copy of a file before rewriting it has, today, exactly one option — the
 * worktree under review. Two such files reached open cgf-portal PRs on
 * 2026-09-17 (`_apply_edit.py` at the repository root and
 * `scripts/check_migration_immutability.py.bak`) and a person deleted each by
 * hand (AGT-4410). `isAgentScratchFile` in worktreeEphemeral.ts detects that
 * symptom; this module removes the cause.
 *
 * The second reason is memory. The worker is rebuilt from `WorkerOptions` on
 * every iteration, so nothing it wrote to itself survives the boundary — only
 * the framework-composed `previousFeedback` crosses. Notes kept here do cross,
 * including across a retry that throws the conversation away.
 *
 * Deliberately outside the worktree: anything under the worktree is diffed,
 * reviewed, and can reach a pull request, which is the bug being fixed.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Total bytes one run may keep. A budget, not a security boundary — the point
 * is that a looping agent cannot fill the disk, not that it cannot try.
 */
export const SCRATCHPAD_RUN_BYTE_CAP = 1024 * 1024;
/** One note. Small enough that a whole note still fits in a prompt section. */
export const SCRATCHPAD_NOTE_BYTE_CAP = 128 * 1024;
/** How much of the scratchpad is fed back into the next iteration's prompt. */
export const SCRATCHPAD_PROMPT_CHARS = 8_000;
/** A run's notes outlive it this long, so a parked task still has them on resume. */
export const SCRATCHPAD_RETENTION_DAYS = 14;
/** A sweep never touches this window, so a running task cannot lose its notes. */
const PRUNE_SAFETY_WINDOW_MS = 60 * 60_000;

export function scratchpadRoot(): string {
  return process.env.OPENSWARM_SCRATCHPAD_DIR ?? join(homedir(), '.openswarm', 'scratch');
}

/** Explicitly disabled with `OPENSWARM_SCRATCHPAD=0`; on otherwise. */
export function scratchpadEnabled(): boolean {
  return process.env.OPENSWARM_SCRATCHPAD !== '0';
}

/**
 * Filesystem-safe and never empty, so a path cannot collapse to its parent or
 * climb out of it. Run ids and note names are both agent- or issue-supplied,
 * which is to say untrusted.
 */
function safeSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

export function scratchpadDir(runId: string): string {
  return join(scratchpadRoot(), safeSegment(runId, 'adhoc'));
}

/** Notes keep a `.md` suffix so the directory reads as prose, not as code. */
function noteFile(runId: string, name: string): string {
  return join(scratchpadDir(runId), `${safeSegment(name, 'note')}.md`);
}

export async function ensureScratchpad(runId: string): Promise<string> {
  const dir = scratchpadDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface ScratchpadNote {
  name: string;
  bytes: number;
  modifiedAt: number;
}

export async function listNotes(runId: string): Promise<ScratchpadNote[]> {
  const dir = scratchpadDir(runId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const notes: ScratchpadNote[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const info = await stat(join(dir, entry)).catch(() => undefined);
    if (!info?.isFile()) continue;
    notes.push({ name: entry.slice(0, -3), bytes: info.size, modifiedAt: info.mtimeMs });
  }
  return notes.sort((a, b) => a.modifiedAt - b.modifiedAt);
}

/**
 * Thrown instead of shortening the content.
 *
 * A note that was silently half-saved reads to the next iteration exactly like
 * a whole one, so the agent acts on a truncated fact without knowing it did.
 * Refusing is louder and therefore safer. (The same rule vega-cli applies to
 * its memory budget: skip the item and name it.)
 */
export class ScratchpadBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScratchpadBudgetError';
  }
}

/**
 * Replace one note.
 *
 * The write goes to a temporary name and is renamed into place, so a reader
 * never sees a partial file and a refused write leaves the previous note
 * untouched.
 *
 * Concurrency: the budget check and the write are not atomic against each
 * other, so N concurrent writers can overshoot `SCRATCHPAD_RUN_BYTE_CAP` by at
 * most N × `SCRATCHPAD_NOTE_BYTE_CAP`. That is deliberate — a lock here would
 * serialise every note write to protect a number that only exists to stop
 * unbounded growth, and the rename keeps each individual file consistent.
 */
export async function writeNote(
  runId: string,
  name: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > SCRATCHPAD_NOTE_BYTE_CAP) {
    throw new ScratchpadBudgetError(
      `note "${name}" is ${bytes} bytes, over the ${SCRATCHPAD_NOTE_BYTE_CAP}-byte limit for one note. `
      + 'Nothing was written — split it, or keep only the part a later iteration needs.',
    );
  }

  const safeName = safeSegment(name, 'note');
  const existing = await listNotes(runId);
  const othersBytes = existing
    .filter((note) => note.name !== safeName)
    .reduce((sum, note) => sum + note.bytes, 0);
  if (othersBytes + bytes > SCRATCHPAD_RUN_BYTE_CAP) {
    throw new ScratchpadBudgetError(
      `this note would put the scratchpad at ${othersBytes + bytes} bytes, over the `
      + `${SCRATCHPAD_RUN_BYTE_CAP}-byte limit for one task. Nothing was written — `
      + 'delete a note you no longer need, or keep this one shorter.',
    );
  }

  const dir = await ensureScratchpad(runId);
  const target = join(dir, `${safeName}.md`);
  const staging = `${target}.writing`;
  await writeFile(staging, content, 'utf8');
  await rename(staging, target);
  return { path: target, bytes };
}

export async function readNote(runId: string, name: string): Promise<string | undefined> {
  return readFile(noteFile(runId, name), 'utf8').catch(() => undefined);
}

export async function deleteNote(runId: string, name: string): Promise<void> {
  await rm(noteFile(runId, name), { force: true });
}

/**
 * The prompt section the next iteration reads.
 *
 * Oldest first, so the newest thinking is nearest the end — the last thing a
 * model reads is the thing it weighs most (the same reason
 * `harnessBoundaryPrompt` is assembled last, AGT-4418). When the notes do not
 * fit, whole notes are dropped from the *oldest* end and the drop is named,
 * rather than any one note being cut in half.
 */
export async function renderNotesForPrompt(
  runId: string,
  budget = SCRATCHPAD_PROMPT_CHARS,
): Promise<string | undefined> {
  if (!scratchpadEnabled()) return undefined;
  const notes = await listNotes(runId);
  if (notes.length === 0) return undefined;

  const blocks: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const note of [...notes].reverse()) {
    const body = await readNote(runId, note.name);
    if (body === undefined) continue;
    const block = `### ${note.name}\n${body.trimEnd()}`;
    if (used + block.length > budget && blocks.length > 0) {
      dropped += 1;
      continue;
    }
    blocks.unshift(block);
    used += block.length;
  }
  if (blocks.length === 0) return undefined;

  const omitted = dropped > 0
    ? `\n\n_${dropped} older note${dropped === 1 ? '' : 's'} left out of this prompt to stay inside the budget; `
      + 'they are still on the scratchpad and `scratch_read` will fetch one by name._'
    : '';
  return '## Your notes from earlier in this task\n'
    + 'You wrote these on an earlier iteration. They are yours, not the reviewer\'s — '
    + 'trust them as much as you would trust your own recollection, and correct them '
    + `with \`scratch_write\` when they turn out to be wrong.\n\n${blocks.join('\n\n')}${omitted}`;
}

/** Called when a run reaches a terminal state. A parked run keeps its notes. */
export async function clearScratchpad(runId: string): Promise<void> {
  await rm(scratchpadDir(runId), { recursive: true, force: true });
}

/**
 * Drop the scratchpads of runs that have gone quiet.
 *
 * This is the backstop, not the primary cleanup: a task that finishes clears
 * its own notes. A task that was parked for a person, abandoned, or killed
 * mid-flight never reaches that call, and its notes would otherwise sit there
 * forever. The safety window keeps a live run's notes out of reach of a sweep
 * that happens to land between two of its iterations.
 */
export function pruneScratchpads(
  retentionDays = SCRATCHPAD_RETENTION_DAYS,
  root = scratchpadRoot(),
  now = Date.now(),
): number {
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  let runDirs: string[];
  try {
    runDirs = readdirSync(root);
  } catch {
    return 0; // Nothing written yet.
  }
  for (const runDir of runDirs) {
    const full = join(root, runDir);
    try {
      // The directory's own mtime moves whenever a note is added or replaced,
      // so it is the freshest signal for the run as a whole.
      const mtime = statSync(full).mtimeMs;
      if (mtime >= cutoff || now - mtime < PRUNE_SAFETY_WINDOW_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}
