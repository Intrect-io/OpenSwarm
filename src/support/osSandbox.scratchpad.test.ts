import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildBwrapArgs, buildMacSandboxProfile, workerWritableRoots } from './osSandbox.js';
import { scratchpadDir, scratchpadRoot } from './scratchpad.js';

// The scratchpad lives under the same tree as the ledger and the transcripts,
// so "which directory did we grant" is a security question, not a plumbing one.
describe('workerWritableRoots + scratchpad', () => {
  const previous = process.env.OPENSWARM_SCRATCHPAD_DIR;

  beforeEach(() => {
    // Outside tmp on purpose: /tmp and $TMPDIR are writable roots already, so a
    // scratchpad placed there would pass this test without the grant existing.
    process.env.OPENSWARM_SCRATCHPAD_DIR = join(homedir(), '.openswarm', 'scratch');
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR;
    else process.env.OPENSWARM_SCRATCHPAD_DIR = previous;
  });

  it('grants the run its own scratch directory', () => {
    expect(workerWritableRoots('/work/tree', 'AX-1556')).toContain(scratchpadDir('AX-1556'));
  });

  it('does not grant the scratch root, so one run cannot write another’s notes', () => {
    const roots = workerWritableRoots('/work/tree', 'AX-1556');
    expect(roots).not.toContain(scratchpadRoot());
    expect(roots).not.toContain(join(homedir(), '.openswarm'));
  });

  it('never reaches the ledger or the transcripts', () => {
    const roots = workerWritableRoots('/work/tree', 'AX-1556');
    const forbidden = [
      join(homedir(), '.openswarm'),
      join(homedir(), '.openswarm', 'sessions'),
      join(homedir(), '.openswarm', 'automation.db'),
    ];
    for (const path of forbidden) {
      // A root grants its whole subtree, so "not equal" is not enough: no
      // granted root may be an ancestor of any of these either.
      expect(roots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(false);
    }
  });

  it('grants nothing extra when the run has no scratchpad', () => {
    expect(workerWritableRoots('/work/tree')).toEqual(workerWritableRoots('/work/tree', undefined));
    expect(workerWritableRoots('/work/tree').some((r) => r.includes('scratch'))).toBe(false);
  });

  it('carries the grant into both sandbox backends', () => {
    const roots = workerWritableRoots('/work/tree', 'AX-1556');
    expect(buildMacSandboxProfile({ writableRoots: roots, allowNetwork: true }))
      .toContain(scratchpadDir('AX-1556'));
    expect(buildBwrapArgs({ writableRoots: roots, allowNetwork: true }))
      .toContain(scratchpadDir('AX-1556'));
  });
});
