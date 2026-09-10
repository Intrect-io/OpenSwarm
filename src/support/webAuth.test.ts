// ============================================
// OpenSwarm — who the HTTP API lets in (AGT-4280)
// ============================================
//
// This surface had no tests of its own. It was extracted from web.ts, which is
// excluded from coverage as an effectful boundary — so these pure predicates,
// the ones that decide whether a request is authorized at all, were never
// exercised directly.
//
// The gap was not theoretical. `isAllowedOrigin` accepts a Tailscale CGNAT
// Origin (100.64/10), while `isTailscaleAddress` — narrowed in #579 — rejects
// a CGNAT socket address outright. One half of the check expects CGNAT
// browsing and the other calls it impossible, so neither Tailscale address
// worked for a mutation: CGNAT was refused by the socket check, and the ULA
// form was refused here, because a bracketed IPv6 hostname matched none of the
// allowed shapes. A test on either function alone would have passed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';

import {
  extractBearerToken, getEffectivePort, hasValidWebToken, isAllowedOrigin,
  isAuthorizedLocalRead, isAuthorizedMutation, isMutatingApiRequest,
  isMutatingGraphQLRequest, isTrustedLocalOrigin,
} from './webAuth.js';

/** A request shaped like the parts these predicates read. */
function req(opts: {
  origin?: string; host?: string; auth?: string; token?: string; remote?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.host) headers.host = opts.host;
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.token) headers['x-openswarm-token'] = opts.token;
  return { headers, socket: { remoteAddress: opts.remote ?? '127.0.0.1' } } as unknown as IncomingMessage;
}

const ORIGINAL = process.env.OPENSWARM_WEB_TOKEN;
beforeEach(() => { delete process.env.OPENSWARM_WEB_TOKEN; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENSWARM_WEB_TOKEN;
  else process.env.OPENSWARM_WEB_TOKEN = ORIGINAL;
});

describe('isAllowedOrigin', () => {
  it('accepts loopback and the desktop shell', () => {
    expect(isAllowedOrigin('http://localhost:3847')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3847')).toBe(true);
    expect(isAllowedOrigin('https://tauri.localhost')).toBe(true);
  });

  it('accepts the Tailscale CGNAT range, and only its second octet 64-127', () => {
    expect(isAllowedOrigin('http://100.95.200.28:3847')).toBe(true);
    expect(isAllowedOrigin('http://100.64.0.1:3847')).toBe(true);
    expect(isAllowedOrigin('http://100.127.255.255:3847')).toBe(true);
    // 100.0.0.0/10 and 100.128.0.0/9 are ordinary public space.
    expect(isAllowedOrigin('http://100.63.0.1:3847')).toBe(false);
    expect(isAllowedOrigin('http://100.128.0.1:3847')).toBe(false);
  });

  it('accepts the Tailscale ULA, which a URL hostname keeps in brackets', () => {
    // Without this the IPv6 address — the one #579 left as the only trusted
    // socket shape — could pass the socket check and then fail here.
    expect(isAllowedOrigin('http://[fd7a:115c:a1e0::bc01:c823]:3847')).toBe(true);
    expect(isAllowedOrigin('http://[fd7a:115c:a1e0::b601:f469]:3847')).toBe(true);
    // A different ULA is not Tailscale's.
    expect(isAllowedOrigin('http://[fd00::1]:3847')).toBe(false);
    expect(isAllowedOrigin('http://[::1]:3847')).toBe(false);
  });

  it('rejects other hosts, other schemes, and unparseable values', () => {
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('file:///etc/passwd')).toBe(false);
    expect(isAllowedOrigin('javascript:alert(1)')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);
  });
});

describe('isTrustedLocalOrigin', () => {
  it('allows a request that sends no Origin at all', () => {
    // Same-origin GETs do not send one; refusing them would break every read.
    expect(isTrustedLocalOrigin(req())).toBe(true);
  });

  it('refuses an Origin that is not on the allowlist', () => {
    expect(isTrustedLocalOrigin(req({ origin: 'http://evil.com', host: 'localhost:3847' }))).toBe(false);
  });

  it('refuses an unparseable Origin', () => {
    expect(isTrustedLocalOrigin(req({ origin: 'http://', host: 'localhost:3847' }))).toBe(false);
  });

  it('requires a Host header to compare against', () => {
    expect(isTrustedLocalOrigin(req({ origin: 'http://localhost:3847' }))).toBe(false);
  });

  it('matches Origin against Host, treating loopback spellings as one host', () => {
    expect(isTrustedLocalOrigin(req({ origin: 'http://localhost:3847', host: 'localhost:3847' }))).toBe(true);
    expect(isTrustedLocalOrigin(req({ origin: 'http://127.0.0.1:3847', host: 'localhost:3847' }))).toBe(true);
    // A cross-host Origin that happens to be allowlisted must still not pass:
    // this is the CSRF check, not a second allowlist.
    expect(isTrustedLocalOrigin(req({ origin: 'http://100.95.200.28:3847', host: 'localhost:3847' }))).toBe(false);
  });

  it('always accepts the desktop shell, whose Host never matches', () => {
    expect(isTrustedLocalOrigin(req({ origin: 'https://tauri.localhost', host: 'localhost:3847' }))).toBe(true);
  });
});

