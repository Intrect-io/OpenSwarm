import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('./atomicFile.js', () => ({ atomicWriteFileSync: mocks.atomicWriteFileSync }));

import { getWebServerPort, setWebRunner, startWebServer, stopWebServer } from './web.js';
import { GIT_CLONE_TIMEOUT_MS, GITHUB_REPO_MAX_PAGES, resetGithubRepoCache } from './githubClone.js';

import { AUTH, useTestDaemonToken } from './daemonToken.testing.js';

useTestDaemonToken();

type GitCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

/** Script git: `remote get-url origin` per directory, `clone` by outcome. */
function scriptGit(origins: Record<string, string>, clone: (cb: GitCallback) => void = (cb) => cb(null, '', '')): void {
  mocks.execFile.mockImplementation((_command: string, args: string[], _options: unknown, callback: GitCallback) => {
    if (args[0] === '-C') {
      const origin = origins[args[1]!];
      callback(origin === undefined ? new Error('no origin') : null, origin === undefined ? '' : `${origin}\n`, '');
    } else {
      clone(callback);
    }
  });
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

describe('GitHub repository routes', () => {
  let workspace: string;
  let originalToken: string | undefined;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    await stopWebServer();
    setWebRunner(undefined);
    mocks.execFile.mockReset();
    // Default: every git child fails at once (no origin remote), so a test that
    // forgets to script git never hangs on an unanswered callback.
    mocks.execFile.mockImplementation((...args: unknown[]) => (args.at(-1) as GitCallback)(new Error('not scripted'), '', ''));
    mocks.atomicWriteFileSync.mockReset();
    resetGithubRepoCache();
    originalToken = process.env.GH_TOKEN;
    originalRoot = process.env.OPENSWARM_WORKSPACE_ROOT;
    workspace = mkdtempSync(join(tmpdir(), 'openswarm-github-'));
    process.env.OPENSWARM_WORKSPACE_ROOT = workspace;
  });

  afterEach(async () => {
    await stopWebServer();
    setWebRunner(undefined);
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalRoot === undefined) delete process.env.OPENSWARM_WORKSPACE_ROOT;
    else process.env.OPENSWARM_WORKSPACE_ROOT = originalRoot;
    rmSync(workspace, { recursive: true, force: true });
  });

  async function serverUrl(): Promise<string> {
    await startWebServer(await freePort());
    return `http://127.0.0.1:${getWebServerPort()}`;
  }

  it('rejects missing credentials without calling GitHub', async () => {
    delete process.env.GH_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const base = await serverUrl();
    const response = await fetch(`${base}/api/github/repos`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'GH_TOKEN not configured' });
    const cloneResponse = await fetch(`${base}/api/repos/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: 'Acme/Project' }),
    });
    expect(cloneResponse.status).toBe(503);
    expect(await cloneResponse.json()).toEqual({ error: 'GH_TOKEN not configured' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('normalizes, filters, and detects repositories from the clone root', async () => {
    process.env.GH_TOKEN = 'credential-must-not-leak';
    mkdirSync(join(workspace, 'Beta'), { recursive: true });
    scriptGit({ [join(workspace, 'Beta')]: 'https://github.com/Acme/Beta.git' });
    const realFetch = globalThis.fetch;
    const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([
          { full_name: 'Acme/Alpha', private: true, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z', html_url: 'https://secret.invalid' },
          { full_name: 'Acme/Beta', private: false, default_branch: 'trunk', updated_at: '2026-01-02T00:00:00Z' },
        ]), { status: 200 });
      }
      return realFetch(input, init);
    });
    vi.stubGlobal('fetch', githubFetch);
    const base = await serverUrl();
    const response = await fetch(`${base}/api/github/repos?q=bEtA`);
    expect(response.status).toBe(200);
    expect(githubFetch).toHaveBeenCalledWith(
      'https://api.github.com/user/repos?per_page=100&sort=updated',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer credential-must-not-leak' }) }),
    );
    expect(await response.json()).toEqual([{
      fullName: 'Acme/Beta', private: false, defaultBranch: 'trunk', updatedAt: '2026-01-02T00:00:00Z', cloned: true, nameTaken: false,
    }]);
    vi.unstubAllGlobals();
  });

  it('rejects malformed individual GitHub repository records', async () => {
    process.env.GH_TOKEN = 'credential-must-not-leak';
    const realFetch = globalThis.fetch;
    const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([{ full_name: 'Acme/Alpha' }]), { status: 200 });
      }
      return realFetch(input, init);
    });
    vi.stubGlobal('fetch', githubFetch);
    const base = await serverUrl();
    const response = await fetch(`${base}/api/github/repos`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Invalid GitHub repository response' });
    vi.unstubAllGlobals();
  });

  it('validates clone input and clones/registers a valid repository', async () => {
    process.env.GH_TOKEN = 'configured';
    // `setWebRunner` reconciles enabled projects (web.ts), so a stub with only
    // `registerProjectPath` throws before the route under test is reached.
    const runner = {
      registerProjectPath: vi.fn(),
      enableProject: vi.fn(),
      disableProject: vi.fn(),
      getEnabledProjects: vi.fn(() => [] as string[]),
      getAllowedProjects: vi.fn(() => [] as string[]),
      updateAllowedProjects: vi.fn(),
    } as unknown as AutonomousRunner;
    setWebRunner(runner);
    scriptGit({});
    const base = await serverUrl();
    const malformed = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: '../escape' }) });
    expect(malformed.status).toBe(400);
    const response = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: 'Acme/Project' }) });
    expect(response.status).toBe(201);
    const destination = join(workspace, 'Project');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git', ['clone', '--', 'https://github.com/Acme/Project.git', destination],
      expect.objectContaining({ timeout: GIT_CLONE_TIMEOUT_MS }), expect.any(Function),
    );
    expect(mocks.atomicWriteFileSync).toHaveBeenCalled();
    expect(runner.registerProjectPath).toHaveBeenCalledWith('Project', destination);
    mkdirSync(destination);
    const conflict = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: 'Acme/Project' }) });
    expect(conflict.status).toBe(409);
    expect(existsSync(destination)).toBe(true);
  });

  it('returns a credential-safe failure for malformed GitHub repository records', async () => {
    process.env.GH_TOKEN = 'test-token';
    // URL-aware, like the sibling test above. The server runs in THIS process,
    // so a bare `mockResolvedValueOnce` is consumed by the test's own request
    // to it — the assertion then reads the stub's 200 instead of the route's
    // 502, and passes or fails for reasons unrelated to the route.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([{
          full_name: 'Acme/Project', private: 'true', default_branch: 'main', updated_at: '2025-01-01T00:00:00Z',
        }]), { status: 200 });
      }
      return realFetch(input, init);
    }));
    const response = await fetch(`${await serverUrl()}/api/github/repos`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Invalid GitHub repository response' });
  });


  function repo(fullName: string) {
    return { full_name: fullName, private: false, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z' };
  }

  /** Stub GitHub only; the test's own requests to the daemon go through. */
  function stubGithub(page: (url: string) => Response) {
    const realFetch = globalThis.fetch;
    const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/') || url.startsWith('https://evil.invalid/')) return page(url);
      return realFetch(input, init);
    });
    vi.stubGlobal('fetch', githubFetch);
    return githubFetch;
  }

  it('fetches every page once via the Link header, caches the list and filters it per query', async () => {
    process.env.GH_TOKEN = 'paged-token';
    const page2 = 'https://api.github.com/user/repos?per_page=100&sort=updated&page=2';
    const githubFetch = stubGithub((url) => url === page2
      ? new Response(JSON.stringify([repo('Acme/Second')]), { status: 200 })
      : new Response(JSON.stringify([repo('Acme/First')]), {
        status: 200, headers: { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      }));
    const base = await serverUrl();
    const all = await (await fetch(`${base}/api/github/repos`)).json() as Array<{ fullName: string }>;
    expect(all.map((r) => r.fullName)).toEqual(['Acme/First', 'Acme/Second']);
    const second = await (await fetch(`${base}/api/github/repos?q=seco`)).json() as Array<{ fullName: string }>;
    expect(second.map((r) => r.fullName)).toEqual(['Acme/Second']);
    // Two keystrokes, one walk of the pages.
    const githubCalls = githubFetch.mock.calls.filter(([input]) => String(input).startsWith('https://api.github.com/'));
    expect(githubCalls.map(([input]) => String(input))).toEqual([
      'https://api.github.com/user/repos?per_page=100&sort=updated', page2,
    ]);
    vi.unstubAllGlobals();
  });

  it('stops at the page cap and never follows a next link off the GitHub API origin', async () => {
    process.env.GH_TOKEN = 'cap-token';
    let n = 0;
    stubGithub(() => new Response(JSON.stringify([repo(`Acme/R${n++}`)]), {
      status: 200, headers: { Link: `<https://api.github.com/user/repos?page=${n + 1}>; rel="next"` },
    }));
    const base = await serverUrl();
    const capped = await (await fetch(`${base}/api/github/repos`)).json() as unknown[];
    expect(capped).toHaveLength(GITHUB_REPO_MAX_PAGES);
    vi.unstubAllGlobals();

    resetGithubRepoCache();
    process.env.GH_TOKEN = 'origin-token';
    const offsite = stubGithub(() => new Response(JSON.stringify([repo('Acme/Only')]), {
      status: 200, headers: { Link: '<https://evil.invalid/steal>; rel="next"' },
    }));
    const one = await (await fetch(`${base}/api/github/repos`)).json() as unknown[];
    expect(one).toHaveLength(1);
    expect(offsite.mock.calls.some(([input]) => String(input).startsWith('https://evil.invalid/'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('does not cache a failed GitHub request', async () => {
    process.env.GH_TOKEN = 'retry-token';
    let fail = true;
    stubGithub(() => fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify([repo('Acme/Back')]), { status: 200 }));
    const base = await serverUrl();
    expect((await fetch(`${base}/api/github/repos`)).status).toBe(503);
    fail = false;
    expect((await fetch(`${base}/api/github/repos`)).status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('reports a same-named repository of another owner as name taken, not cloned, and refuses to clone it', async () => {
    process.env.GH_TOKEN = 'collide-token';
    setWebRunner({
      registerProjectPath: vi.fn(), enableProject: vi.fn(), disableProject: vi.fn(),
      getEnabledProjects: vi.fn(() => [] as string[]), getAllowedProjects: vi.fn(() => [] as string[]), updateAllowedProjects: vi.fn(),
    } as unknown as AutonomousRunner);
    const tools = join(workspace, 'tools');
    mkdirSync(tools);
    scriptGit({ [tools]: 'git@github.com:alice/tools.git' });
    stubGithub(() => new Response(JSON.stringify([repo('alice/tools'), repo('bob/tools')]), { status: 200 }));
    const base = await serverUrl();
    const listed = await (await fetch(`${base}/api/github/repos?q=tools`)).json() as Array<{ fullName: string; cloned: boolean; nameTaken: boolean }>;
    expect(listed).toEqual([
      expect.objectContaining({ fullName: 'alice/tools', cloned: true, nameTaken: false }),
      expect.objectContaining({ fullName: 'bob/tools', cloned: false, nameTaken: true }),
    ]);
    const response = await fetch(`${base}/api/repos/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: 'bob/tools' }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; nameTaken?: boolean };
    expect(body.nameTaken).toBe(true);
    expect(body.error).toContain('Name taken');
    expect(mocks.execFile.mock.calls.some(([, args]) => (args as string[])[0] === 'clone')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('surfaces a clone killed by its timeout as a 504 with a clear message', async () => {
    process.env.GH_TOKEN = 'slow-token';
    scriptGit({}, (cb) => cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })));
    const response = await fetch(`${await serverUrl()}/api/repos/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ fullName: 'Acme/Huge' }),
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'Git clone timed out after 10 minutes' });
  });

});
