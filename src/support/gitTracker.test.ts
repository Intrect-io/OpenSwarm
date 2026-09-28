import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChangedFiles, getChangedFilesSinceSnapshot, getDiffText, getWorkingDiffDetail, takeSnapshot } from './gitTracker.js';

/**
 * Fake `git` that writes `diff ¬` (UTF-8) as TWO chunks: the lead byte of the
 * final `¬` (`C2`), a following event-loop turn, then its trailing byte (`AC`)
 * plus a trailing newline. `setImmediate` is what keeps the writes in separate
 * pipe reads deterministically — each write flushes on its own turn — so the
 * parent must carry decoder state across chunk boundaries. `data.toString()`
 * decoded each chunk alone: the lead byte alone became U+FFFD, corrupting the
 * text (AGT-3493). `GIT_PROBE=stderr` sends the same bytes to stderr and exits
 * non-zero to exercise the rejection path.
 */
const SPLIT_BYTE_GIT = `#!/usr/bin/env node
const head = Buffer.from([0x64, 0x69, 0x66, 0x66, 0x20, 0xc2]);
const tail = Buffer.from([0xac, 0x0a]);
const stream = process.env.GIT_PROBE === 'stderr' ? process.stderr : process.stdout;
stream.write(head);
setImmediate(() => {
  stream.write(tail, () => { if (process.env.GIT_PROBE === 'stderr') process.exit(1); });
});
`;

