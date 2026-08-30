// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/api/warehouse/tree')) {
    return new Response(JSON.stringify({
      path: '',
      entries: [{ name: 'INDEX.md', type: 'file', size: 12, mtime: '2026-08-30T00:00:00.000Z' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('warehouse index', { status: 200 });
});

beforeAll(async () => {
  document.body.innerHTML = `
    <button id="up"></button><nav id="breadcrumbs"></nav><button id="refresh"></button>
    <table><tbody id="entries"></tbody></table>
    <input id="file" type="file"><span id="file-label"></span>
    <input id="overwrite" type="checkbox"><button id="upload"></button>
    <span id="upload-directory"></span><p id="status"></p>
    <input id="web-token" type="password"><button id="save-token"></button><button id="clear-token"></button>
  `;
  sessionStorage.setItem('openswarm.webToken', 'browser-secret');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:warehouse-download'),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await import('../../web/static/js/warehouse.mjs');
});

describe('warehouse browser authentication', () => {
  it('sends the session token as a header for listing and authenticated downloads, never in the URL', async () => {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const download = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('button.download');
      expect(button).toBeTruthy();
      return button!;
    });
    download.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    for (const [url, options] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('browser-secret');
      expect(options).toBeDefined();
      expect((options!.headers as Headers).get('X-OpenSwarm-Token')).toBe('browser-secret');
    }
  });
});
