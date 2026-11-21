// A run that parks for the operator with UNCOMMITTED worker edits must publish
// a branch that carries them (AGT-4538). The old `committedOnly` park publish
// pushed only what the worker had committed, so the operator's draft omitted
// the edits — or, with nothing committed, no draft appeared at all.
//
// Real git end to end: a temp repo with a bare origin, the real
// worktreeManager, and a fake `gh` on PATH. The assertion reads the pushed
// branch from the origin, not from the working repo.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('./anomalyPause.js', () => ({ recordFactorySignal: vi.fn() }));

import { publishFinishedRun } from './publishOnPark.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

describe('parked publication with uncommitted edits (AGT-4538)', () => {
  let root = '';
  let prevPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-park-edits-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // No `/pull/<n>` in the URL, so PR ownership registration writes nothing.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$*" in\n  *"pr create"*) echo "https://example.test/pr/1";;\n  *) ;;\nesac\n');
    chmodSync(join(bin, 'gh'), 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
  });
  afterEach(() => {
    process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('a park with uncommitted edits pushes a branch whose diff contains those files', async () => {
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/existing.ts'), 'export const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const branchName = 'swarm/AGT-4538-park';
    git(repo, 'checkout', '-qb', branchName);
    // The worker's edits, never committed: one modified tracked file, one new file.
    writeFileSync(join(repo, 'src/existing.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'src/added.ts'), 'export const b = 1;\n');

    const result = { success: false, finalStatus: 'waiting_on_operator' };
    const onPublication = vi.fn(async () => true);
    await publishFinishedRun(
      { worktreePath: repo, originalPath: repo, branchName, issueId: 'i-4538' },
      { id: 't', issueId: 'i-4538', title: 'Parked work', issueIdentifier: 'AGT-4538' },
      result,
      { beforePublish: async () => true, onPublication } as never,
      () => undefined,
    );

    expect(onPublication).toHaveBeenCalledWith('https://example.test/pr/1', expect.any(String));
    const pushed = git(origin, 'diff', '--name-only', `main...${branchName}`).split('\n').filter(Boolean).sort();
    expect(pushed).toEqual(['src/added.ts', 'src/existing.ts']);
    expect(git(origin, 'show', `${branchName}:src/existing.ts`)).toBe('export const a = 2;\n');
    // The park keeps its outcome: publishing never turns it into something else.
    expect(result.finalStatus).toBe('waiting_on_operator');
  });
});
