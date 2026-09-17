import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stagePreservableWorktreeChanges, unstageAgentScratchAdditions } from './worktreeEphemeralOps.js';

// Real git: the guard's whole contract is what ends up in the index, and a
// mocked `git` would only restate the implementation.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function staged(cwd: string): string[] {
  return git(cwd, '-c', 'core.quotepath=false', 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
}

describe('stagePreservableWorktreeChanges — agent scratch files (AGT-4410)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-scratch-'));
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'scripts', 'tool.py'), 'print(1)\n');
    writeFileSync(join(repo, 'config.yaml.bak'), 'tracked on purpose\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });

  it('stages the worker\'s source edits but not its backup or one-off edit script', async () => {
    writeFileSync(join(repo, 'scripts', 'tool.py'), 'print(2)\n');
    writeFileSync(join(repo, 'scripts', 'tool.py.bak'), 'print(1)\n');
    writeFileSync(join(repo, '_apply_edit.py'), 'open("scripts/tool.py").read()\n');
    writeFileSync(join(repo, 'scripts', 'new_feature.py'), 'pass\n');

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual(['scripts/new_feature.py', 'scripts/tool.py']);
    // Left on disk, merely unstaged — nothing of the worker's is deleted.
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toContain('?? _apply_edit.py');
  });

  it('keeps an edit to a scratch-shaped file the repository already tracks', async () => {
    writeFileSync(join(repo, 'config.yaml.bak'), 'edited by the task\n');
    await stagePreservableWorktreeChanges(repo);
    expect(staged(repo)).toEqual(['config.yaml.bak']);
  });

  it('matches a non-ASCII path exactly, not git\'s quoted spelling of it', async () => {
    writeFileSync(join(repo, '보고서.md.bak'), 'x\n');
    writeFileSync(join(repo, '보고서.md'), 'x\n');
    git(repo, 'add', '-A');
    const dropped = await unstageAgentScratchAdditions(repo);
    expect(dropped).toEqual(['보고서.md.bak']);
    expect(staged(repo)).toEqual(['보고서.md']);
  });
});
