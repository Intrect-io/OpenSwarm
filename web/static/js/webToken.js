// Browser-side access token for the daemon's HTTP API — a classic (non-module)
// script so it runs synchronously in <head>, before any page's inline script
// issues its first request. A deferred module would let those first calls go
// out unauthenticated. Same placement rationale as themeBoot.js. (AGT-4280)
//
// The problem this exists to remove: `hasValidWebToken()` in support/web.ts
// accepts only an `Authorization: Bearer` or `X-OpenSwarm-Token` header, and
// the Supervisor dashboard sent neither — across 36 separate fetch call sites,
// with no UI to enter a token and no query/cookie path. A browser could not
// authenticate at all. The page worked only from a network position the server
// already trusts (loopback, or — until the Tailscale trust was narrowed — any
// CGNAT peer), so an operator on a LAN address got `403 Forbidden` on every
// data endpoint while `/api/health` kept answering 200 from in front of the
// gate. The dashboard rendered, showed nothing, and looked like a dead daemon.
//
// Two decisions worth stating, because both had a tempting cheaper option:
//
//   * The header is attached at ONE seam — a `window.fetch` wrapper — rather
//     than at each call site. Editing 36 call sites gives 36 chances to miss
//     one, and a missed one fails as a silent 403, which is this defect
//     exactly. As a wrapper, "no request escapes" is a property of the page
//     instead of a property of reviewer attention.
//   * The token is NOT read from the URL. A `?token=` would work on the first
//     try and then sit in browser history, in the referrer of every outbound
//     link, and in any screenshot of the address bar. web/static/js/warehouse.mjs
//     already established the alternative — a password input backed by
//     sessionStorage — and this shares its storage key so one token unlocks
//     both pages.

