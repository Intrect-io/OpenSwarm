// Unit tests for the git child processes behind POST /api/repos/clone:
// no terminal prompt, a bounded clone, and GH_TOKEN delivered to git through
// the environment only (AGT-4005 review findings 1 and 2).
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

import {
  GIT_CLONE_TIMEOUT_MS, GIT_TOKEN_HELPER, GITHUB_REPO_CACHE_TTL_MS, GitCloneError, getCloneState, gitEnv,
  listGithubRepos, remoteMatchesRepo, resetGithubRepoCache, runGitClone,
} from './githubClone.js';

type GitCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
const TOKEN = 'ghp_secretTokenValue123';

describe('githubClone git children', () => {
  let originalToken: string | undefined;
  let originalRoot: string | undefined;
  let workspace: string;

  beforeEach(() => {
    mocks.execFile.mockReset();
    originalToken = process.env.GH_TOKEN;
    originalRoot = process.env.OPENSWARM_WORKSPACE_ROOT;
    workspace = mkdtempSync(join(tmpdir(), 'openswarm-clone-unit-'));
    process.env.OPENSWARM_WORKSPACE_ROOT = workspace;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalRoot === undefined) delete process.env.OPENSWARM_WORKSPACE_ROOT;
    else process.env.OPENSWARM_WORKSPACE_ROOT = originalRoot;
    rmSync(workspace, { recursive: true, force: true });
  });

  it('clones with a timeout, no terminal prompt, and -- before the URL and path', async () => {
    delete process.env.GH_TOKEN;
    mocks.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: GitCallback) => cb(null, '', ''));
    await runGitClone('Acme/Tool', '/work/Tool');
    const [command, args, options] = mocks.execFile.mock.calls[0] as [string, string[], { timeout: number; env: NodeJS.ProcessEnv }];
    expect(command).toBe('git');
    expect(args).toEqual(['clone', '--', 'https://github.com/Acme/Tool.git', '/work/Tool']);
    expect(options.timeout).toBe(GIT_CLONE_TIMEOUT_MS);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(options.env.GCM_INTERACTIVE).toBe('never');
    // Without a token there is no helper to configure.
    expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('gives GH_TOKEN to git only through an env-scoped credential helper, never argv or the URL', async () => {
    process.env.GH_TOKEN = `  ${TOKEN}  `;
    mocks.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: GitCallback) => cb(null, '', ''));
    await runGitClone('Acme/Private', '/work/Private');
    const [, args, options] = mocks.execFile.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args.some((arg) => arg.includes('@github.com'))).toBe(false);
    expect(options.env.GIT_CONFIG_COUNT).toBe('1');
    expect(options.env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(options.env.GIT_CONFIG_VALUE_0).toBe(GIT_TOKEN_HELPER);
    // The helper expands $GH_TOKEN at run time; the literal never lands in git config.
    expect(GIT_TOKEN_HELPER).toContain('password=$GH_TOKEN');
    expect(GIT_TOKEN_HELPER).not.toContain(TOKEN);
    expect(options.env.GH_TOKEN).toBe(TOKEN);
  });

  it('distinguishes a clone killed by the timeout from an ordinary failure', async () => {
    mocks.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: GitCallback) =>
      cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })));
    await expect(runGitClone('Acme/Huge', '/work/Huge')).rejects.toMatchObject({ timedOut: true, message: 'Git clone timed out after 10 minutes' });
    mocks.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: GitCallback) =>
      cb(Object.assign(new Error(`fatal: auth failed for ${TOKEN}`), { code: 128 })));
    const failure = await runGitClone('Acme/Gone', '/work/Gone').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitCloneError);
    expect((failure as GitCloneError).timedOut).toBe(false);
    // git's stderr never reaches the error the route returns.
    expect((failure as GitCloneError).message).toBe('Git clone failed');
  });

  it('matches origin remotes in https and ssh forms, with or without .git, case-insensitively', () => {
    for (const url of [
      'https://github.com/alice/tools', 'https://github.com/alice/tools.git', 'https://x-access-token@github.com/Alice/Tools.git',
      'git@github.com:alice/tools.git', 'ssh://git@github.com/alice/tools', 'https://github.com/alice/tools/',
    ]) expect(remoteMatchesRepo(url, 'alice/tools'), url).toBe(true);
    for (const url of [
      'https://github.com/bob/tools.git', 'git@github.com:alice/tools-extra.git', 'https://gitlab.com/alice/tools.git',
      'https://github.com.evil.invalid/alice/tools', '',
    ]) expect(remoteMatchesRepo(url, 'alice/tools'), url).toBe(false);
  });

  it('reads the destination origin with a timeout to tell cloned from name taken', async () => {
    const tools = join(workspace, 'tools');
    mkdirSync(tools);
    mocks.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: GitCallback) => cb(null, 'https://github.com/alice/tools.git\n', ''));
    expect(await getCloneState('alice/tools')).toEqual({ destination: tools, cloned: true, nameTaken: false });
    expect(await getCloneState('bob/tools')).toEqual({ destination: tools, cloned: false, nameTaken: true });
    const [, args, options] = mocks.execFile.mock.calls[0] as [string, string[], { timeout: number; env: NodeJS.ProcessEnv }];
    expect(args).toEqual(['-C', tools, 'remote', 'get-url', 'origin']);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    // A directory without a readable origin is taken, not cloned.
    mocks.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: GitCallback) => cb(new Error('not a git repository')));
    expect(await getCloneState('alice/tools')).toEqual({ destination: tools, cloned: false, nameTaken: true });
    // Nothing on disk: neither state, and git is not consulted.
    mocks.execFile.mockClear();
    expect(await getCloneState('alice/absent')).toEqual({ destination: join(workspace, 'absent'), cloned: false, nameTaken: false });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('builds the env without mutating process.env', () => {
    process.env.GH_TOKEN = TOKEN;
    const env = gitEnv();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('keeps the repository list for 60 s per token, then walks the pages again', async () => {
    resetGithubRepoCache();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { full_name: 'Acme/One', private: false, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z' },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = 1_000_000;
    await listGithubRepos('tok-a', t);
    await listGithubRepos('tok-a', t + GITHUB_REPO_CACHE_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await listGithubRepos('tok-b', t + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await listGithubRepos('tok-a', t + GITHUB_REPO_CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
    resetGithubRepoCache();
  });
});
