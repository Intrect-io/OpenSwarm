// ============================================
// OpenSwarm - OS sandbox wrapping tests (AGT-4387)
// Created: 2026-09-17
// Purpose: Pin the profile/argv shapes, the writable-root policy, and — on a
//   host that has sandbox-exec — that the fence really refuses a write outside
//   the worktree while allowing one inside it.
// Dependencies: vitest
// Test Status: npm test -- src/support/osSandbox.test.ts
// ============================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBwrapArgs,
  buildMacSandboxProfile,
  defaultWorkerWritableRoots,
  detectSandboxBackend,
  looksLikeSandboxDenial,
  wrapForSandbox,
} from './osSandbox.js';

describe('buildMacSandboxProfile', () => {
  it('matches the verify stage profile when network is denied (INT-3103 shape)', () => {
    expect(buildMacSandboxProfile({ writableRoots: ['/w'], allowNetwork: false })).toBe(
      '(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) ' +
        '(allow file-write* (subpath "/w") (literal "/dev/null") (literal "/dev/tty"))',
    );
  });

  it('adds network and every writable root for a worker', () => {
    const p = buildMacSandboxProfile({ writableRoots: ['/w', '/Users/x/.npm'], allowNetwork: true });
    expect(p).toContain('(allow network*)');
    expect(p).toContain('(subpath "/w") (subpath "/Users/x/.npm")');
  });

  it('escapes quotes and backslashes in paths so a crafted worktree name cannot break out of the profile', () => {
    const p = buildMacSandboxProfile({ writableRoots: ['/w/a"b\\c'], allowNetwork: false });
    expect(p).toContain('(subpath "/w/a\\"b\\\\c")');
  });
});

describe('buildBwrapArgs', () => {
  it('binds the root read-only, each writable root read-write, and keeps the network unless told otherwise', () => {
    expect(buildBwrapArgs({ writableRoots: ['/w', '/c'], allowNetwork: true })).toEqual([
      '--ro-bind', '/', '/', '--bind', '/w', '/w', '--bind', '/c', '/c',
      '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--',
    ]);
    expect(buildBwrapArgs({ writableRoots: ['/w'], allowNetwork: false })).toContain('--unshare-net');
  });
});

describe('wrapForSandbox', () => {
  const spec = { writableRoots: ['/w'], allowNetwork: true };

  it('returns null when the host has no sandbox', () => {
    expect(wrapForSandbox(['bash', '-c', 'true'], spec, null)).toBeNull();
  });

  it('prefixes sandbox-exec with the profile on macOS', () => {
    const w = wrapForSandbox(['bash', '-c', 'true'], spec, 'sandbox-exec');
    expect(w?.file).toBe('/usr/bin/sandbox-exec');
    expect(w?.args.slice(0, 1)).toEqual(['-p']);
    expect(w?.args.slice(-3)).toEqual(['bash', '-c', 'true']);
  });

  it('prefixes bwrap with the bind list on Linux', () => {
    const w = wrapForSandbox(['bash', '-c', 'true'], spec, 'bwrap');
    expect(w?.file).toMatch(/bwrap$/);
    expect(w?.args.slice(-4)).toEqual(['--', 'bash', '-c', 'true']);
  });

  it('refuses an empty argv', () => {
    expect(() => wrapForSandbox([], spec, 'sandbox-exec')).toThrow(/empty argv/);
  });
});

describe('defaultWorkerWritableRoots', () => {
  it('starts with the worktree (realpath), includes the temp dir, and drops caches the host never created', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-sbx-'));
    const home = mkdtempSync(join(tmpdir(), 'osw-home-'));
    const roots = defaultWorkerWritableRoots(wt, { TMPDIR: tmpdir() }, home);
    expect(roots[0]).toBe(realpathSync(wt));
    expect(roots).toContain(realpathSync(tmpdir()));
    // An empty home has none of the cache dirs, so none are listed.
    expect(roots.some((r) => r.startsWith(realpathSync(home)))).toBe(false);
    // No duplicates even when TMPDIR and /tmp resolve to the same place.
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('looksLikeSandboxDenial', () => {
  it('recognises the OS refusals and nothing else', () => {
    expect(looksLikeSandboxDenial('touch: /Users/x/y: Operation not permitted')).toBe(true);
    expect(looksLikeSandboxDenial('EROFS: read-only file system')).toBe(true);
    expect(looksLikeSandboxDenial('grep: no matches')).toBe(false);
  });
});

// The real fence, on a host that has it. CI's ubuntu runner may lack a usable
// bwrap (user namespaces), so this only runs where sandbox-exec exists.
const hasMacSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
describe.runIf(hasMacSandbox)('sandbox-exec fence (live)', () => {
  it('allows a write inside the worktree and refuses one outside it', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-fence-'));
    const outside = mkdtempSync(join(tmpdir(), 'osw-outside-'));
    const spec = { writableRoots: [realpathSync(wt)], allowNetwork: false };
    const inside = wrapForSandbox(['bash', '-c', `touch "${wt}/ok" && echo inside-ok`], spec, 'sandbox-exec')!;
    expect(execFileSync(inside.file, inside.args, { encoding: 'utf8' })).toContain('inside-ok');
    const escape = wrapForSandbox(['bash', '-c', `touch "${outside}/nope" 2>&1; echo "exit=$?"`], spec, 'sandbox-exec')!;
    const out = execFileSync(escape.file, escape.args, { encoding: 'utf8' });
    expect(out).toMatch(/Operation not permitted/);
    expect(out).toMatch(/exit=1/);
    expect(existsSync(join(outside, 'nope'))).toBe(false);
    expect(detectSandboxBackend('darwin')).toBe('sandbox-exec');
  });
});
