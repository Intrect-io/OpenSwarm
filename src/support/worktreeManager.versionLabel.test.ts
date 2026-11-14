import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndCreatePRWithHead } from './worktreeManager.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

// 2026-09-10: every open swarm PR on vega-agent failed version-label with
// `LABELS: []` — OpenSwarm opened them unlabelled (AGT-4269).
describe('commitAndCreatePRWithHead version:* label', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function publish(title: string, repoLabels: string[]): Promise<string[]> {
    root = mkdtempSync(join(tmpdir(), 'openswarm-version-label-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const branchName = 'swarm/AGT-LBL-x';
    git(repo, 'checkout', '-qb', branchName);
    writeFileSync(join(repo, 'a.ts'), 'changed\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const captured = join(root, 'pr-create-args.txt');
    const labels = repoLabels.join('\\n');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\ncase "$*" in\n  *"label list"*) printf '${labels}\\n';;\n  *"pr create"*) printf '%s\\n' "$@" > '${captured}'; echo "https://example.test/pr/1";;\nesac\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePRWithHead(
        { worktreePath: repo, originalPath: repo, branchName, issueId: 'AGT-LBL' },
        title, 'AGT-LBL', '', { draft: true },
      );
    } finally {
      process.env.PATH = prevPath;
    }
    return readFileSync(captured, 'utf8').split('\n');
  }

  const VERSION_LABELS = ['version:major', 'version:minor', 'version:patch', 'version:skip'];

  it('opens the PR with exactly one mapped label', async () => {
    const args = await publish('[BUG] crash on empty input', VERSION_LABELS);
    const at = args.indexOf('--label');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('version:patch');
    expect(args.filter((a) => a === '--label')).toHaveLength(1);
  });

  it('opens unlabelled with the reason in the body when the title does not decide', async () => {
    const args = await publish('refactor: split a module', VERSION_LABELS);
    expect(args).not.toContain('--label');
    expect(args.join('\n')).toContain('## Version label');
  });

  it('leaves a repository without version labels exactly as before', async () => {
    const args = await publish('[BUG] crash', ['bug', 'enhancement']);
    expect(args).not.toContain('--label');
    expect(args.join('\n')).not.toContain('## Version label');
  });
});
