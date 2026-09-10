// @vitest-environment jsdom
//
// The dashboard could not authenticate from a browser at all (AGT-4280): 36
// bare `fetch("/api/…")` call sites, a server that reads only the
// `X-OpenSwarm-Token` / `Authorization` headers, and no UI to supply one. The
// page worked solely from a network position the server already trusts, so an
// operator on a LAN address saw every data endpoint return 403 while
// `/api/health` — which sits in front of the gate — kept answering 200. The
// dashboard rendered, showed nothing, and read as a dead daemon.
//
// These tests pin the two properties that make the seam worth having: it
// cannot be bypassed by a call site that forgets it, and it never sends the
// token anywhere but this origin's gated endpoints.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Installer = (scope: { fetch: typeof fetch }) => typeof fetch;
interface WebTokenApi {
  TOKEN_KEY: string;
  HEADER: string;
  readToken(): string;
  storeToken(token: string): void;
  isGatedRequest(input: unknown): boolean;
  resetForTests(): void;
  install: Installer;
  installEventSource(scope: Record<string, unknown>): void;
}

let api: WebTokenApi;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  await import('../../web/static/js/webToken.js');
  api = (window as unknown as { OpenSwarmWebToken: WebTokenApi }).OpenSwarmWebToken;
});

/** A scope with its own mocked transport, so each test observes only its own calls. */
function scopeWith(responder: (input: RequestInfo | URL, init?: RequestInit) => Response) {
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => responder(input, init));
  const scope = { fetch: transport as unknown as typeof fetch };
  api.install(scope);
  return { scope, transport };
}

/** A 403 shaped like the gate's own refusal — the only kind that may prompt. */
function authRefusal(): Response {
  return new Response('{"error":"Forbidden"}', {
    status: 403,
    headers: { 'X-OpenSwarm-Auth': 'token-required' },
  });
}

function headerOf(call: [RequestInfo | URL, RequestInit?] | undefined): string | null {
  if (!call) return null;
  return new Headers(call[1]?.headers).get('X-OpenSwarm-Token');
}

/** Fill in and submit the prompt the wrapper appends on a 403. */
async function answerPrompt(token: string): Promise<void> {
  const input = await vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('#openswarm-token-input');
    expect(el).toBeTruthy();
    return el!;
  });
  input.value = token;
  input.form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

