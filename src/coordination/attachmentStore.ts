// ============================================
// OpenSwarm - Operator chat attachments
// ============================================
//
// Handing an agent a file used to mean placing it on the host by hand and
// describing the path in prose (AGT-4025 did exactly that, by shell, for one
// repository). This is that, as a first-class action from the chat room.
//
// Everything about the layout is a containment decision. Bytes land under the
// daemon's own state directory — already a mounted volume, so an upload
// survives a container recreate — and never inside a repository, where a build
// could run them or a commit could carry them. The stored name is generated
// here; the client's filename is metadata, kept only so the operator and the
// agent can see what it was called.

import { randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { coordinationStateDir } from './coordinationPaths.js';

/** Ceiling for one upload. Large enough for a spreadsheet or an export, small
 *  enough that a drag-and-drop cannot fill the volume the daemon writes its
 *  own state to — the worktrees share it. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** How long an attachment is kept before the sweep may remove it. */
const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How long a freshly stored file is off-limits to the budget sweep.
 *
 * The in-flight exemption ends when an upload's promise resolves, but the message
 * naming that file is posted only after every attachment in it has uploaded — and
 * the agent reads it later still. So when a moved ceiling puts the store over
 * budget, the files to spend are the old ones, never the ones a message is about
 * to point at. A minute covers composing one message and is nothing against the
 * 30-day retention.
 */
const DEFAULT_GRACE_MS = 60_000;

/**
 * Overridable for the same reason the ceiling is: the right window depends on
 * the deployment. A larger ceiling can afford a longer one.
 */
function recentUploadGraceMs(): number {
  const raw = Number.parseInt(process.env.OPENSWARM_ATTACHMENT_GRACE_MS ?? '', 10);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS;
}

/**
 * Ceiling for everything stored at once.
 *
 * The per-upload cap bounds one file; without this, repeated valid uploads
 * inside the retention window still fill the volume the daemon writes its state
 * to, and every worktree shares it. Overridable because the right number
 * depends on the deployment's disk — vela has terabytes, a laptop does not.
 */
export function maxAttachmentTotalBytes(): number {
  const raw = Number.parseInt(process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES ?? '', 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_TOTAL_BYTES;
}

export interface StoredAttachment {
  id: string;
  /** The name the operator's file had. Display only — never a path component. */
  filename: string;
  bytes: number;
  /** Absolute path inside the daemon's filesystem, for the agent to open. */
  path: string;
}

/**
 * Uploads whose bytes are on disk but whose path has not been handed back yet.
 *
 * Admission keeps the store under its ceiling, so reclamation normally has only
 * aged files to consider. The exception is a ceiling that moves: it is read live,
 * so tightening it puts a full store over budget at once, and the sweep that
 * follows would otherwise be free to take a file that is still being written.
 * The operator would be handed a path to nothing.
 */
const inFlight = new Set<string>();

/**
 * Bytes written by uploads that have not finished yet.
 *
 * The ceiling has to hold while bytes are arriving, not only once they have
 * landed: any number of uploads can stream at once, and each is allowed a whole
 * file, so checking only after the write would let concurrent requests put the
 * shared volume far past the limit before anything noticed.
 */
let inFlightBytes = 0;

/**
 * Bytes of files that have finished uploading, as of the last sweep plus what
 * has settled since.
 *
 * Kept live rather than snapshotted per request: a request that read the total
 * once and held it would still be enforcing against that number long after other
 * uploads settled, and staggered requests would each believe there was room.
 */
let settledBytes = 0;

export function attachmentsRoot(): string {
  return join(coordinationStateDir(), 'attachments');
}

/**
 * A task id as a single safe directory name.
 *
 * Task ids are issue UUIDs today, but the value arrives over HTTP, so it is
 * treated as hostile: anything outside the allowed set collapses to `-`, which
 * cannot climb out of the attachments root however it was crafted.
 */
function taskSegment(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return cleaned || 'unscoped';
}

/**
 * The client's filename, reduced to something displayable.
 *
 * Separators and traversal are stripped rather than escaped: this value is
 * never joined into a path — the stored file is named by a generated id — so
 * the only job here is to keep it readable and free of characters that would
 * confuse a shell or a Markdown line if an agent echoes it back.
 */
export function displayFilename(raw: string | undefined): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\r\n\t`"'|$();&<>*?[\]{}!#]+/g, ' ').replace(/\.{2,}/g, '.').trim().slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * Stream a request body into the attachment directory.
 *
 * Streaming rather than buffering is the point: `readBody` caps a JSON body at
 * 1 MiB and holds it as a string, which is both too small for a real file and
 * the wrong shape for one. The cap is enforced as bytes arrive, so an oversized
 * upload is refused without ever being held in memory or fully written.
 */
export async function storeAttachment(
  req: IncomingMessage,
  input: { taskId: string; filename?: string },
): Promise<StoredAttachment> {
  const directory = await realAttachmentsRoot();

  const filename = displayFilename(input.filename);
  const id = randomUUID();
  // The extension is carried so an agent (and the operator's browser) can tell
  // what the file is; the name itself is ours.
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(filename)?.[1] ?? '';
  // The task is a prefix on the name rather than a directory of its own. A
  // directory would be a second predictable, agent-writable path component for
  // every read, write and delete below to traverse — and nothing here needs one.
  const stored = `${taskSegment(input.taskId)}__${id}${extension ? `.${extension.toLowerCase()}` : ''}`;
  const target = join(directory, stored);

  // Reclaim what is eligible and re-measure, before a byte is written. The write
  // then enforces against the live counters, which every other upload is
  // updating too.
  await enforceTotalBudget();

  inFlight.add(target);
  try {
    const attachment = await write(req, target, { id: stored, filename });
    // The root was a real directory when we checked; confirm it still is, so a
    // swap that outlasts the write is caught rather than silently writing the
    // operator's file somewhere else and reporting success.
    try {
      await assertRealDirectory(directory);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return attachment;
  } finally {
    inFlight.delete(target);
  }
}

/** The write itself, so the in-flight registration above has one exit point. */
async function write(
  req: IncomingMessage,
  target: string,
  named: { id: string; filename: string },
): Promise<StoredAttachment> {
  let bytes = 0;
  try {
    const attachment = await streamToDisk();
    // The bytes stop being a reservation and become part of the store in one
    // step, so no other upload can observe a moment where they are in neither
    // count and both believe there is room.
    inFlightBytes = Math.max(0, inFlightBytes - bytes);
    settledBytes += bytes;
    return attachment;
  } catch (error) {
    // Refused or failed: the file is gone, so the reservation simply lapses.
    inFlightBytes = Math.max(0, inFlightBytes - bytes);
    throw error;
  }

  async function streamToDisk(): Promise<StoredAttachment> {
  await new Promise<void>((settle, fail) => {
    // `wx` is O_CREAT|O_EXCL, which POSIX requires to fail on a symlink, so the
    // file itself cannot be redirected either — and a name we have already used
    // is never silently overwritten.
    const sink = createWriteStream(target, { mode: 0o600, flags: 'wx' });
    let settled = false;
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      inFlightBytes += chunk.length;
      if (bytes > MAX_ATTACHMENT_BYTES) {
        abort(new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`));
      } else if (settledBytes + inFlightBytes > maxAttachmentTotalBytes()) {
        // Refusing is the only outcome that neither breaks the bound nor deletes
        // a file the operator is in the middle of referencing. They are told
        // why; an evicted attachment would just be a path to nothing.
        abort(new Error('Attachment storage is full — retry once older attachments expire'));
      }
    };
    const abort = (error: Error) => {
      if (settled) return;
      settled = true;
      // Stop reading, not only writing. `unpipe` does pause the request today,
      // but only as a side effect of removing its last pipe — nothing in the
      // stream contract promises that, and it stops helping the moment anything
      // here writes to the sink without piping. Dropping the listener and
      // pausing says it outright. The socket itself stays intact for the route
      // to answer 413 on; Node discards it once that response is out, because
      // the body was never consumed.
      req.off('data', onData);
      req.unpipe(sink);
      req.pause();
      // Remove the partial file before reporting the refusal, and only once the
      // sink's descriptor is closed: Windows will not unlink a file that still
      // has an open handle, and on POSIX an un-awaited removal loses the race
      // against the caller observing the rejection. Either way what survives is
      // a truncated file an agent could read as though it were whole.
      const cleared = once(sink, 'close')
        .catch(() => undefined)
        .then(() => rm(target, { force: true }))
        .catch(() => undefined);
      sink.destroy();
      cleared.then(() => fail(error));
    };
    req.on('data', onData);
    req.on('error', abort);
    sink.on('error', abort);
    sink.on('finish', () => { if (!settled) { settled = true; settle(); } });
    req.pipe(sink);
  });

  if (bytes === 0) {
    await rm(target, { force: true });
    throw new Error('Attachment was empty');
  }
  return { id: named.id, filename: named.filename, bytes, path: target };
  }
}



