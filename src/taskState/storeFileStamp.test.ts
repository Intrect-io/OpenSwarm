import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTaskState, resetTaskStateStoreForTests, upsertTaskState } from './store.js';

/**
 * The store cache is keyed on a file stamp. Including only `mtimeMs:size` misses
 * a same-size cross-process replacement (atomic rename) that lands inside the
 * same mtime tick — the cache then keeps serving the pre-replacement snapshot
 * forever. These cases pin the inode component of the stamp.
 */
describe('task state store file stamp', () => {
  let stateDir: string;
  let stateFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-store-stamp-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
  });

  afterEach(() => {
    resetTaskStateStoreForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('reloads after a same-size replacement that reuses the original mtime', () => {
    upsertTaskState('STAMP-1', { title: 'SWAP-SRC' });
    const original = readFileSync(stateFile, 'utf8');

    // A whole-second mtime has no sub-millisecond component, so both files can be
    // given byte-identical `mtimeMs` and `size` — leaving the inode as the only
    // stamp component that can distinguish them.
    const sharedMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(stateFile, sharedMtime, sharedMtime);
    const before = statSync(stateFile);

    // Warm the cache on the original snapshot.
    expect(getTaskState('STAMP-1')?.title).toBe('SWAP-SRC');

    const replaced = original.replace('"title": "SWAP-SRC"', '"title": "SWAP-DST"');
    expect(replaced).not.toBe(original);
    expect(Buffer.byteLength(replaced)).toBe(Buffer.byteLength(original));

    // Cross-process replacement by atomic rename: a different inode with the
    // same byte length and the same mtime.
    const incoming = `${stateFile}.incoming`;
    writeFileSync(incoming, replaced, 'utf8');
    utimesSync(incoming, sharedMtime, sharedMtime);
    const incomingStat = statSync(incoming);
    expect(incomingStat.size).toBe(before.size);
    expect(incomingStat.mtimeMs).toBe(before.mtimeMs);
    expect(incomingStat.ino).not.toBe(before.ino);
    renameSync(incoming, stateFile);

    // The cache is NOT reset here: invalidation must come from the stamp alone.
    expect(getTaskState('STAMP-1')?.title).toBe('SWAP-DST');
  });

  it('keeps serving the cached snapshot when nothing about the file changed', () => {
    upsertTaskState('STAMP-2', { title: 'stable' });
    const first = getTaskState('STAMP-2');
    expect(first?.title).toBe('stable');

    // Same inode, same mtime, same size: the stamp matches and the cached object
    // is returned rather than re-parsed.
    expect(getTaskState('STAMP-2')).toBe(first);
  });
});
