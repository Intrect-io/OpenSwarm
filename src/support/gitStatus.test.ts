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

  it('calls git with maxBuffer >= 10MiB', async () => {
    execFile.mockImplementation((_command, _args, options, callback) => {
      expect(options.maxBuffer).toBeGreaterThanOrEqual(10 * 1024 * 1024);
      callback(new Error('not a repo'), '');
    });
    await getProjectGitInfo('/repo/maxbuffer-probe');
    expect(execFile).toHaveBeenCalled();
    const withMaxBuffer = execFile.mock.calls.some(
      (call) => typeof call[2] === 'object' && call[2] !== null && (call[2] as { maxBuffer?: number }).maxBuffer! >= 10 * 1024 * 1024,
    );
    expect(withMaxBuffer).toBe(true);
  });
});
