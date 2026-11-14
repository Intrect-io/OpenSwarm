// ============================================
// OpenSwarm - codex index link path tests
// ============================================
//
// index.md links to session summaries used to be built with
// `summaryPath.replace(CODEX_DIR + '/', '')`, which left the absolute path in
// the link when the separator was '\' or CODEX_DIR had a trailing slash.

import { posix, win32 } from 'path';
import { describe, expect, it } from 'vitest';
import { indexLinkPath } from './codex.js';

describe('indexLinkPath', () => {
  it('gives a POSIX relative link for a Windows-shaped path', () => {
    const dir = 'C:\\Users\\me\\.openswarm\\codex';
    const summary = 'C:\\Users\\me\\.openswarm\\codex\\2026-11\\15-0730-title-abc.md';
    expect(indexLinkPath(dir, summary, win32)).toBe('2026-11/15-0730-title-abc.md');
  });

  it('gives a relative link when the codex dir has a trailing slash', () => {
    const dir = '/home/me/.openswarm/codex/';
    const summary = '/home/me/.openswarm/codex/2026-11/15-0730-title-abc.md';
    expect(indexLinkPath(dir, summary, posix)).toBe('2026-11/15-0730-title-abc.md');
  });

  it('handles a Windows codex dir with a trailing backslash', () => {
    const dir = 'C:\\codex\\';
    expect(indexLinkPath(dir, 'C:\\codex\\sessions\\a.md', win32)).toBe('sessions/a.md');
  });

  it('uses the native path module by default', () => {
    expect(indexLinkPath('/a/codex', '/a/codex/2026-11/x.md')).toBe('2026-11/x.md');
  });
});
