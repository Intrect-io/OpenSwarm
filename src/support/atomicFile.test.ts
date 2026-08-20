import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFile, atomicWriteFileSync } from './atomicFile.js';

describe('atomicFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** No `.tmp` scratch file may survive a write, successful or not. */
  function leftoverTempFiles(target: string): string[] {
    return readdirSync(target).filter(name => name.endsWith('.tmp'));
  }

  describe.each([
    ['atomicWriteFileSync', async (p: string, c: string, m?: number) => { atomicWriteFileSync(p, c, m); }],
    ['atomicWriteFile', (p: string, c: string, m?: number) => atomicWriteFile(p, c, m)],
  ])('%s', (_name, write) => {
    it('creates missing parent directories and writes the contents', async () => {
      const path = join(dir, 'deeply', 'nested', 'state.json');

      await write(path, '{"ok":true}');

      expect(readFileSync(path, 'utf8')).toBe('{"ok":true}');
      expect(leftoverTempFiles(join(dir, 'deeply', 'nested'))).toEqual([]);
    });

    it('defaults to owner-only permissions and honours an explicit mode', async () => {
      const secret = join(dir, 'secret');
      await write(secret, 'token');
      expect(statSync(secret).mode & 0o777).toBe(0o600);

      const shared = join(dir, 'shared');
      await write(shared, 'public', 0o644);
      expect(statSync(shared).mode & 0o777).toBe(0o644);
    });

    it('replaces existing contents rather than appending', async () => {
      const path = join(dir, 'state.json');
      writeFileSync(path, 'stale contents that are longer', { mode: 0o600 });

      await write(path, 'new');

      expect(readFileSync(path, 'utf8')).toBe('new');
    });

    it('preserves an existing file mode unless the caller explicitly replaces it', async () => {
      const executable = join(dir, 'script.sh');
      writeFileSync(executable, '#!/bin/sh\necho old\n', { mode: 0o755 });
      chmodSync(executable, 0o755);

      await write(executable, '#!/bin/sh\necho new\n');
      expect(statSync(executable).mode & 0o777).toBe(0o755);

      await write(executable, '#!/bin/sh\necho private\n', 0o600);
      expect(statSync(executable).mode & 0o777).toBe(0o600);
    });

    it('surfaces the write failure and leaves no scratch file behind', async () => {
      // The directory exists but denies writes, so creating the temp file fails
      // after mkdir succeeds — the path that must still clean up after itself.
      const readonly = join(dir, 'readonly');
      mkdirSync(readonly);
      chmodSync(readonly, 0o500);
      const path = join(readonly, 'state.json');

      await expect(write(path, 'value')).rejects.toThrow();

      chmodSync(readonly, 0o700);
      expect(existsSync(path)).toBe(false);
      expect(leftoverTempFiles(readonly)).toEqual([]);
    });

    it('removes the scratch file when the final rename fails', async () => {
      // A directory already occupies the destination, so the temp file is
      // written successfully and only the rename fails.
      const path = join(dir, 'occupied');
      mkdirSync(path);

      await expect(write(path, 'value')).rejects.toThrow();

      expect(leftoverTempFiles(dir)).toEqual([]);
    });
  });
});
