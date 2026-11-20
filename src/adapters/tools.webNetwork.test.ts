// ============================================
// OpenSwarm - web tools under the loopback worker network (AGT-4815)
// ============================================
//
// web_fetch/web_search run in the daemon process, outside the bash tool's
// network namespace. Under `workerSandbox: on` + `workerNetwork: loopback` they
// must be withheld from the model and refused if called anyway; nothing may
// reach the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const web = vi.hoisted(() => ({
  webFetch: vi.fn(async () => 'page text'),
  webSearch: vi.fn(async () => 'results'),
}));
vi.mock('./webTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./webTools.js')>()),
  webFetch: web.webFetch,
  webSearch: web.webSearch,
}));

const { executeTool } = await import('./tools.js');
const { runAgenticLoop } = await import('./agenticLoop.js');
const { resetWorkerNetworkPolicyForTests, setWorkerNetworkPolicy } = await import('../support/osSandbox.js');

const call = (name: string, args: object) => ({ id: 'tc-1', function: { name, arguments: JSON.stringify(args) } });
const fetchCall = call('web_fetch', { url: 'https://example.com/' });
const searchCall = call('web_search', { query: 'vitest' });

beforeEach(() => {
  resetWorkerNetworkPolicyForTests();
  web.webFetch.mockClear();
  web.webSearch.mockClear();
});
afterEach(() => resetWorkerNetworkPolicyForTests());

describe('web tools and the worker network fence', () => {
  it('refuses web_fetch when the worker network is loopback', async () => {
    setWorkerNetworkPolicy('loopback');
    const res = await executeTool(fetchCall, process.cwd(), undefined, { sandbox: 'on' });

    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/^NETWORK_FENCED: web_fetch/);
    expect(res.content).toContain('workerNetwork: loopback');
    expect(web.webFetch).not.toHaveBeenCalled();
  });

  it('refuses web_search when the worker network is loopback, including the unconfigured default', async () => {
    // A process that never declared a policy is loopback; with the sandbox on that fails closed.
    const res = await executeTool(searchCall, process.cwd(), undefined, { sandbox: 'on' });

    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/^NETWORK_FENCED: web_search/);
    expect(web.webSearch).not.toHaveBeenCalled();
  });

  it('runs the web tools when the network is open or the sandbox is off', async () => {
    setWorkerNetworkPolicy('open');
    expect((await executeTool(fetchCall, process.cwd(), undefined, { sandbox: 'on' })).is_error).toBe(false);
    expect((await executeTool(searchCall, process.cwd(), undefined, { sandbox: 'on' })).is_error).toBe(false);

    setWorkerNetworkPolicy('loopback');
    // `off` is the operator's explicit opt-out: bash has the host network then too.
    expect((await executeTool(fetchCall, process.cwd(), undefined, { sandbox: 'off' })).is_error).toBe(false);
    // No sandbox mode at all (chat, ad-hoc tool use) is not a worker run.
    expect((await executeTool(searchCall, process.cwd())).is_error).toBe(false);

    expect(web.webFetch).toHaveBeenCalledTimes(2);
    expect(web.webSearch).toHaveBeenCalledTimes(2);
  });

  it('withholds the web tools from the model under the loopback network', async () => {
    const finalAnswer = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] } as never;
    const offered = async (sandbox: 'on' | 'off') => {
      let names: string[] = [];
      const callApi = async (_messages: unknown, tools: Array<{ function: { name: string } }>) => {
        names = tools.map((tool) => tool.function.name);
        return finalAnswer;
      };
      await runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 'test', maxTurns: 1, sandbox, callApi });
      return names;
    };

    setWorkerNetworkPolicy('loopback');
    const fenced = await offered('on');
    expect(fenced).toContain('read_file');
    expect(fenced).not.toContain('web_fetch');
    expect(fenced).not.toContain('web_search');

    expect(await offered('off')).toContain('web_fetch');
    setWorkerNetworkPolicy('open');
    expect(await offered('on')).toEqual(expect.arrayContaining(['web_fetch', 'web_search']));
  });
});
