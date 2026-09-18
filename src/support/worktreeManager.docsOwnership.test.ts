import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOpenPRFileOverlaps } from './worktreeManager.js';

// Split out of worktreeManager.test.ts, which sits at the 1500-line cap.
describe('open PR planned-file preflight — documentation is not ownership (AGT-4422)', () => {
  // AGT-4422: every cgf-portal issue updates docs/REQUIREMENTS-LEDGER.md in its
  // PR, so one open hand PR touching the ledger superseded every task.
  it('does not let a shared documentation file reserve the plan, but a shared code file still does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-pr-docs-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --state open"*) echo '[{"number":549,"url":"https://example.test/549","headRefName":"ax-1532-b1","files":[{"path":"docs/REQUIREMENTS-LEDGER.md"},{"path":"apps/pipelines/src/b1_scope.py"}]},{"number":545,"url":"https://example.test/545","headRefName":"ax-1461-c2","files":[{"path":"docs/REQUIREMENTS-LEDGER.md"},{"path":"apps/pipelines/src/jobs/c_workstreams.py"}]}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const plan = ['docs/REQUIREMENTS-LEDGER.md', 'apps/pipelines/src/jobs/c_workstreams.py', 'apps/portal/src/api/c3.js'];
      await expect(findOpenPRFileOverlaps(root, plan)).resolves.toEqual([
        expect.objectContaining({ number: 545, files: ['apps/pipelines/src/jobs/c_workstreams.py'] }),
      ]);
      await expect(findOpenPRFileOverlaps(root, ['docs/REQUIREMENTS-LEDGER.md', 'apps/portal/src/api/c3.js'])).resolves.toEqual([]);
    } finally {
      process.env.PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
