import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndCreatePRWithHead } from './worktreeManager.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

// cgf-portal PR 776 (2026-10-03) reported "58 file(s)" for a one-file change:
// the change-shape section diffed the two tips, so a branch that was behind its
// base also "changed" every file the base had moved since.
describe('PR body change shape on a branch that is behind its base', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('counts only the files the branch changed, not the files the base moved', async () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-change-shape-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    mkdirSync(join(repo, 'src'));
    for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(repo, `src/${name}.ts`), `${name}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');

    // The branch leaves the base here...
    const branchName = 'swarm/AGT-SHAPE-stale';
    git(repo, 'checkout', '-qb', branchName);
    // ...and the base moves three files without it.
    git(repo, 'checkout', '-q', 'main');
    for (const name of ['c', 'd', 'e']) writeFileSync(join(repo, `src/${name}.ts`), `${name} moved on main\n`);
    git(repo, 'commit', '-qam', 'main moves');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'checkout', '-q', branchName);
    writeFileSync(join(repo, 'src/a.ts'), 'the one file this branch changed\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const captured = join(root, 'pr-create-args.txt');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\ncase "$*" in *"pr create"*) printf '%s\\n' "$@" > '${captured}'; echo "https://example.test/pr/1";; esac\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePRWithHead(
        { worktreePath: repo, originalPath: repo, branchName, issueId: 'AGT-SHAPE' },
        'One file change', 'AGT-SHAPE', '', { draft: true },
      );
    } finally {
      process.env.PATH = prevPath;
    }

    const body = readFileSync(captured, 'utf8');
    expect(body).toMatch(/## Change shape\n1 file\(s\)/);
    expect(body).not.toMatch(/## Change shape\n[2-9] file\(s\)/);
  });
});