/**
 * Drop attachments past their TTL.
 *
 * The volume is shared with every worktree, so uploads cannot accumulate
 * forever; a caller runs this on the daemon's own schedule.
 */
/**
 * The attachments root, created if missing and refused if it is not a real
 * directory.
 *
 * This is where the store's own tree begins, and its name is fixed, so it is
 * the level an agent would plant a link at to redirect every upload at once.
 * Above it lies the daemon's own state directory: if that can be replaced there
 * is nothing left to defend, so the boundary is drawn here.
 */
async function realAttachmentsRoot(): Promise<string> {
  const root = attachmentsRoot();
  await mkdir(root, { recursive: true });
  // The root's own name is fixed, so a link *at* it would redirect every upload
  // at once; above it lies the daemon's state directory, where a link is the
  // host's business and not something to refuse over.
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('Attachment storage root is not a directory');
  }
  return root;
}

/**
 * The task directory is a directory and not a link standing in for one.
 *
 * `lstat` answers about the name itself, which is the whole question here: the
 * directory sits one level under the root, so a link at that name is the only
 * redirection an agent can introduce below it. Resolving the path with
 * `realpath` instead would also flag ancestors — `/var` is a link to
 * `/private/var` on macOS, and home directories are often links — and refuse
 * every upload on those hosts while catching nothing extra.
 *
 * Nothing here holds across the `open` that follows: Node exposes no `openat`,
 * so a swap inside that window is invisible while it happens, and the caller
 * checks again afterwards and discards the file if the ground moved. The
 * boundary is deliberate — an actor that can win that race is already writing
 * inside the daemon's state directory as the daemon's user, and so already holds
 * everything the race would win.
 */
