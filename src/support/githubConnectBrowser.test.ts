// @vitest-environment jsdom
//
// AGT-4005: the Add-repository dialog can search the operator's GitHub
// repositories and clone one. These tests pin the API contract it consumes,
// the per-row clone state, and that GitHub-supplied names never reach HTML.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface GithubConnectApi {
  searchGithubRepos(query: string): Promise<void>;
  cloneGithubRepo(button: HTMLButtonElement): Promise<void>;
  toggleGithubConnect(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const reloadProjectList = vi.fn(async () => undefined);
let api: GithubConnectApi;

beforeAll(async () => {
  document.body.innerHTML = `
    <button id="gh-connect-toggle" aria-expanded="false"></button>
    <div id="gh-connect" hidden>
      <input id="gh-search">
      <p id="gh-status" hidden></p>
      <div id="gh-repo-list"></div>
    </div>`;
  vi.stubGlobal('fetch', fetchMock);
  (window as unknown as { reloadProjectList: typeof reloadProjectList }).reloadProjectList = reloadProjectList;
  await import('../../web/static/js/githubConnect.js');
  api = (window as unknown as { OpenSwarmGithubConnect: GithubConnectApi }).OpenSwarmGithubConnect;
});

beforeEach(() => {
  fetchMock.mockReset();
  reloadProjectList.mockClear();
  document.getElementById('gh-repo-list')!.replaceChildren();
});

const rows = () => [...document.querySelectorAll<HTMLElement>('#gh-repo-list .gh-repo')];
const status = () => document.getElementById('gh-status')!;

describe('GitHub repository search (AGT-4005)', () => {
  it('requests /api/github/repos with an encoded query and renders identity, private and cloned state', async () => {
    fetchMock.mockResolvedValueOnce(json(200, [
      { fullName: 'acme/app', private: true, cloned: false, defaultBranch: 'main', updatedAt: '' },
      { fullName: 'acme/lib', private: false, cloned: true, defaultBranch: 'main', updatedAt: '' },
    ]));
    await api.searchGithubRepos('a&b c');

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/github/repos?q=a%26b%20c');
    const [app, lib] = rows();
    expect(app.querySelector('.repo-item-name')!.textContent).toBe('acme/app');
    expect(app.textContent).toContain('private');
    expect(app.querySelector('button.gh-clone')).not.toBeNull();
    // An already-cloned repository offers no clone action.
    expect(lib.textContent).toContain('cloned');
    expect(lib.querySelector('button.gh-clone')).toBeNull();
  });

  it('renders a hostile repository name as text, never as markup', async () => {
    fetchMock.mockResolvedValueOnce(json(200, [
      { fullName: '<img src=x onerror=alert(1)>/x', private: false, cloned: false },
    ]));
    await api.searchGithubRepos('');
    expect(document.querySelector('#gh-repo-list img')).toBeNull();
    expect(rows()[0].querySelector('.repo-item-name')!.textContent).toBe('<img src=x onerror=alert(1)>/x');
  });

  it('explains a missing GH_TOKEN instead of showing an empty list', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: 'GH_TOKEN not configured' }));
    await api.searchGithubRepos('');
    expect(status().hidden).toBe(false);
    expect(status().textContent).toContain('GH_TOKEN');
    expect(status().dataset.tone).toBe('danger');
  });

  it('drops a stale response that resolves after a newer search', async () => {
    let releaseFirst!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(json(200, [{ fullName: 'acme/new', private: false, cloned: false }]));
    const first = api.searchGithubRepos('old');
    await api.searchGithubRepos('new');
    releaseFirst(json(200, [{ fullName: 'acme/old', private: false, cloned: false }]));
    await first;
    expect(rows().map((r) => r.dataset.fullName)).toEqual(['acme/new']);
  });
});

describe('GitHub repository clone (AGT-4005)', () => {
  async function renderOne() {
    fetchMock.mockResolvedValueOnce(json(200, [{ fullName: 'acme/app', private: false, cloned: false }]));
    await api.searchGithubRepos('');
    return rows()[0].querySelector<HTMLButtonElement>('button.gh-clone')!;
  }

  it('POSTs { fullName }, shows progress, then marks the row cloned and refreshes the repository panel', async () => {
    const button = await renderOne();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));

    const pending = api.cloneGithubRepo(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Cloning…');
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe('/api/repos/clone');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ fullName: 'acme/app' });

    release(json(201, { fullName: 'acme/app', destination: '/work/acme/app' }));
    await pending;
    const row = rows()[0];
    expect(row.dataset.state).toBe('cloned');
    expect(row.querySelector('button.gh-clone')).toBeNull();
    expect(row.textContent).toContain('/work/acme/app');
    expect(reloadProjectList).toHaveBeenCalledTimes(1);
  });

  it('shows the failure on the row and re-enables the action', async () => {
    const button = await renderOne();
    fetchMock.mockResolvedValueOnce(json(502, { error: 'Git clone failed' }));
    await api.cloneGithubRepo(button);
    const row = rows()[0];
    expect(row.dataset.state).toBe('failed');
    expect(row.querySelector('.gh-repo-note')!.textContent).toBe('Git clone failed');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Retry');
    expect(reloadProjectList).not.toHaveBeenCalled();
  });
});
