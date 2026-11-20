import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssues, fetchProjects, fetchStuck, fetchTasks } from './monitorApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('monitorApi', () => {
  it('surfaces non-2xx pipeline responses instead of mapping an empty table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'daemon exploded' }), { status: 500 })));

    await expect(fetchTasks(3847)).rejects.toThrow('GET /api/pipeline failed: HTTP 500: daemon exploded');
  });

  it('surfaces non-2xx stuck issue responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));

    await expect(fetchStuck(3847)).rejects.toThrow('GET /api/stuck-issues failed: HTTP 502: bad gateway');
  });

  it('captions the Projects tab with the daemon work scope (AGT-3188)', async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/api/stats')
      ? new Response(JSON.stringify({ workScope: { milestone: 'S4 — Gate Trustworthiness' } }))
      : new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchProjects(3847)).caption).toBe('Work scope: milestone "S4 — Gate Trustworthiness" only');

    fetchMock.mockImplementation(async (url: string) => url.endsWith('/api/stats')
      ? new Response(JSON.stringify({ workScope: { milestone: null } }))
      : new Response(JSON.stringify([])));
    expect((await fetchProjects(3847)).caption).toBe('Work scope: all issues in the allowed projects');
  });

  it('still loads the Projects tab when an older daemon has no work scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/stats')
      ? new Response('nope', { status: 404 })
      : new Response(JSON.stringify([]))));
    const table = await fetchProjects(3847);
    expect(table.rows).toEqual([]);
    expect(table.caption).toBe('Work scope: unknown');
  });

  it('checks GraphQL HTTP errors before reading GraphQL payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'graphql down' }] }), { status: 503 })));

    await expect(fetchIssues(3847)).rejects.toThrow('POST /graphql failed: HTTP 503: graphql down');
  });
});