/** Put the split-byte fake `git` first on PATH; returns a restore function. */
function installSplitByteGit(root: string): () => void {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), SPLIT_BYTE_GIT);
  chmodSync(join(bin, 'git'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return () => { process.env.PATH = previous; };
}

describe('gitTracker', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-git-tracker-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('getDiffText returns the working-tree change with its content', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');

    const diff = await getDiffText(repo);

    expect(diff).toContain('tracked.txt');
    expect(diff).toContain('-tracked');
    expect(diff).toContain('+changed');
  });

  it('getDiffText omits untracked files by default but includes them on request', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repo, 'brand-new.txt'), 'fresh content\n');

    // Default: `git diff HEAD` ignores untracked files entirely — the cockpit
    // listed the file with no patch behind it (INT-3402 review).
    const plain = await getDiffText(repo);
    expect(plain).toContain('tracked.txt');
    expect(plain).not.toContain('brand-new.txt');

    const withUntracked = await getDiffText(repo, undefined, 16_000, { includeUntracked: true });
    expect(withUntracked).toContain('brand-new.txt');
    expect(withUntracked).toContain('+fresh content');
    // The modified tracked file still shows, and the real index is untouched.
    expect(withUntracked).toContain('+changed');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf-8' });
    expect(staged.trim()).toBe('');
  });

  it('getDiffText ignores gitignored files even when including untracked', async () => {
    writeFileSync(join(repo, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(repo, 'secret.txt'), 'do not show\n');

    const diff = await getDiffText(repo, undefined, 16_000, { includeUntracked: true });
    expect(diff).not.toContain('do not show');
    expect(diff).toContain('.gitignore');
  });

  it('getDiffText diffs against a base ref when given one', async () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    writeFileSync(join(repo, 'tracked.txt'), 'committed change\n');
    execFileSync('git', ['commit', '-aqm', 'second'], { cwd: repo });

    // The committed-diff case: nothing dirty in the working tree, so a
    // HEAD diff would be empty and the reviewer would see no change at all.
    await expect(getDiffText(repo)).resolves.toBe('');
    await expect(getDiffText(repo, base)).resolves.toContain('+committed change');
  });

  it('getDiffText says how much it dropped rather than trailing off', async () => {
    writeFileSync(join(repo, 'tracked.txt'), Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'));

    const diff = await getDiffText(repo, undefined, 500);

    expect(diff.length).toBeLessThan(700);
    // Leading, so downstream truncation cannot be what removes it.
    expect(diff.startsWith('[diff truncated at 500 bytes of')).toBe(true);
    expect(diff).toContain('read the files directly for the rest');
  });

  it('getDiffText returns empty rather than throwing when git cannot answer', async () => {
    // Degrades the review to the file list; it must not end it.
    const notARepo = join(tmpdir(), `openswarm-not-a-repo-${process.pid}-${Date.now()}`);
    mkdirSync(notARepo, { recursive: true });
    try {
      await expect(getDiffText(notARepo)).resolves.toBe('');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('includes untracked files changed since a snapshot', async () => {
    const snapshot = await takeSnapshot(repo);
    writeFileSync(join(repo, 'new-file.txt'), 'new\n');

    await expect(getChangedFilesSinceSnapshot(repo, snapshot)).resolves.toContain('new-file.txt');
  });

  it('throws a git-tracker error (not []) when git fails, so real edits are not dropped (INT-2521)', async () => {
    // An invalid snapshot tree makes `git diff` fail. Returning [] would be
    // indistinguishable from "no changes" and drop the worker's real work (false
    // STUCK); it must throw with the git-tracker marker → classified infra_error.
    await expect(getChangedFilesSinceSnapshot(repo, '0000000000000000000000000000000000000000'))
      .rejects.toThrow(/git-tracker/);
  });

  it('excludes pre-existing dirty files, reporting only changes after the snapshot (INT-2447)', async () => {
    // Repo is ALREADY dirty before the snapshot: an untracked file + a modified
    // tracked file. Previously the HEAD-only snapshot blamed the worker for both.
    writeFileSync(join(repo, 'preexisting-untracked.txt'), 'junk\n');
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\n');
    const snapshot = await takeSnapshot(repo);

    // Now the "worker" makes ITS edit.
    writeFileSync(join(repo, 'worker-edit.txt'), 'fix\n');

    const changed = await getChangedFilesSinceSnapshot(repo, snapshot);
    expect(changed).toContain('worker-edit.txt');              // the worker's edit is reported
    expect(changed).not.toContain('preexisting-untracked.txt'); // pre-existing dirt is NOT attributed
    expect(changed).not.toContain('tracked.txt');              // pre-existing modification is NOT attributed
  });

  it('reports a worker edit to an already-dirty tracked file (no false negative) (INT-2447)', async () => {
    // A file dirty before the snapshot that the worker ALSO edits must still be
    // reported — the snapshot captures content, so a further change is detected.
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\n');
    const snapshot = await takeSnapshot(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\nworker-added\n');

    await expect(getChangedFilesSinceSnapshot(repo, snapshot)).resolves.toContain('tracked.txt');
  });

  it('includes untracked files in current change detection', async () => {
    writeFileSync(join(repo, 'new-current.txt'), 'new\n');

    await expect(getChangedFiles(repo)).resolves.toContain('new-current.txt');
  });

  it('with `since` set to a base ref, reports committed changes even with a clean working tree (CI `review --base` mode, INT-2552)', async () => {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'pr-change.txt'), 'pr work\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'pr commit'], { cwd: repo });

    // A CI checkout of a PR branch has nothing dirty — the default (no `since`)
    // path finds no working-tree changes at all.
    await expect(getChangedFiles(repo)).resolves.toEqual([]);
    // Diffing against the base ref finds the committed PR changes instead.
    await expect(getChangedFiles(repo, baseSha)).resolves.toContain('pr-change.txt');
  });

  describe('getWorkingDiffDetail', () => {
    it('reports per-file added/deleted for a tracked modification', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\nline2\nline3\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t).toBeDefined();
      expect(t!.added).toBe(2);
      expect(t!.deleted).toBe(0);
      expect(t!.isNew).toBe(false);
      expect(t!.whitespaceOnly).toBe(false);
    });

    it('flags a newly-created file as isNew', async () => {
      writeFileSync(join(repo, 'fresh.ts'), 'export const x = 1;\n');
      const detail = await getWorkingDiffDetail(repo);
      const f = detail.find(d => d.file === 'fresh.ts');
      expect(f).toBeDefined();
      expect(f!.isNew).toBe(true);
    });

    it('flags a staged newly-created file as isNew', async () => {
      writeFileSync(join(repo, 'staged-fresh.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', 'staged-fresh.ts'], { cwd: repo });
      const detail = await getWorkingDiffDetail(repo);
      const f = detail.find(d => d.file === 'staged-fresh.ts');
      expect(f).toBeDefined();
      expect(f!.isNew).toBe(true);
      expect(f!.added).toBe(1);
    });

    it('marks a whitespace-only change as whitespaceOnly', async () => {
      // Re-indent the existing line without changing its tokens.
      writeFileSync(join(repo, 'tracked.txt'), '  tracked\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t).toBeDefined();
      expect(t!.whitespaceOnly).toBe(true);
    });

    it('does NOT mark a semantic change as whitespaceOnly', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked-changed\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t!.whitespaceOnly).toBe(false);
    });

    it('returns [] for a non-git directory', async () => {
      const notGit = join(tmpdir(), `openswarm-notgit-${process.pid}-${Date.now()}`);
      mkdirSync(notGit, { recursive: true });
      try {
        await expect(getWorkingDiffDetail(notGit)).resolves.toEqual([]);
      } finally {
        rmSync(notGit, { recursive: true, force: true });
      }
    });
  });

  // AGT-3493: each stdout/stderr chunk was decoded on its own with data.toString(),
  // so a multi-byte character split across a chunk boundary became U+FFFD —
  // corrupting non-ASCII diff text and Git paths.
  describe('runGitCommand decodes output across chunk boundaries', () => {
    let probeRoot: string;

    beforeEach(() => {
      probeRoot = mkdtempSync(join(tmpdir(), 'openswarm-git-probe-'));
    });

    afterEach(() => {
      rmSync(probeRoot, { recursive: true, force: true });
      delete process.env.GIT_PROBE;
    });

    // The probe is a POSIX shim on PATH, so the split-chunk cases cannot run on Windows.
    it.skipIf(process.platform === 'win32')('decodes a character split across two stdout chunks instead of corrupting it', async () => {
      const restorePath = installSplitByteGit(probeRoot);
      try {
        // The fake git writes `diff ¬` with the `¬` (C2 AC) split across two
        // pipe reads. Per-chunk decoding yields 'diff \uFFFD\n'.
        const diff = await getDiffText(repo);

        expect(diff).not.toContain('\uFFFD');
        expect(diff).toBe('diff \u00ac\n');
      } finally {
        restorePath();
      }
    });

    it.skipIf(process.platform === 'win32')('applies the byte cap to the decoded output', async () => {
      const restorePath = installSplitByteGit(probeRoot);
      try {
        const capped = await getDiffText(repo, undefined, 4);

        // 7 decoded bytes > cap 4 → the leading notice plus the first 4 chars,
        // which is where the split character lives. Under per-chunk decoding the
        // window ended in U+FFFD.
        expect(capped).toContain('[diff truncated at 4 bytes of 7;');
        expect(capped.endsWith('\n\ndiff')).toBe(true);
        expect(capped).not.toContain('\uFFFD');
      } finally {
        restorePath();
      }
    });

    it.skipIf(process.platform === 'win32')('decodes a split stderr chunk into the git-failure message', async () => {
      const restorePath = installSplitByteGit(probeRoot);
      process.env.GIT_PROBE = 'stderr';
      try {
        // Non-zero exit must still reject, with the decoded stderr (not U+FFFD)
        // and the git-tracker marker that routes it to infra_error (INT-2521).
        await expect(getChangedFilesSinceSnapshot(repo, '0000000000000000000000000000000000000000'))
          .rejects.toThrow('git-tracker: diff since snapshot failed: git add -A failed: diff \u00ac\n');
      } finally {
        restorePath();
      }
    });
  });
});
