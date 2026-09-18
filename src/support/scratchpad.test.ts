import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCRATCHPAD_NOTE_BYTE_CAP,
  SCRATCHPAD_RUN_BYTE_CAP,
  ScratchpadBudgetError,
  clearScratchpad,
  deleteNote,
  listNotes,
  pruneScratchpads,
  readNote,
  renderNotesForPrompt,
  scratchpadDir,
  writeNote,
} from './scratchpad.js';

let root: string;
const previous = process.env.OPENSWARM_SCRATCHPAD_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scratchpad-test-'));
  process.env.OPENSWARM_SCRATCHPAD_DIR = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR;
  else process.env.OPENSWARM_SCRATCHPAD_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe('notes', () => {
  it('round-trips a note and lists it', async () => {
    await writeNote('AX-1', 'approach', 'use the registry');
    expect(await readNote('AX-1', 'approach')).toBe('use the registry');
    expect((await listNotes('AX-1')).map((n) => n.name)).toEqual(['approach']);
  });

  it('replaces a note of the same name rather than appending', async () => {
    await writeNote('AX-1', 'approach', 'first');
    await writeNote('AX-1', 'approach', 'second');
    expect(await readNote('AX-1', 'approach')).toBe('second');
    expect(await listNotes('AX-1')).toHaveLength(1);
  });

  it('keeps one run out of another run’s notes', async () => {
    await writeNote('AX-1', 'approach', 'mine');
    expect(await readNote('AX-2', 'approach')).toBeUndefined();
  });

  it('cannot be talked out of its directory by a traversing name', async () => {
    await writeNote('AX-1', '../../escape', 'nope');
    expect(existsSync(join(root, 'escape.md'))).toBe(false);
    expect(readdirSync(scratchpadDir('AX-1'))).toEqual(['escape.md']);
  });

  it('deletes a note', async () => {
    await writeNote('AX-1', 'approach', 'x');
    await deleteNote('AX-1', 'approach');
    expect(await listNotes('AX-1')).toHaveLength(0);
  });
});

describe('budget', () => {
  it('refuses a note over the per-note cap and writes nothing', async () => {
    await expect(writeNote('AX-1', 'big', 'x'.repeat(SCRATCHPAD_NOTE_BYTE_CAP + 1)))
      .rejects.toBeInstanceOf(ScratchpadBudgetError);
    expect(await listNotes('AX-1')).toHaveLength(0);
  });

  it('refuses a note that would push the run over its cap, leaving the old one intact', async () => {
    const chunk = 'y'.repeat(SCRATCHPAD_NOTE_BYTE_CAP);
    // One short of full, so the small note below still fits and the next
    // full-sized one does not.
    const fits = Math.floor(SCRATCHPAD_RUN_BYTE_CAP / SCRATCHPAD_NOTE_BYTE_CAP) - 1;
    for (let i = 0; i < fits; i += 1) await writeNote('AX-1', `note-${i}`, chunk);
    await writeNote('AX-1', 'keeper', 'small but mine');

    await expect(writeNote('AX-1', 'one-too-many', chunk))
      .rejects.toThrow(/limit for one task/);
    expect(await readNote('AX-1', 'keeper')).toBe('small but mine');
    expect(await readNote('AX-1', 'one-too-many')).toBeUndefined();
  });

  it('lets a note be replaced at the cap, counting only the other notes', async () => {
    const chunk = 'z'.repeat(SCRATCHPAD_NOTE_BYTE_CAP);
    const fits = Math.floor(SCRATCHPAD_RUN_BYTE_CAP / SCRATCHPAD_NOTE_BYTE_CAP);
    for (let i = 0; i < fits; i += 1) await writeNote('AX-1', `note-${i}`, chunk);
    await expect(writeNote('AX-1', 'note-0', chunk)).resolves.toBeTruthy();
  });

  it('leaves no staging file behind', async () => {
    await writeNote('AX-1', 'approach', 'x');
    expect(readdirSync(scratchpadDir('AX-1')).filter((f) => f.endsWith('.writing'))).toEqual([]);
  });
});

describe('renderNotesForPrompt', () => {
  it('returns nothing when there are no notes', async () => {
    expect(await renderNotesForPrompt('AX-1')).toBeUndefined();
  });

  it('puts the newest note last, where a model weighs it most', async () => {
    await writeNote('AX-1', 'older', 'first thought');
    await new Promise((r) => setTimeout(r, 10));
    await writeNote('AX-1', 'newer', 'second thought');
    const rendered = await renderNotesForPrompt('AX-1') ?? '';
    expect(rendered.indexOf('older')).toBeLessThan(rendered.indexOf('newer'));
  });

  it('drops whole older notes to fit the budget and says how many', async () => {
    await writeNote('AX-1', 'ancient', 'a'.repeat(400));
    await new Promise((r) => setTimeout(r, 10));
    await writeNote('AX-1', 'recent', 'b'.repeat(400));
    const rendered = await renderNotesForPrompt('AX-1', 500) ?? '';
    expect(rendered).toContain('recent');
    expect(rendered).not.toContain('a'.repeat(400));
    expect(rendered).toContain('1 older note left out');
  });

  it('keeps the newest note whole even when it alone exceeds the budget', async () => {
    await writeNote('AX-1', 'only', 'c'.repeat(400));
    const rendered = await renderNotesForPrompt('AX-1', 50) ?? '';
    expect(rendered).toContain('c'.repeat(400));
  });
});

describe('cleanup', () => {
  it('clearScratchpad removes the run directory', async () => {
    await writeNote('AX-1', 'approach', 'x');
    await clearScratchpad('AX-1');
    expect(existsSync(scratchpadDir('AX-1'))).toBe(false);
  });

  it('prunes a stale run but spares one touched inside the safety window', () => {
    const stale = join(root, 'stale');
    const live = join(root, 'live');
    mkdirSync(stale); mkdirSync(live);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(stale, longAgo, longAgo);

    expect(pruneScratchpads(14, root)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('spares a run that is old by retention but was touched minutes ago', () => {
    const recent = join(root, 'recent');
    mkdirSync(recent);
    // Older than the retention window, but inside the safety window: a live run
    // between two iterations looks exactly like this.
    const now = Date.now();
    const justNow = new Date(now - 60_000);
    utimesSync(recent, justNow, justNow);
    expect(pruneScratchpads(0, root, now)).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });

  it('returns zero when nothing was ever written', () => {
    expect(pruneScratchpads(14, join(root, 'missing'))).toBe(0);
  });
});
