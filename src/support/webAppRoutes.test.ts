// Page shells were six copies of the same ten lines, one per route (AGT-4289).
// Copies drift: the 404-when-unbuilt path in particular is the one an operator
// meets after a fresh clone, and it existed six times with no test on any of
// them. These drive the single definition that replaced them.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';

import { tryServePageShell } from './webAppRoutes.js';

/** A response that records what the handler did to it. */
function res() {
  const sent: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
  return {
    sent,
    res: {
      writeHead: (status: number, headers: Record<string, string>) => { sent.status = status; sent.headers = headers; },
      end: (body: unknown) => { sent.body = body; },
    } as unknown as ServerResponse,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

const PAGES = ['/orchestration', '/chat', '/warehouse', '/usage', '/threads', '/app'];

describe('tryServePageShell', () => {
  it.each(PAGES)('serves %s as HTML from the built assets', async (url) => {
    const { res: r, sent } = res();

    await expect(tryServePageShell(r, url)).resolves.toBe(true);

    expect(sent.status).toBe(200);
    expect(sent.headers?.['Content-Type']).toContain('text/html');
    // The shells are a build product; a stale cache would serve yesterday's page.
    expect(sent.headers?.['Cache-Control']).toBe('no-cache');
    expect(String(sent.body)).toContain('<!doctype html>');
  });

  it('serves the usage page with its module and token script attached', async () => {
    // A shell that loses either one still returns 200 and renders nothing
    // useful: no data without the module, no data off-localhost without the
    // token wrapper.
    const { res: r, sent } = res();
    await tryServePageShell(r, '/usage');
    expect(String(sent.body)).toContain('/static/js/usage.mjs');
    expect(String(sent.body)).toContain('/static/js/webToken.js');
  });

  it('declines a URL that names no page, so later routes still run', async () => {
    const { res: r, sent } = res();
    await expect(tryServePageShell(r, '/api/usage')).resolves.toBe(false);
    expect(sent.status).toBeUndefined();
  });

  it('says how to build the assets rather than failing opaquely', async () => {
    // What an operator meets on a fresh clone before `npm run build`.
    const staticAssets = await import('./staticAssets.js');
    vi.spyOn(staticAssets, 'readUsageShell').mockResolvedValue(null);
    const { res: r, sent } = res();

    await expect(tryServePageShell(r, '/usage')).resolves.toBe(true);

    expect(sent.status).toBe(404);
    expect(String(sent.body)).toContain('npm run build');
  });
});
