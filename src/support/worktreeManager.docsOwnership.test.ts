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

  // cgf-portal #552 shared one of AX-1526's 24 planned files — the job-schedule
  // registry every scheduling issue appends to — and superseded the task.
  it('a human PR reserves the plan only when it shares at least half of it; a held swarm PR reserves on any file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-pr-threshold-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --state open"*) echo '[{"number":552,"url":"https://example.test/552","headRefName":"ax-1486-b3-mail-intake-2","files":[{"path":"infra/nas/schedules.json"},{"path":"apps/b3.py"}]},{"number":553,"url":"https://example.test/553","headRefName":"ax-1499-a2-half","files":[{"path":"infra/nas/schedules.json"},{"path":"apps/a2_fixed.py"}]},{"number":180,"url":"https://example.test/180","headRefName":"swarm/AX-999-x","files":[{"path":"infra/nas/schedules.json"}]}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const plan = ['infra/nas/schedules.json', 'apps/a2_fixed.py', 'apps/a2_sheet.py', 'apps/service.py'];
      // #552 shares 1 of 4 (below half) — proceeds; #553 shares 2 of 4 — reserves;
      // the held swarm PR shares 1 of 4 — still reserves.
      await expect(findOpenPRFileOverlaps(root, plan, { activeIssueIdentifiers: ['AX-999'] })).resolves.toEqual([
        expect.objectContaining({ number: 553, files: ['infra/nas/schedules.json', 'apps/a2_fixed.py'] }),
        expect.objectContaining({ number: 180, files: ['infra/nas/schedules.json'] }),
      ]);
    } finally {
      process.env.PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
