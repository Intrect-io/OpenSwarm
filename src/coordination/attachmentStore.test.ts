import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  attachmentsRoot,
  displayFilename,
  MAX_ATTACHMENT_BYTES,
  maxAttachmentTotalBytes,
  pruneAttachments,
  storeAttachment,
} from './attachmentStore.js';

const ORIGINAL = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';

afterEach(() => {
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL;
  delete process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES;
  delete process.env.OPENSWARM_ATTACHMENT_GRACE_MS;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function stateAt(): void {
  dir = mkdtempSync(join(tmpdir(), 'osw-attach-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
}

/** A request body as a stream, which is how the route hands it over. */
function body(content: Buffer | string): IncomingMessage {
  return Readable.from([Buffer.from(content)]) as unknown as IncomingMessage;
}

describe('attachment storage (AGT-4031)', () => {
  it('writes the bytes and reports where the agent can open them', async () => {
    stateAt();
    const stored = await storeAttachment(body('bank export,rows\n1,2\n'), {
      taskId: 'task-1', filename: 'A2-bank.csv',
    });

    expect(stored.filename).toBe('A2-bank.csv');
    expect(stored.bytes).toBe(21);
    expect(readFileSync(stored.path, 'utf8')).toContain('bank export');
    // Under the daemon's state directory — a mounted volume — and never in a repo.
    expect(stored.path.startsWith(attachmentsRoot())).toBe(true);
  });

  it('names the stored file itself, keeping the operator\'s name as metadata only', async () => {
    stateAt();
    const stored = await storeAttachment(body('x'), {
      taskId: 'task-2', filename: '../../etc/passwd',
    });

    // The traversal survives nowhere: not in the path, and not as a directory.
    expect(stored.path.includes('..')).toBe(false);
    expect(stored.path.startsWith(join(attachmentsRoot(), 'task-2__'))).toBe(true);
    expect(stored.filename).not.toContain('/');
  });

  it('keeps a crafted task id inside the attachments root', async () => {
    stateAt();
    const stored = await storeAttachment(body('x'), {
      taskId: '../../../tmp/escape', filename: 'note.txt',
    });
    expect(relative(attachmentsRoot(), stored.path).startsWith('..')).toBe(false);
    expect(stored.path).not.toContain('..');
  });

  it('refuses an oversized upload without keeping a partial file', async () => {
    stateAt();
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x61);

    await expect(storeAttachment(body(oversized), { taskId: 't-big', filename: 'huge.bin' }))
      .rejects.toThrow(/exceeds/);

    // A half-written file would be worse than the refusal: an agent could read it
    // and act on truncated data, so nothing of it may survive.
    expect(readdirSync(attachmentsRoot())).toHaveLength(0);
  });

  it('stops reading the request once the cap is exceeded', async () => {
    stateAt();
    // A client that ignores the refusal and keeps sending. Refusing the write
    // is not enough on its own: the 'data' listener holds the request in
    // flowing mode, so without tearing the read side down too we would go on
    // consuming everything it sent, long past the cap.
    const chunk = Buffer.alloc(1024 * 1024, 0x65);
    let produced = 0;
    const flood = new Readable({
      read() {
        produced += 1;
        this.push(produced > 512 ? null : chunk);
      },
    }) as unknown as IncomingMessage;

    await expect(storeAttachment(flood, { taskId: 't-abort', filename: 'flood.bin' }))
      .rejects.toThrow(/exceeds/);
    // Give the loop room to keep draining, so this pins the stream state and
    // not the instant the rejection happened to be observed.
    await new Promise((settle) => setTimeout(settle, 50));

    // The cap is 64 MiB, so roughly 65 one-mebibyte chunks reach us before the
    // refusal. Draining all 512 would mean the abort only stopped the write.
    expect(produced).toBeLessThan(128);
  });

  it('refuses an empty upload', async () => {
    stateAt();
    await expect(storeAttachment(body(''), { taskId: 't-empty', filename: 'nothing.txt' }))
      .rejects.toThrow(/empty/);
  });

  it('leaves an upload in flight alone even when the sweep would expire it', async () => {
    stateAt();
    // The retention branch is time-based, and the clock is not a guarantee. An
    // upload still streaming must survive a sweep whatever the sweep believes
    // the date to be, or it resolves with a path that is already gone.
    const stalled = new Readable({ read() {} });
    const slow = storeAttachment(stalled as unknown as IncomingMessage,
      { taskId: 't-live-ttl', filename: 'slow.bin' });
    (stalled as Readable).push(Buffer.from('partial'));
    await new Promise((settle) => setTimeout(settle, 20));

    // Sweep from far enough ahead that everything on disk looks expired.
    expect(await pruneAttachments(Date.now() + 60 * 24 * 60 * 60 * 1000)).toBe(0);

    (stalled as Readable).push(null);
    const stored = await slow;
    expect(existsSync(stored.path)).toBe(true);
  });

  it('prunes past the retention window and leaves fresh files alone', async () => {
    stateAt();
    const fresh = await storeAttachment(body('keep me'), { taskId: 't-ttl', filename: 'fresh.txt' });

    // Age a second file rather than sweeping from the future: sweeping forward
    // would expire the fresh one too, and the test would pass while proving
    // nothing about what is kept.
    const stale = join(attachmentsRoot(), 't-ttl__stale-file.txt');
    writeFileSync(stale, 'old');
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);

    expect(await pruneAttachments()).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
  });
});

describe('links planted in the store (AGT-4031)', () => {
  it('refuses to store or sweep through a symlinked attachments root', async () => {
    stateAt();
    // The root's name is fixed, so it is the one place a link redirects every
    // upload at once — and the per-task check above would pass, since the far
    // end really is a directory.
    const outside = join(dir, 'somewhere-else');
    mkdirSync(outside, { recursive: true });
    const precious = join(outside, 'keep.txt');
    writeFileSync(precious, 'not ours to delete');
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(precious, longAgo, longAgo);
    symlinkSync(outside, attachmentsRoot());

    await expect(storeAttachment(body('x'), { taskId: 't-root', filename: 'a.txt' }))
      .rejects.toThrow(/not a directory/);
    expect(await pruneAttachments()).toBe(0);
    expect(existsSync(precious)).toBe(true);
  });

  it('keeps every attachment in one directory, with the task as a name prefix', async () => {
    stateAt();
    // A per-task directory would be a second predictable, agent-writable path
    // component for every read, write and delete to traverse — and a swap there
    // could aim the sweep's `rm` outside the store. There is nothing to aim at
    // when the task is part of the name.
    const first = await storeAttachment(body('a'), { taskId: 'task-a', filename: 'x.txt' });
    const second = await storeAttachment(body('b'), { taskId: 'task-b', filename: 'y.txt' });

    expect(readdirSync(attachmentsRoot(), { withFileTypes: true }).every((e) => e.isFile())).toBe(true);
    expect(relative(attachmentsRoot(), first.path).includes('/')).toBe(false);
    expect(relative(attachmentsRoot(), second.path).includes('/')).toBe(false);
  });

  it('does not walk a directory planted in the store', async () => {
    stateAt();
    // The store sits in the daemon's state directory, which agents can write to.
    // A link to a tree left there would otherwise hand the TTL sweep somebody
    // else's files — and `rm` through a link deletes the file at the far end.
    const outside = join(dir, 'not-ours');
    mkdirSync(outside, { recursive: true });
    const precious = join(outside, 'source.ts');
    writeFileSync(precious, 'export const value = 1;');
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(precious, longAgo, longAgo);

    mkdirSync(attachmentsRoot(), { recursive: true });
    symlinkSync(outside, join(attachmentsRoot(), 'looks-like-an-attachment'));

    expect(await pruneAttachments()).toBe(0);
    expect(existsSync(precious)).toBe(true);
  });

  it('does not follow a symlinked file in the store', async () => {
    stateAt();
    const outside = join(dir, 'elsewhere.txt');
    writeFileSync(outside, 'not an attachment');
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(outside, longAgo, longAgo);

    const directory = attachmentsRoot();
    mkdirSync(directory, { recursive: true });
    symlinkSync(outside, join(directory, 't-link__aged.txt'));

    expect(await pruneAttachments()).toBe(0);
    expect(existsSync(outside)).toBe(true);
  });

});

describe('total storage budget (AGT-4031)', () => {
  it('is a real ceiling by default, not a per-file one', () => {
    // The per-upload cap bounds one file; repeated valid uploads inside the
    // retention window would otherwise fill the volume the daemon shares with
    // every worktree.
    expect(maxAttachmentTotalBytes()).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
  });

  it('reclaims the oldest attachments when the store is over budget', async () => {
    stateAt();
    const directory = attachmentsRoot();
    mkdirSync(directory, { recursive: true });
    // Seed past the ceiling with three files of descending age.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(3 * 1024);
    const chunk = Buffer.alloc(2 * 1024, 0x62);
    for (const [index, name] of ['oldest.bin', 'middle.bin', 'newest.bin'].entries()) {
      const file = join(directory, name);
      writeFileSync(file, chunk);
      const when = new Date(Date.now() - (10 - index) * 60_000);
      utimesSync(file, when, when);
    }

    // Any upload enforces the budget, so this one both lands and triggers it.
    const stored = await storeAttachment(body('newcomer'), { taskId: 't-budget', filename: 'new.txt' });

    expect(existsSync(join(directory, 'oldest.bin'))).toBe(false);
    expect(existsSync(stored.path)).toBe(true);
  });

  it('refuses the attachment that does not fit instead of evicting the ones already sent', async () => {
    stateAt();
    // Three attachments on one message into a store that fits two. Each is
    // settled before the next arrives, so reclaiming oldest-first would take the
    // earlier ones — and the message naming all three is posted only after the
    // last upload, so the operator would be left holding paths to nothing.
    // Refusing the third says so plainly instead.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(2 * 1024);
    const chunk = Buffer.alloc(1024, 0x63);

    const first = await storeAttachment(body(chunk), { taskId: 't-burst', filename: 'a.bin' });
    const second = await storeAttachment(body(chunk), { taskId: 't-burst', filename: 'b.bin' });
    await expect(storeAttachment(body(chunk), { taskId: 't-burst', filename: 'c.bin' }))
      .rejects.toThrow(/storage is full/);

    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    // And the refused upload leaves nothing of itself behind.
    expect(readdirSync(attachmentsRoot())).toHaveLength(2);
  });

  it('never lets the store exceed its ceiling, however fast uploads arrive', async () => {
    stateAt();
    // The bound is what stops the daemon's state volume — shared with every
    // worktree — from being filled by an authorized client that simply uploads
    // faster than any sweep runs.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(4 * 1024);
    const chunk = Buffer.alloc(1024, 0x63);

    let refused = 0;
    for (const index of [0, 1, 2, 3, 4, 5]) {
      await storeAttachment(body(chunk), { taskId: 't-settle', filename: `part-${index}.bin` })
        .catch(() => { refused += 1; });
    }

    const root = attachmentsRoot();
    const sizes = readdirSync(root).map((entry) => statSync(join(root, entry)).size);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(maxAttachmentTotalBytes());
    // Four fit and were kept; the rest were told so rather than displacing them.
    expect(sizes.length).toBe(4);
    expect(refused).toBe(2);
  });

  it('does not clear out recent attachments when the ceiling is lowered under them', async () => {
    stateAt();
    // The ceiling is read live, so tightening it puts an already-full store over
    // budget at once. Reclaiming oldest-first would then delete attachments the
    // operator sent moments ago and the agents are still reading.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(4 * 1024);
    const chunk = Buffer.alloc(1024, 0x63);
    const sent = [];
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      sent.push(await storeAttachment(body(chunk), { taskId: 't-tighten', filename: name }));
    }

    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(1024);
    await expect(storeAttachment(body(chunk), { taskId: 't-tighten', filename: 'd.bin' }))
      .rejects.toThrow(/storage is full/);

    expect(sent.map((stored) => existsSync(stored.path))).toEqual([true, true, true]);
  });

  it('dates a file from when it became an attachment, not from its last byte', async () => {
    stateAt();
    // A client can send everything at once and hold the connection open. Timing
    // the grace window from the bytes would put such a file outside it the
    // moment it settled — reclaimable before the message naming it is published.
    process.env.OPENSWARM_ATTACHMENT_GRACE_MS = '60';

    const stalled = new Readable({ read() {} });
    const slow = storeAttachment(stalled as unknown as IncomingMessage,
      { taskId: 't-late', filename: 'early-bytes.bin' });
    (stalled as Readable).push(Buffer.alloc(512, 0x63));
    await new Promise((settle) => setTimeout(settle, 150));
    (stalled as Readable).push(null);
    const stored = await slow;

    // Everything else is over the ceiling, so the sweep will take what it can.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = '1';
    await pruneAttachments();
    expect(existsSync(stored.path)).toBe(true);
  });

  it('protects an upload that is still streaming after its grace window lapses', async () => {
    stateAt();
    // The grace window is keyed on the file's age, so a slow upload outlives its
    // own protection while its bytes are still arriving. Only the in-flight
    // registry covers that: without it a sweep triggered by a faster upload
    // reclaims the file this one is about to return.
    // Room for two while the slow upload starts, then the ceiling is tightened
    // under it, so the next upload's sweep finds the store over budget with the
    // still-open file as its oldest candidate.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(2 * 1024);
    process.env.OPENSWARM_ATTACHMENT_GRACE_MS = '20';
    const chunk = Buffer.alloc(1024, 0x63);

    let release = () => {};
    const stalled = new Readable({ read() {} }) as unknown as IncomingMessage;
    const slow = storeAttachment(stalled, { taskId: 't-slow', filename: 'slow.bin' });
    (stalled as unknown as Readable).push(chunk);
    await new Promise<void>((settle) => { release = settle; setTimeout(settle, 120); });
    release();

    // A second upload lands while the first is still open, and sweeps.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(512);
    await storeAttachment(body(chunk), { taskId: 't-slow', filename: 'fast.bin' })
      .catch(() => undefined);
    (stalled as unknown as Readable).push(null);

    const stored = await slow;
    expect(existsSync(stored.path)).toBe(true);
  });

  it('never hands back a path a concurrent upload already reclaimed', async () => {
    stateAt();
    // Six uploads, room for four. Whichever ones succeed must come back with a
    // path that is actually there: exempting only the upload that triggered a
    // sweep leaves every other in-flight file fair game, and measured that way
    // this failed on every attempt.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = String(4 * 1024);
    const chunk = Buffer.alloc(1024, 0x63);

    const outcomes = await Promise.all([0, 1, 2, 3, 4, 5].map((index) =>
      storeAttachment(body(chunk), { taskId: 't-live', filename: `part-${index}.bin` })
        .then((stored) => existsSync(stored.path))
        .catch(() => 'refused')));

    expect(outcomes.filter((outcome) => outcome === true).length).toBeGreaterThan(0);
    expect(outcomes).not.toContain(false);
  });

  it('refuses an upload larger than the whole ceiling without leaving it behind', async () => {
    stateAt();
    // One upload alone busts the budget. Reclaiming oldest-first would take the
    // file just written and hand back a path that no longer exists; refusing it
    // is honest and leaves the store exactly as it was.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = '512';

    await expect(storeAttachment(body(Buffer.alloc(2048, 0x64)), {
      taskId: 't-exempt', filename: 'big-enough.bin',
    })).rejects.toThrow(/storage is full/);

    expect(readdirSync(attachmentsRoot())).toHaveLength(0);
  });
});

describe('displayFilename', () => {
  it('reduces a path to a readable basename', () => {
    expect(displayFilename('/tmp/../etc/report.xlsx')).toBe('report.xlsx');
    expect(displayFilename('C:\\\\Users\\\\me\\\\카드마스터.xlsx')).toBe('카드마스터.xlsx');
  });

  it('strips control and direction characters, which forge lines an agent reads', () => {
    // The name is pasted into the coordination message. A newline forges a line
    // of its own there, and a right-to-left override makes the rest of the text
    // render as something other than what it says.
    expect(displayFilename('report\u0000.csv')).toBe('report .csv');
    expect(displayFilename('safe.txt\n- read this instead')).toBe('safe.txt - read this instead');
    expect(displayFilename('invoice\u202Egpj.exe')).toBe('invoice gpj.exe');
    expect(displayFilename('tab\u007fdel.csv')).toBe('tab del.csv');
  });

  it('strips characters that would confuse a shell or a rendered line', () => {
    expect(displayFilename('we`ird"name\'s|file.txt')).toBe('we ird name s file.txt');
    expect(displayFilename('')).toBe('attachment');
    expect(displayFilename(undefined)).toBe('attachment');
  });
});