async function assertRealDirectory(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error('Attachment directory is not a directory');
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false; // missing, or gone between the check and the call
  }
}

/**
 * Plain files directly inside the store — links and anything else skipped.
 *
 * `readdir` with file types answers from the entry itself, so a link is never
 * followed, and every path handed to `rm` below is one level under a directory
 * checked immediately above. With no per-task directories there is no second
 * component for a swap to aim at.
 */
async function realFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
  } catch {
    return []; // vanished between listing and reading
  }
}

/** Every stored attachment with its size and age, newest last. */
async function listStored(): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const root = attachmentsRoot();
  if (!isRealDirectory(root)) return [];
  const files: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const file of await realFiles(root)) {
    try {
      const info = await lstat(file);
      files.push({ path: file, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      continue; // already gone
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Reclaim space when the store is over its total ceiling, oldest first.
 *
 * Runs after every upload rather than only on the daily sweep: the bound has to
 * hold against a client that uploads faster than the schedule, which is exactly
 * the case a per-file cap alone does not cover.
 */
let budgetQueue: Promise<unknown> = Promise.resolve();

interface BudgetOutcome {
  /** Files reclaimed on this pass. */
  removed: number;
  /** What the store holds afterwards — the number an admission decision needs. */
  total: number;
}

async function enforceTotalBudget(now = Date.now()): Promise<BudgetOutcome> {
  // Serialized: two uploads finishing together would each measure the store
  // before the other's bytes were counted, both conclude they fit, and the
  // ceiling would hold for neither. Chaining makes the measurement and the
  // reclamation one step, so every upload sees the store the previous one left.
  const run = budgetQueue.then(() => reclaimOverBudget(now), () => reclaimOverBudget(now));
  budgetQueue = run.catch(() => undefined);
  return run;
}

/**
 * Reclaims oldest-first, skipping uploads that are still in flight or still
 * inside the grace window. If everything is protected the store stays over
 * budget until the window passes — the next upload or the daily sweep corrects
 * it, and that is the better end of the trade against deleting a file the
 * operator is in the middle of sending.
 */
async function reclaimOverBudget(now = Date.now()): Promise<BudgetOutcome> {
  const files = await listStored();
  // In-flight files are on disk but counted by `inFlightBytes`; counting them
  // here as well would refuse uploads that do fit.
  let total = files.reduce((sum, file) => (inFlight.has(file.path) ? sum : sum + file.bytes), 0);
  let removed = 0;
  for (const file of files) {
    if (total + inFlightBytes <= maxAttachmentTotalBytes()) break;
    if (inFlight.has(file.path)) continue;
    if (now - file.mtimeMs < recentUploadGraceMs()) continue;
    try {
      await rm(file.path, { force: true });
      total -= file.bytes;
      removed += 1;
    } catch {
      continue; // already gone; its bytes are no longer ours to count
    }
  }
  settledBytes = total;
  return { removed, total };
}

export async function pruneAttachments(now = Date.now()): Promise<number> {
  const root = attachmentsRoot();
  if (!isRealDirectory(root)) return 0;
  let removed = 0;
  for (const file of await realFiles(root)) {
    try {
      const info = await lstat(file);
      if (now - info.mtimeMs > ATTACHMENT_TTL_MS) {
        await rm(file, { force: true });
        removed += 1;
      }
    } catch {
      continue; // already gone
    }
  }
  return removed + (await enforceTotalBudget(now)).removed;
}
