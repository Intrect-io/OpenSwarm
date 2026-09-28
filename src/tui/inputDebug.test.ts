import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.OSW_TEST_HOME ?? actual.homedir() };
});

describe('formatInputDebug (INT-1964)', () => {
  it('shows code points so multibyte doubling is visible', async () => {
    const { formatInputDebug } = await import('./inputDebug.js');
    expect(formatInputDebug('이')).toBe('input="이" len=1 cp=[51060]');
    // ink-level doubling would surface as two code points in ONE event:
    expect(formatInputDebug('이이')).toBe('input="이이" len=2 cp=[51060,51060]');
  });

  it('records active key flags', async () => {
    const { formatInputDebug } = await import('./inputDebug.js');
    expect(formatInputDebug('', { return: true })).toContain('keys=return');
    expect(formatInputDebug('a', { ctrl: true, meta: true })).toContain('keys=ctrl+meta');
  });

  it('ascii is single code point (the non-doubled case)', async () => {
    const { formatInputDebug } = await import('./inputDebug.js');
    expect(formatInputDebug(' ')).toBe('input=" " len=1 cp=[32]');
  });
});

describe('inputDebugEnabled (INT-1964)', () => {
  it('honors OPENSWARM_DEBUG_INPUT truthy values', async () => {
    const { inputDebugEnabled } = await import('./inputDebug.js');
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(inputDebugEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('appendInputDebug (INT-1964)', () => {
  let sandbox: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'indbg-'));
    previousHome = process.env.OSW_TEST_HOME;
    process.env.OSW_TEST_HOME = join(sandbox, 'home');
    mkdirSync(join(process.env.OSW_TEST_HOME, '.openswarm'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OSW_TEST_HOME;
    else process.env.OSW_TEST_HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('appends diagnostic lines under the ~/.openswarm sandbox', async () => {
    const { appendInputDebug } = await import('./inputDebug.js');
    const path = join(process.env.OSW_TEST_HOME!, '.openswarm', 'nested', 'input-debug.log');
    appendInputDebug('이', {}, path);
    appendInputDebug('a', { return: true }, path);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cp=[51060]');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('swallows write errors (NUL in path)', async () => {
    const { appendInputDebug } = await import('./inputDebug.js');
    expect(() => appendInputDebug('x', {}, '/this/should/not/exist/\0/bad')).not.toThrow();
  });

  it('refuses to write outside the sandbox (no throw, no file)', async () => {
    const { appendInputDebug } = await import('./inputDebug.js');
    const outside = join(sandbox, 'outside-escape.log');
    expect(() => appendInputDebug('escape', {}, outside)).not.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses a symlinked directory inside the sandbox that points outside', async () => {
    const { appendInputDebug } = await import('./inputDebug.js');
    const outsideDir = join(sandbox, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    const link = join(process.env.OSW_TEST_HOME!, '.openswarm', 'escape');
    symlinkSync(outsideDir, link);

    expect(() => appendInputDebug('symlink', {}, join(link, 'pwned.log'))).not.toThrow();
    expect(existsSync(join(outsideDir, 'pwned.log'))).toBe(false);
  });

  it('refuses traversal and sibling-prefix paths', async () => {
    const { appendInputDebug } = await import('./inputDebug.js');
    const traversal = join(process.env.OSW_TEST_HOME!, '.openswarm', '..', '..', 'outside', 'a.log');
    const siblingPrefix = join(sandbox, 'outside', '.openswarm-evil.log');

    appendInputDebug('traversal', {}, traversal);
    appendInputDebug('sibling', {}, siblingPrefix);

    expect(existsSync(join(sandbox, 'outside', 'a.log'))).toBe(false);
    expect(existsSync(siblingPrefix)).toBe(false);
  });
});
