import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn((_command, _args, _options, callback) => callback(new Error('not a repo'), '')));
vi.mock('node:child_process', () => ({ execFile }));

import { clearGitStatusCache, getGitStatusCacheSizeForTests, getProjectGitInfo } from './gitStatus.js';

afterEach(() => {
  clearGitStatusCache();
  vi.clearAllMocks();
});

describe('git status cache', () => {
  it('stays bounded under high-cardinality project paths', async () => {
    for (let index = 0; index < 250; index++) {
      await getProjectGitInfo(`/repo/${index}`);
    }
    expect(getGitStatusCacheSizeForTests()).toBe(200);
  });
});

describe('detached HEAD status (AGT-3455)', () => {
  it('reports git status when branch --show-current is empty', async () => {
    execFile.mockImplementation((_command: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
      // git(projectPath, args) → execFile('git', ['-C', projectPath, ...args], …)
      const gitArgs = args[0] === '-C' ? args.slice(2) : args;
      const key = gitArgs.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return callback(null, 'true\n');
      if (key === 'branch --show-current') return callback(null, '');
      if (key === 'rev-parse --short HEAD') return callback(null, 'abc1234\n');
      if (key === 'status --porcelain') return callback(null, ' M file.ts\n');
      if (key.startsWith('rev-list')) return callback(new Error('no upstream'), '');
      return callback(new Error(`unexpected: ${key}`), '');
    });

    try {
      const info = await getProjectGitInfo('/repo/detached');
      expect(info.git).toMatchObject({
        branch: 'detached@abc1234',
        hasChanges: true,
        uncommittedFiles: 1,
        ahead: 0,
        behind: 0,
      });
    } finally {
      execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('not a repo'), ''));
    }
  });
});