(function () {
  'use strict';

  /** Shared with web/static/js/warehouse.mjs — one entry unlocks both pages. */
  var TOKEN_KEY = 'openswarm.webToken';
  var HEADER = 'X-OpenSwarm-Token';
  /** Set by the server only on its authorization refusals (support/web.ts). */
  var AUTH_HEADER = 'X-OpenSwarm-Auth';

  // sessionStorage throws rather than returning null in a browser configured to
  // block site data, and an unhandled throw here would take down the wrapper
  // that every request now depends on. Absent storage degrades to "no token",
  // which is the pre-existing behaviour, not a new failure.
  function readToken() {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  function storeToken(token) {
    try {
      if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
      else window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Non-fatal: the token still authorizes this page for its lifetime via
      // the in-memory value the caller holds.
    }
  }

  /**
   * The pathname of a same-origin request, or null for anything else.
   *
   * Cross-origin requests must never carry the token — it authorizes this
   * daemon and nothing else. `input` may be a string, a URL, or a Request.
   */
  function sameOriginPath(input) {
    var raw;
    if (typeof input === 'string') raw = input;
    else if (input && typeof input.url === 'string') raw = input.url;
    else if (input && typeof input.href === 'string') raw = input.href;
    else return null;
    var url;
    try {
      // `document.baseURI`, not `location.href`: that is the base `fetch`
      // resolves against. They differ under a `<base href>`, and an injected
      // one would send `/api/x` to another host while this still called it
      // same-origin — attaching the token to a cross-origin request.
      url = new URL(raw, document.baseURI || window.location.href);
    } catch {
      return null;
    }
    return url.origin === window.location.origin ? url.pathname : null;
  }

  /**
   * Whether a request goes to a gated endpoint.
   *
   * Mirrors support/web.ts: `/api/*` and the GraphQL endpoint sit behind the
   * authorization gates. `/api/health` is exempt there ("diagnostics, not
   * authentication") but is included here anyway — sending the header to an
   * endpoint that ignores it costs nothing, and leaving a carve-out in two
   * places invites them to drift apart.
   */
  function isGatedRequest(input) {
    var path = sameOriginPath(input);
    if (!path) return false;
    return path.indexOf('/api/') === 0 || path === '/graphql';
  }

  /**
   * Whether the request can be issued a second time.
   *
   * A `Request` object's body is consumed by the first fetch — reissuing it
   * throws `Cannot construct a Request with a Request object that has already
   * been used` — and a `ReadableStream` body is equally single-shot. Returning
   * the original 403 is worse than a retry but far better than a rejected
   * promise where the caller expected a Response.
   */
  function isRetryable(input, init) {
    if (typeof input !== 'string' && !(typeof URL === 'function' && input instanceof URL)) return false;
    var body = init && init.body;
    if (!body) return true;
    return !(typeof ReadableStream === 'function' && body instanceof ReadableStream);
  }

  function withToken(input, init, token) {
    var source = (init && init.headers) !== undefined
      ? init.headers
      : (input && input.headers) || undefined;
    var headers = new Headers(source);
    if (token) headers.set(HEADER, token);
    var next = {};
    if (init) {
      for (var key in init) {
        if (Object.prototype.hasOwnProperty.call(init, key)) next[key] = init[key];
      }
    }
    next.headers = headers;
    return next;
  }

  // ---- Recovery UI -------------------------------------------------------
  // Built here rather than in each page's markup so any page that loads this
  // script gets the recovery path, and so a page cannot ship the wrapper
  // without the means to satisfy it.

  // Colours come from tokens.css, which every page loading this script also
  // links — hardcoded hex is a repo gate failure (tests/web/tokens.test.ts),
  // and a second palette would drift from the theme the operator chose.
  // Without tokens.css the banner renders unstyled but stays usable.
  var promptEl = null;

  function buildPrompt() {
    if (promptEl) return promptEl;
    var wrap = document.createElement('div');
    wrap.id = 'openswarm-token-prompt';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Access token required');
    wrap.style.cssText = [
      'position:fixed', 'inset-inline:0', 'top:0', 'z-index:9999',
      'display:flex', 'gap:8px', 'align-items:center', 'flex-wrap:wrap',
      'padding:10px 14px', 'font:14px system-ui,sans-serif',
      'background:var(--bg-elevated)', 'color:var(--fg-primary)',
      'border-bottom:1px solid var(--border)',
    ].join(';');

    var label = document.createElement('span');
    // The message names the cause and the fix. A bare "Forbidden" told the
    // operator nothing, which is half of why this looked like a dead daemon.
    label.textContent = 'This daemon requires an access token. Paste OPENSWARM_WEB_TOKEN to load data '
      + '(Dismiss stops asking until you reload):';
    label.style.cssText = 'flex:1 1 320px';

    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'openswarm-token-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Access token');
    input.style.cssText = 'flex:0 1 280px;padding:6px 8px;border-radius:var(--radius-md);border:1px solid var(--border-strong);background:var(--bg-app);color:inherit';

    var button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Unlock';
    button.style.cssText = 'padding:6px 14px;border-radius:var(--radius-md);border:0;background:var(--accent);color:var(--fg-on-accent);cursor:pointer';

    // Without a way out, an operator who does not have the token leaves every
    // refused request pending forever and the page simply stops — a worse
    // failure than the 403 it replaced, because nothing on screen even
    // reports an error. Dismissing hands the original 403 back to the caller
    // so its own error path runs.
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.id = 'openswarm-token-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = 'padding:6px 14px;border-radius:var(--radius-md);border:1px solid var(--border-strong);background:transparent;color:inherit;cursor:pointer';

    var form = document.createElement('form');
    form.style.cssText = 'display:contents';
    form.appendChild(input);
    form.appendChild(button);
    form.appendChild(dismiss);

    wrap.appendChild(label);
    wrap.appendChild(form);
    promptEl = { root: wrap, form: form, input: input, dismiss: dismiss };
    return promptEl;
  }

  /**
   * Ask for the token once, however many requests failed.
   *
   * The dashboard fires several requests in one `Promise.all`, so a 403 storm
   * is the normal case rather than the exception. Without this the operator
   * would be handed one prompt per in-flight request.
   */
  var pending = null;
  // Set once the operator says no. Every call site reconnects or re-polls —
  // dashboardHtml's SSE after 3s, its pollers at 15/30/60s — so a prompt that
  // forgets a refusal reappears seconds later and steals focus each time. That
  // is the "page unusable" failure Dismiss was added to prevent, arriving
  // through the reconnect loop instead of through a hung promise.
  var declined = false;

  function requestToken() {
    if (declined) return Promise.resolve('');
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      if (!document.body) {
        resolve('');
        return;
      }
      var ui = buildPrompt();
      if (!ui.root.isConnected) document.body.appendChild(ui.root);
      ui.input.focus();

      function settle(value) {
        ui.form.removeEventListener('submit', onSubmit);
        ui.dismiss.removeEventListener('click', onDismiss);
        ui.root.removeEventListener('keydown', onKeydown);
        ui.input.value = '';
        if (ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
        resolve(value);
      }
      function onSubmit(event) {
        event.preventDefault();
        var value = ui.input.value.trim();
        if (!value) return;
        settle(value);
      }
      function onDismiss() { declined = true; settle(''); }
      function onKeydown(event) { if (event.key === 'Escape') { declined = true; settle(''); } }

      ui.form.addEventListener('submit', onSubmit);
      ui.dismiss.addEventListener('click', onDismiss);
      ui.root.addEventListener('keydown', onKeydown);
    }).then(function (token) {
      pending = null;
      return token;
    });
    return pending;
  }

  // ---- The seam ----------------------------------------------------------

  var INSTALLED = '__openswarmWebTokenInstalled';

  function install(target) {
    var scope = target || window;
    // Two copies of the script would give two prompts sharing one element id
    // and up to three transport calls for one request.
    if (scope[INSTALLED]) return scope.fetch;
    var nativeFetch = scope.fetch.bind(scope);
    try {
      Object.defineProperty(scope, INSTALLED, { value: true, enumerable: false, configurable: true });
    } catch { scope[INSTALLED] = true; }

    scope.fetch = function (input, init) {
      if (!isGatedRequest(input)) return nativeFetch(input, init);

      var token = readToken();
      return nativeFetch(input, withToken(input, init, token)).then(function (response) {
        // Only the gate's OWN refusal means "you need a token". 403 is also how
        // the warehouse routes report path containment ("Path escapes the
        // warehouse"), which says nothing about the caller — prompting there
        // would ask a loopback operator, already authorized and possibly on a
        // daemon with no token configured, to paste a credential for a symlink
        // refusal, and would overwrite the token they already had.
        if (response.status !== 403) return response;
        if (response.headers.get(AUTH_HEADER) !== 'token-required') return response;
        if (!isRetryable(input, init)) return response;
        return requestToken().then(function (entered) {
          // No token entered: hand back the original 403 so the caller's own
          // error path runs. Retrying without one would loop.
          if (!entered) return response;
          return nativeFetch(input, withToken(input, init, entered)).then(function (retried) {
            // Persist only what actually worked. Storing before the retry wrote
            // a typo into the key warehouse.mjs also reads, destroying a valid
            // token for the whole session on one mistyped paste.
            if (retried.status !== 403) storeToken(entered);
            return retried;
          });
        });
      });
    };

    return nativeFetch;
  }

  // ---- Live event stream ---------------------------------------------------
  //
  // `EventSource` cannot set request headers — the spec gives it no way — so
  // wrapping `fetch` fixes every data endpoint and leaves `/api/events` at 403.
  // Measured in a real browser against the built dashboard: 11 of 14 requests
  // carried the token and the three that did not were all the SSE connection.
  // The page would load its data once and then never update again, which is
  // most of what "the dashboard is dead" looked like in the first place.
  //
  // The alternatives were a token in the query string (lands in server access
  // logs) or a cookie (adds a CSRF surface to a server that currently has
  // none). Reading the stream with `fetch` instead keeps the credential in the
  // header where it already is, and routes it through the seam above.
  //
  // Only the surface the four call sites actually use is implemented —
  // `onopen`, `onmessage`, `onerror`, `close()`. None uses `addEventListener`
  // for named events, `lastEventId`, or `instanceof`, and every one of them
  // does its own reconnect on `onerror`, so this does not reconnect either.
  // The server emits `data: <json>\n\n` frames and one `:connected` comment;
  // there are no `event:` or `id:` fields to honour (core/eventHub.ts:227).

  function makeTokenEventSource(scope, NativeEventSource) {
    function TokenEventSource(url) {
      var self = this;
      this.readyState = 0;
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._closed = false;
      this._controller = typeof AbortController === 'function' ? new AbortController() : null;

      // The wrapped fetch, deliberately: it attaches the token and, on a 403,
      // offers the prompt and retries — so entering a token revives the stream
      // along with everything else.
      scope.fetch(url, {
        signal: this._controller ? this._controller.signal : undefined,
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
      }).then(function (response) {
        if (!response.ok || !response.body) throw new Error('SSE HTTP ' + response.status);
        if (self._closed) {
          // close() landed before the response did. Without an AbortController
          // to have aborted it, the connection would otherwise stay open while
          // the caller reconnects every three seconds, exhausting the per-host
          // connection budget.
          try { response.body.cancel(); } catch { /* already released */ }
          return undefined;
        }
        self.readyState = 1;
        if (self.onopen) self.onopen({ type: 'open' });
        return self._pump(response.body.getReader());
      }).catch(function () {
        self._fail();
      });
    }

    TokenEventSource.prototype._pump = function (reader) {
      var self = this;
      var decoder = new TextDecoder();
      var buffer = '';
      function read() {
        return reader.read().then(function (chunk) {
          // A finished stream is a dropped connection as far as the caller is
          // concerned — it reconnects on error, and without this it would sit
          // silently on a stream that ended.
          if (chunk.done) { self._fail(); return undefined; }
          buffer += decoder.decode(chunk.value, { stream: true });
          // Both delimiters, because stripping a trailing `\r` per line while
          // splitting only on `\n\n` is a false reassurance: `\r\n\r\n`
          // contains no `\n\n`, so a CRLF producer would buffer forever and
          // dispatch nothing. The server writes `\n\n` today (eventHub.ts:242).
          var index, width;
          for (;;) {
            var lf = buffer.indexOf('\n\n');
            var crlf = buffer.indexOf('\r\n\r\n');
            if (lf === -1 && crlf === -1) break;
            if (crlf !== -1 && (lf === -1 || crlf < lf)) { index = crlf; width = 4; }
            else { index = lf; width = 2; }
            var block = buffer.slice(0, index);
            buffer = buffer.slice(index + width);
            var payload = [];
            var lines = block.split('\n');
            for (var i = 0; i < lines.length; i += 1) {
              var line = lines[i].charAt(lines[i].length - 1) === '\r'
                ? lines[i].slice(0, -1)
                : lines[i];
              // `:comment` frames (the server's `:connected` handshake) carry
              // no payload and must not surface as a message with empty data.
              if (line.indexOf('data:') !== 0) continue;
              var value = line.slice(5);
              payload.push(value.charAt(0) === ' ' ? value.slice(1) : value);
            }
            if (payload.length && !self._closed && self.onmessage) {
              self.onmessage({ data: payload.join('\n') });
            }
          }
          return read();
        });
      }
      return read();
    };

    /** Report the drop once. Callers close() inside onerror, so re-entry is normal. */
    TokenEventSource.prototype._fail = function () {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 2;
      if (this.onerror) this.onerror({ type: 'error' });
    };

    TokenEventSource.prototype.close = function () {
      this._closed = true;
      this.readyState = 2;
      if (this._controller) {
        try { this._controller.abort(); } catch { /* already aborted */ }
      }
    };

    return function (url) {
      // No token means either a trusted network position — where the native
      // implementation already works and is better tested — or no credential
      // to send, in which case this changes nothing. Keep the blast radius on
      // the path that is actually broken.
      if (!readToken()) return new NativeEventSource(url);
      return new TokenEventSource(url);
    };
  }

  var ES_INSTALLED = '__openswarmEventSourceInstalled';

  function installEventSource(scope) {
    if (scope[ES_INSTALLED]) return;
    var Native = scope.EventSource;
    // Needs fetch streaming; without it the native object is still the best
    // available answer even though it cannot authenticate.
    if (!Native || typeof TextDecoder !== 'function') return;
    scope.EventSource = makeTokenEventSource(scope, Native);
    try {
      Object.defineProperty(scope, ES_INSTALLED, { value: true, enumerable: false, configurable: true });
    } catch { scope[ES_INSTALLED] = true; }
  }

  // Exposed for tests and for pages that want to manage the token themselves.
  // Not a stable public API.
  window.OpenSwarmWebToken = {
    TOKEN_KEY: TOKEN_KEY,
    HEADER: HEADER,
    readToken: readToken,
    storeToken: storeToken,
    isGatedRequest: isGatedRequest,
    install: install,
    installEventSource: installEventSource,
    // `declined` is deliberately module-scoped — it must outlive every request
    // on the page — which makes it leak between tests. Same shape as the
    // reset helpers elsewhere in the repo.
    resetForTests: function () { declined = false; pending = null; promptEl = null; },
  };

  install(window);
  installEventSource(window);
})();