describe('browser access token seam (AGT-4280)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    api.resetForTests();
  });

  it('attaches the stored token to same-origin API requests', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'secret-token');
    const { scope, transport } = scopeWith(() => new Response('{}', { status: 200 }));

    await scope.fetch('/api/stats');

    expect(headerOf(transport.mock.calls[0])).toBe('secret-token');
  });

  it('covers a call site that never asked for authentication', async () => {
    // This is the whole point of wrapping `fetch` instead of editing 36 call
    // sites: `api.mjs` and the dashboard's inline script both call the global
    // with no headers of their own, and both are still authorized.
    sessionStorage.setItem(api.TOKEN_KEY, 'secret-token');
    const { scope, transport } = scopeWith(() => new Response('{}', { status: 200 }));

    await scope.fetch('/api/projects', { method: 'POST', body: '{}' });

    expect(headerOf(transport.mock.calls[0])).toBe('secret-token');
    expect(transport.mock.calls[0][1]?.method).toBe('POST');
  });

  it('preserves headers the caller set', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'secret-token');
    const { scope, transport } = scopeWith(() => new Response('{}', { status: 200 }));

    await scope.fetch('/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const sent = new Headers(transport.mock.calls[0][1]?.headers);
    expect(sent.get('Content-Type')).toBe('application/json');
    expect(sent.get('X-OpenSwarm-Token')).toBe('secret-token');
  });

  it('never sends the token to another origin', async () => {
    // The token authorizes this daemon. A page that also talks to GitHub or a
    // CDN must not hand it over.
    sessionStorage.setItem(api.TOKEN_KEY, 'secret-token');
    const { scope, transport } = scopeWith(() => new Response('{}', { status: 200 }));

    await scope.fetch('https://example.com/api/stats');

    expect(headerOf(transport.mock.calls[0])).toBeNull();
    expect(api.isGatedRequest('https://example.com/api/stats')).toBe(false);
  });

  it('leaves same-origin non-API requests alone', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'secret-token');
    const { scope, transport } = scopeWith(() => new Response('', { status: 200 }));

    await scope.fetch('/static/js/theme.mjs');

    expect(headerOf(transport.mock.calls[0])).toBeNull();
  });

  it('asks for a token on 403 and retries the same request with it', async () => {
    const { scope, transport } = scopeWith((_input, init) => {
      const presented = new Headers(init?.headers).get('X-OpenSwarm-Token');
      return presented === 'entered-token'
        ? new Response('{"ok":true}', { status: 200 })
        : authRefusal();
    });

    const pending = scope.fetch('/api/stats');
    await answerPrompt('entered-token');
    const res = await pending;

    expect(res.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(api.TOKEN_KEY)).toBe('entered-token');
  });

  it('asks once however many requests were refused at the same time', async () => {
    // The dashboard fires several requests in one Promise.all, so a 403 storm
    // is the normal case. One prompt per in-flight request would be unusable.
    const { scope, transport } = scopeWith((_input, init) => {
      const presented = new Headers(init?.headers).get('X-OpenSwarm-Token');
      return presented === 'entered-token'
        ? new Response('{}', { status: 200 })
        : authRefusal();
    });

    const all = Promise.all([
      scope.fetch('/api/stats'),
      scope.fetch('/api/projects'),
      scope.fetch('/api/tasks'),
    ]);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    expect(document.querySelectorAll('#openswarm-token-prompt')).toHaveLength(1);

    await answerPrompt('entered-token');
    const results = await all;

    expect(results.every(r => r.status === 200)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it('hands back the original 403 when the prompt is dismissed, without retrying', async () => {
    // An operator who does not have the token needs a way out. Without one,
    // every refused request stays pending forever and the page just stops —
    // worse than the 403, because nothing on screen reports anything. And a
    // retry with no token would fail identically and ask again forever.
    const { scope, transport } = scopeWith(() => authRefusal());

    const pending = scope.fetch('/api/stats');
    const dismiss = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('#openswarm-token-dismiss');
      expect(el).toBeTruthy();
      return el!;
    });
    dismiss.click();

    const res = await pending;
    expect(res.status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(api.TOKEN_KEY)).toBeNull();
  });

  it('treats an empty submission as no answer, and Escape as a dismissal', async () => {
    const { scope, transport } = scopeWith(() => authRefusal());

    const pending = scope.fetch('/api/stats');
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('#openswarm-token-input');
      expect(el).toBeTruthy();
      return el!;
    });
    // Empty submit must not settle the prompt — the operator is still typing.
    input.form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(document.querySelector('#openswarm-token-input')).toBeTruthy();

    document.querySelector('#openswarm-token-prompt')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const res = await pending;
    expect(res.status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('names the cause on screen instead of only failing', async () => {
    // A bare "Forbidden" told the operator nothing — half of why a healthy
    // daemon read as a dead one.
    const { scope } = scopeWith(() => authRefusal());

    void scope.fetch('/api/stats');
    const banner = await vi.waitFor(() => {
      const el = document.querySelector('#openswarm-token-prompt');
      expect(el).toBeTruthy();
      return el!;
    });

    expect(banner.textContent).toContain('OPENSWARM_WEB_TOKEN');
    await answerPrompt('x');
  });

  it('does not prompt for a 403 that is not about the credential', async () => {
    // The warehouse routes answer 403 for path containment ("Path escapes the
    // warehouse"), which says nothing about who is calling. Prompting there
    // asks a loopback operator — already authorized — to paste a credential
    // for a symlink refusal, and overwrites the token they already had.
    sessionStorage.setItem(api.TOKEN_KEY, 'good-token');
    const { scope, transport } = scopeWith(
      () => new Response('{"error":"Path escapes the warehouse"}', { status: 403 }),
    );

    const res = await scope.fetch('/api/warehouse/tree?path=../etc');

    expect(res.status).toBe(403);
    expect(document.querySelector('#openswarm-token-prompt')).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(api.TOKEN_KEY)).toBe('good-token');
  });

  it('keeps the old token when the entered one is also refused', async () => {
    // Storing before the retry wrote a typo into the key warehouse.mjs reads,
    // destroying a working token for the whole session on one bad paste.
    sessionStorage.setItem(api.TOKEN_KEY, 'good-token');
    const { scope } = scopeWith(() => authRefusal());

    const pending = scope.fetch('/api/stats');
    await answerPrompt('typo');
    const res = await pending;

    expect(res.status).toBe(403);
    expect(sessionStorage.getItem(api.TOKEN_KEY)).toBe('good-token');
  });

  it('retries through the untouched transport, so a wrong token cannot recurse', async () => {
    // If the retry went through the wrapper instead of the captured native
    // fetch, a persistently refused token would chain prompt → 403 → prompt
    // without bound. Both counts below stay flat under that mutation only if
    // this is asserted directly.
    const { scope, transport } = scopeWith(() => authRefusal());

    const pending = scope.fetch('/api/stats');
    await answerPrompt('wrong-token');
    const res = await pending;

    expect(res.status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#openswarm-token-prompt')).toHaveLength(0);
  });

  it('stops asking once the operator has declined', async () => {
    // Every call site reconnects or re-polls, so a prompt that forgets a
    // refusal returns within seconds and steals focus each time.
    const { scope } = scopeWith(() => authRefusal());

    const first = scope.fetch('/api/stats');
    const dismiss = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('#openswarm-token-dismiss');
      expect(el).toBeTruthy();
      return el!;
    });
    dismiss.click();
    await first;

    const second = await scope.fetch('/api/stats');
    expect(second.status).toBe(403);
    expect(document.querySelector('#openswarm-token-prompt')).toBeNull();
  });

  it('does not retry a Request whose body the first attempt consumed', async () => {
    // Reissuing a used Request throws "Cannot construct a Request with a
    // Request object that has already been used" — the caller would get a
    // rejected promise where it expected a Response.
    const { scope, transport } = scopeWith(() => authRefusal());

    const res = await scope.fetch(new Request(new URL('/api/provider', location.href).href, { method: 'POST', body: '{}' }));

    expect(res.status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#openswarm-token-prompt')).toBeNull();
  });

  it('degrades to unauthenticated rather than throwing when storage is blocked', async () => {
    // A browser set to block site data throws on getItem. An unhandled throw
    // here would take down the wrapper every request now depends on.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    const { scope, transport } = scopeWith(() => new Response('{}', { status: 200 }));

    await expect(scope.fetch('/api/stats')).resolves.toBeDefined();
    expect(headerOf(transport.mock.calls[0])).toBeNull();

    getItem.mockRestore();
  });
});

