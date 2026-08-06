import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same promisify.custom technique as prProcessor.test.ts: execFileAsync
// destructures {stdout}, so the mock must control that exact shape rather
// than rely on generic callback-to-promise conversion.
const { execImpl } = vi.hoisted(() => ({
  execImpl: vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  function execFile() { throw new Error('execFile called without promisify in test'); }
  (execFile as unknown as Record<symbol, unknown>)[CUSTOM] = (cmd: string, args: string[]) => execImpl(cmd, args);
  return { execFile };
});

const { parsePRRef, resolveRepoName, resolvePR, toPRInfo } = await import('./prResolve.js');

beforeEach(() => {
  execImpl.mockReset();
});

describe('parsePRRef (INT-3282)', () => {
  it('parses owner/repo#n', () => {
    expect(parsePRRef('o/r#42')).toEqual({ repo: 'o/r', number: 42 });
  });
  it('parses #n and bare n', () => {
    expect(parsePRRef('#7')).toEqual({ number: 7 });
    expect(parsePRRef('7')).toEqual({ number: 7 });
  });
  it('rejects garbage', () => {
    expect(() => parsePRRef('not-a-ref')).toThrow(/Invalid PR ref/);
  });
});

describe('resolveRepoName (INT-3282)', () => {
  it('returns the explicit repo without shelling out when it already has a slash', async () => {
    const result = await resolveRepoName('/tmp/proj', 'o/r');
    expect(result).toBe('o/r');
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('infers the repo via gh repo view when no explicit repo is given', async () => {
    execImpl.mockResolvedValueOnce({ stdout: 'o/r\n', stderr: '' });
    const result = await resolveRepoName('/tmp/proj');
    expect(result).toBe('o/r');
    expect(execImpl).toHaveBeenCalledWith('gh', expect.arrayContaining(['repo', 'view']));
  });

  it('throws when gh returns something without a slash', async () => {
    execImpl.mockResolvedValueOnce({ stdout: 'garbage\n', stderr: '' });
    await expect(resolveRepoName('/tmp/proj')).rejects.toThrow(/Could not resolve repository name/);
  });
});

describe('resolvePR (INT-3282)', () => {
  const ghView = { number: 9, title: 'Ship it', headRefName: 'feat/x', url: 'https://example/pr/9', author: { login: 'someone' } };

  it('resolves an explicit PR number', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'o/r\n', stderr: '' }) // resolveRepoName
      .mockResolvedValueOnce({ stdout: JSON.stringify(ghView), stderr: '' }); // gh pr view <n>
    const result = await resolvePR({ path: '/tmp/proj', number: 9 });
    expect(result).toEqual({ repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', url: 'https://example/pr/9', author: 'someone' });
  });

  it('resolves the current branch\'s open PR when no number is given', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'o/r\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(ghView), stderr: '' });
    const result = await resolvePR({ path: '/tmp/proj' });
    expect(result.number).toBe(9);
    expect(execImpl).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'view']));
  });

  it('reports the branch name and a create hint when there is no open PR', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'o/r\n', stderr: '' })
      .mockRejectedValueOnce(new Error('no pull requests found')) // gh pr view fails
      .mockResolvedValueOnce({ stdout: 'feat/no-pr\n', stderr: '' }); // git rev-parse
    await expect(resolvePR({ path: '/tmp/proj' })).rejects.toThrow(/No open PR for branch "feat\/no-pr"/);
  });
});

describe('toPRInfo (INT-3282)', () => {
  it('carries repo/number/title/branch/url/author through, stamping createdAt', () => {
    const info = toPRInfo({ repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', url: 'https://example/pr/9', author: 'someone' });
    expect(info).toMatchObject({ repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', url: 'https://example/pr/9', author: 'someone' });
    expect(typeof info.createdAt).toBe('string');
  });
});