describe('getEffectivePort', () => {
  it('uses the explicit port when there is one', () => {
    expect(getEffectivePort(new URL('http://localhost:3847'))).toBe('3847');
  });

  it('falls back to the scheme default, so :80 and no port compare equal', () => {
    expect(getEffectivePort(new URL('http://localhost'))).toBe('80');
    expect(getEffectivePort(new URL('https://localhost'))).toBe('443');
  });
});

describe('extractBearerToken', () => {
  it('reads the token after either separator the header allows', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('Bearer\tabc123')).toBe('abc123');
  });

  it('rejects anything that is not a bearer credential', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer    ')).toBeNull();
  });

  it('does not backtrack on a long whitespace run', () => {
    // The parse is linear on purpose: /^Bearer\s+(.+)$/ is polynomial here.
    const started = Date.now();
    expect(extractBearerToken(`Bearer ${' '.repeat(50_000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('hasValidWebToken', () => {
  it('is false when the daemon configures no token, whatever is presented', () => {
    expect(hasValidWebToken(req({ token: 'anything' }))).toBe(false);
  });

  it('accepts the configured token through either header', () => {
    process.env.OPENSWARM_WEB_TOKEN = 'secret';
    expect(hasValidWebToken(req({ token: 'secret' }))).toBe(true);
    expect(hasValidWebToken(req({ auth: 'Bearer secret' }))).toBe(true);
  });

  it('rejects a wrong or absent token', () => {
    process.env.OPENSWARM_WEB_TOKEN = 'secret';
    expect(hasValidWebToken(req({ token: 'wrong' }))).toBe(false);
    expect(hasValidWebToken(req())).toBe(false);
  });
});

describe('isMutatingApiRequest', () => {
  it('counts every write verb under /api/', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isMutatingApiRequest('/api/provider', m)).toBe(true);
    }
    expect(isMutatingApiRequest('/api/stats', 'GET')).toBe(false);
    expect(isMutatingApiRequest('/static/x.js', 'POST')).toBe(false);
    expect(isMutatingApiRequest('/api/x', undefined)).toBe(false);
  });
});

describe('isMutatingGraphQLRequest', () => {
  const at = (q?: string) => new URL(`http://localhost:3847/graphql${q ? `?query=${encodeURIComponent(q)}` : ''}`);

  it('treats any write verb on /graphql as mutating', () => {
    expect(isMutatingGraphQLRequest(at(), 'POST')).toBe(true);
    expect(isMutatingGraphQLRequest(at(), 'DELETE')).toBe(true);
  });

  it('reads the query string on GET, because a GET can carry a mutation', () => {
    expect(isMutatingGraphQLRequest(at('mutation { x }'), 'GET')).toBe(true);
    expect(isMutatingGraphQLRequest(at('query { x }'), 'GET')).toBe(false);
    expect(isMutatingGraphQLRequest(at(), 'GET')).toBe(false);
  });

  it('ignores verbs that write nothing, and other paths', () => {
    expect(isMutatingGraphQLRequest(at('mutation { x }'), 'HEAD')).toBe(false);
    expect(isMutatingGraphQLRequest(new URL('http://localhost:3847/api/stats'), 'POST')).toBe(false);
  });
});

describe('isAuthorizedMutation / isAuthorizedLocalRead', () => {
  it('accept a valid token from anywhere', () => {
    process.env.OPENSWARM_WEB_TOKEN = 'secret';
    const r = req({ token: 'secret', remote: '192.168.50.99', origin: 'http://evil.com', host: 'x' });
    expect(isAuthorizedMutation(r)).toBe(true);
    expect(isAuthorizedLocalRead(r)).toBe(true);
  });

  it('accept loopback with a trusted origin', () => {
    const r = req({ remote: '127.0.0.1', origin: 'http://localhost:3847', host: 'localhost:3847' });
    expect(isAuthorizedMutation(r)).toBe(true);
    expect(isAuthorizedLocalRead(r)).toBe(true);
  });

  it('refuse a LAN address with no credential — the case that read as a dead daemon', () => {
    const r = req({ remote: '192.168.50.99', host: '192.168.50.43:3847' });
    expect(isAuthorizedMutation(r)).toBe(false);
    expect(isAuthorizedLocalRead(r)).toBe(false);
  });

  it('refuse loopback when the Origin is not trusted', () => {
    const r = req({ remote: '127.0.0.1', origin: 'http://evil.com', host: 'localhost:3847' });
    expect(isAuthorizedMutation(r)).toBe(false);
  });
});