describe('live event stream over an authenticated fetch (AGT-4280)', () => {
  // `EventSource` cannot set headers, so wrapping fetch alone left /api/events
  // at 403 — measured in a real browser as 11 of 14 requests authorized, the
  // three exceptions all being the SSE connection. The page loaded its data
  // once and then never updated, which is most of what "dead daemon" looked
  // like.

  class FakeNativeEventSource {
    static built: string[] = [];
    constructor(public url: string) { FakeNativeEventSource.built.push(url); }
    close(): void { /* nothing to release */ }
  }

  /** A scope whose fetch answers with an SSE body fed from `frames`. */
  function sseScope(frames: string[], status = 200) {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (status !== 200) return new Response('{"error":"Forbidden"}', { status });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const scope: Record<string, unknown> = {
      fetch: transport as unknown as typeof fetch,
      EventSource: FakeNativeEventSource,
    };
    api.install(scope as { fetch: typeof fetch });
    api.installEventSource(scope);
    return { scope, transport };
  }

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    api.resetForTests();
    FakeNativeEventSource.built = [];
  });

  it('sends the token on the stream request', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    const { scope, transport } = sseScope(['data: {"type":"stats"}\n\n']);

    const Ctor = scope.EventSource as new (url: string) => { onmessage: ((e: { data: string }) => void) | null };
    const es = new Ctor('/api/events');
    const seen: string[] = [];
    es.onmessage = (e) => seen.push(e.data);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(headerOf(transport.mock.calls[0])).toBe('stream-token');
    expect(seen[0]).toBe('{"type":"stats"}');
  });

  it('leaves the native implementation alone when there is no token', () => {
    // A trusted network position already works there, and the native object is
    // far better tested than this stand-in.
    const { scope } = sseScope([]);

    const Ctor = scope.EventSource as new (url: string) => unknown;
    const es = new Ctor('/api/events');

    expect(es).toBeInstanceOf(FakeNativeEventSource);
    expect(FakeNativeEventSource.built).toEqual(['/api/events']);
  });

  it('ignores the server comment frame and joins multi-line data', async () => {
    // The server opens with `:connected\n\n`, which carries no payload; a
    // message with empty data there would reach handleEvent as a JSON parse
    // failure on every connect.
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    const { scope } = sseScope([':connected\n\n', 'data: one\ndata: two\n\n']);

    const Ctor = scope.EventSource as new (url: string) => { onmessage: ((e: { data: string }) => void) | null };
    const es = new Ctor('/api/events');
    const seen: string[] = [];
    es.onmessage = (e) => seen.push(e.data);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe('one\ntwo');
  });

  it('reassembles a frame split across chunks', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    const { scope } = sseScope(['data: {"ty', 'pe":"log"}\n', '\n']);

    const Ctor = scope.EventSource as new (url: string) => { onmessage: ((e: { data: string }) => void) | null };
    const es = new Ctor('/api/events');
    const seen: string[] = [];
    es.onmessage = (e) => seen.push(e.data);

    await vi.waitFor(() => expect(seen).toEqual(['{"type":"log"}']));
  });

  it('reports a finished stream as an error so the caller reconnects', async () => {
    // Every call site reconnects from onerror. A stream that simply ended with
    // no error would leave the page silently disconnected.
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    const { scope } = sseScope(['data: x\n\n']);

    const Ctor = scope.EventSource as new (url: string) => {
      onmessage: ((e: { data: string }) => void) | null;
      onerror: (() => void) | null;
      close(): void;
    };
    const es = new Ctor('/api/events');
    let errors = 0;
    es.onerror = () => { errors += 1; es.close(); };

    await vi.waitFor(() => expect(errors).toBe(1));
    // close() inside onerror is what the real call sites do; it must not
    // produce a second error.
    await new Promise(r => setTimeout(r, 10));
    expect(errors).toBe(1);
  });

  it('does not report an error for a stream the caller closed on purpose', async () => {
    // close() aborts the request, which rejects the pending read and lands in
    // the same catch that reports a dropped connection. Reporting it would
    // make a deliberate close indistinguishable from a network drop — and
    // dashboardHtml's connectSSE reconnects unconditionally from onerror, so
    // a closed stream would resurrect itself every three seconds forever.
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    let release: (() => void) | null = null;
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: a\n\n'));
          // Stay open until the abort lands, so close() is what ends it.
          init?.signal?.addEventListener('abort', () => {
            try { controller.error(new Error('aborted')); } catch { /* already closed */ }
          });
          release = () => { try { controller.close(); } catch { /* closed */ } };
        },
      });
      return new Response(body, { status: 200 });
    });
    const scope: Record<string, unknown> = {
      fetch: transport as unknown as typeof fetch,
      EventSource: FakeNativeEventSource,
    };
    api.install(scope as { fetch: typeof fetch });
    api.installEventSource(scope);

    const Ctor = scope.EventSource as new (url: string) => {
      onmessage: ((e: { data: string }) => void) | null;
      onerror: (() => void) | null;
      close(): void;
    };
    const es = new Ctor('/api/events');
    let errors = 0;
    const seen: string[] = [];
    es.onerror = () => { errors += 1; };
    es.onmessage = (e) => seen.push(e.data);

    await vi.waitFor(() => expect(seen).toEqual(['a']));
    es.close();
    await new Promise(r => setTimeout(r, 30));

    expect(errors).toBe(0);
    void release;
  });

  it('stops delivering messages once closed', async () => {
    sessionStorage.setItem(api.TOKEN_KEY, 'stream-token');
    const { scope } = sseScope(['data: a\n\n', 'data: b\n\n']);

    const Ctor = scope.EventSource as new (url: string) => {
      onmessage: ((e: { data: string }) => void) | null;
      onerror: (() => void) | null;
      close(): void;
    };
    const es = new Ctor('/api/events');
    const seen: string[] = [];
    es.onmessage = (e) => { seen.push(e.data); es.close(); };

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 20));
    expect(seen).toEqual(['a']);
  });
});
