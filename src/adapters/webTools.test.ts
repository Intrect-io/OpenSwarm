import { afterEach, describe, expect, it, vi } from 'vitest';
import { webFetch, webSearch, searchBackend, WEB_TOOL_DEFINITIONS } from './webTools.js';

// These suites cover parsing and backend selection, not the socket layer, so
// route publicFetch onto the global fetch they stub. The real implementation —
// including the undici dispatcher contract — is covered by outboundUrl.test.ts.
vi.mock('../support/outboundUrl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/outboundUrl.js')>();
  return { ...actual, publicFetch: (url: string | URL, init?: RequestInit) => fetch(String(url), init) };
});


afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('WEB_TOOL_DEFINITIONS', () => {
  it('exposes exactly web_fetch and web_search', () => {
    expect(WEB_TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual(['web_fetch', 'web_search']);
  });
});

// Redirects are followed by hand here, so the method rewrite the Fetch standard
// performs has to be reproduced — otherwise a 302 replays the POST body the
// server just told us to stop sending.
describe('redirect method rewriting', () => {
  /** First call answers with `status`, every later call succeeds. */
  function redirectOnce(status: number) {
    let calls = 0;
    return vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status, headers: { location: 'https://api.tavily.com/next' } })
        : new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
  }

  async function secondHopInit(status: number): Promise<RequestInit> {
    const f = redirectOnce(status);
    vi.stubGlobal('fetch', f);
    vi.stubEnv('TAVILY_KEY', 'k');
    await webSearch('q', 1);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(2);
    return f.mock.calls[1][1] as RequestInit;
  }

  it.each([301, 302, 303])('downgrades POST to GET and drops the body on %i', async (status) => {
    const second = await secondHopInit(status);
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect(new Headers(second.headers).has('content-type')).toBe(false);
  });

  it.each([307, 308])('replays the POST unchanged on %i', async (status) => {
    const second = await secondHopInit(status);
    expect(second.method).toBe('POST');
    expect(second.body).toBeTruthy();
  });
});

describe('webFetch', () => {
  it('strips HTML to readable text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<html><body><h1>Hi</h1><script>bad()</script><p>world &amp; co</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    ));
    const out = await webFetch('https://example.com');
    expect(out).toContain('Hi');
    expect(out).toContain('world & co');
    expect(out).not.toContain('<');
    expect(out).not.toContain('bad()');
  });

  it('rejects a non-http URL without fetching', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = await webFetch('ftp://x');
    expect(out).toContain('Invalid URL');
    expect(f).not.toHaveBeenCalled();
  });

  it('reports an HTTP error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })));
    const out = await webFetch('https://example.com/x');
    expect(out).toContain('404');
  });
});

describe('webFetch — HTML sanitization hardening (INT-1931)', () => {
  const htmlResponse = (body: string) =>
    vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));

  it('decodes entities in a single pass — no double-unescaping (js/double-escaping)', async () => {
    vi.stubGlobal('fetch', htmlResponse('<p>&amp;lt;tag&amp;gt;</p>'));
    const out = await webFetch('https://example.com');
    // "&amp;lt;" must decode once to the literal "&lt;", NOT twice into "<".
    expect(out).toContain('&lt;tag&gt;');
    expect(out).not.toContain('<tag>');
  });

  it('decodes numeric and hex entities', async () => {
    vi.stubGlobal('fetch', htmlResponse('<p>caf&#233; &#x1F600;</p>'));
    const out = await webFetch('https://example.com');
    expect(out).toContain('café');
    expect(out).toContain('😀');
  });

  it('removes script blocks whose closing tag carries whitespace/attributes (js/bad-tag-filter)', async () => {
    vi.stubGlobal('fetch', htmlResponse(
      '<body>keep1<script>evil1()</script ><script type="x">evil2()</script bar>keep2</body>',
    ));
    const out = await webFetch('https://example.com');
    expect(out).toContain('keep1');
    expect(out).toContain('keep2');
    expect(out).not.toContain('evil1');
    expect(out).not.toContain('evil2');
  });

  it('strips nested tags leaving clean text with no markup', async () => {
    vi.stubGlobal('fetch', htmlResponse('<div><p><b>bold</b> &amp; <i>italic</i></p></div>'));
    const out = await webFetch('https://example.com');
    expect(out).toBe('bold & italic');
    expect(out).not.toContain('<');
  });
});

describe('webSearch — backend selection', () => {
  it('defaults to duckduckgo with no keys', () => {
    expect(searchBackend()).toBe('duckduckgo');
  });

  it('prefers SearXNG when OPENSWARM_SEARXNG_URL is set', async () => {
    vi.stubEnv('OPENSWARM_SEARXNG_URL', 'http://searxng:8080/');
    vi.stubEnv('TAVILY_KEY', 'tk');
    expect(searchBackend()).toBe('searxng');
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      expect(href).toContain('http://searxng:8080/search');
      expect(href).toContain('format=json');
      return new Response(JSON.stringify({
        results: [{ title: 'S', url: 'https://s.example', content: 'vega-search' }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    const out = await webSearch('q', 3);
    expect(out).toContain('S');
    expect(out).toContain('https://s.example');
    expect(out).toContain('vega-search');
  });

  it('prefers Tavily when TAVILY_KEY is set', async () => {
    vi.stubEnv('TAVILY_KEY', 'tk');
    expect(searchBackend()).toBe('tavily');
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t', content: 'snip' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    const out = await webSearch('q', 3);
    expect(String(f.mock.calls[0][0])).toContain('api.tavily.com');
    expect(out).toContain('T');
    expect(out).toContain('https://t');
  });

  it('uses Brave when BRAVE_SEARCH_KEY is set', async () => {
    vi.stubEnv('BRAVE_SEARCH_KEY', 'bk');
    expect(searchBackend()).toBe('brave');
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b', description: 'd' }] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    const out = await webSearch('q');
    expect(String(f.mock.calls[0][0])).toContain('brave.com');
    expect(out).toContain('B');
  });

  it('parses keyless DuckDuckGo HTML results', async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex.com%2Fa">Result A</a>' +
      '<a class="result__snippet">snippet a</a>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })));
    const out = await webSearch('q', 5);
    expect(out).toContain('Result A');
    expect(out).toContain('https://ex.com/a');
    expect(out).toContain('snippet a');
  });

  it('returns an error string (does not throw) on backend failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    const out = await webSearch('q');
    expect(out).toContain('Search failed');
    expect(out).toContain('TAVILY_KEY'); // keyless hint
  });
});
