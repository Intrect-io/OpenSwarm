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
    mocks.atomicWriteFileSync.mockReset();
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Acme/Project' }),
    });
    expect(cloneResponse.status).toBe(503);
    expect(await cloneResponse.json()).toEqual({ error: 'GH_TOKEN not configured' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('normalizes, filters, and detects repositories from the clone root', async () => {
    process.env.GH_TOKEN = 'credential-must-not-leak';
    mkdirSync(join(workspace, 'Beta'), { recursive: true });
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
      fullName: 'Acme/Beta', private: false, defaultBranch: 'trunk', updatedAt: '2026-01-02T00:00:00Z', cloned: true,
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
    mocks.execFile.mockImplementation((_command: string, _args: string[], callback: (error: Error | null) => void) => callback(null));
    const base = await serverUrl();
    const malformed = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: '../escape' }) });
    expect(malformed.status).toBe(400);
    const response = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Acme/Project' }) });
    expect(response.status).toBe(201);
    const destination = join(workspace, 'Project');
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['clone', 'https://github.com/Acme/Project.git', destination], expect.any(Function));
    expect(mocks.atomicWriteFileSync).toHaveBeenCalled();
    expect(runner.registerProjectPath).toHaveBeenCalledWith('Project', destination);
    mkdirSync(destination);
    const conflict = await fetch(`${base}/api/repos/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Acme/Project' }) });
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

});
