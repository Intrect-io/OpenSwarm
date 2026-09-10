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

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The Tailscale path now identifies its interface by the ULA that interface
// carries (AGT-4294), so these tests must name the host's addresses rather
// than inherit whatever the machine running them happens to have.
const DAEMON_ULA = 'fd7a:115c:a1e0::bc01:c823';
const DAEMON_CGNAT = '100.95.200.28';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    networkInterfaces: () => ({
      lo0: [{ address: '127.0.0.1' }],
      en0: [{ address: '192.168.50.43' }],
      // One interface carrying both, exactly as tailscaled presents it.
      utun2: [{ address: DAEMON_CGNAT }, { address: DAEMON_ULA }],
    }),
  };
});
import type { IncomingMessage } from 'node:http';

import {
  extractBearerToken, getEffectivePort, hasValidWebToken, isAllowedOrigin,
  isAuthorizedLocalRead, isAuthorizedMutation, isMutatingApiRequest,
  isMutatingGraphQLRequest, isTrustedLocalOrigin,
} from './webAuth.js';

/** A request shaped like the parts these predicates read. */
function req(opts: {
  origin?: string; host?: string; auth?: string; token?: string; remote?: string; local?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.host) headers.host = opts.host;
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.token) headers['x-openswarm-token'] = opts.token;
  return {
    headers,
    // `localAddress` is the address the connection arrived ON. The Tailscale
    // path checks it, so it is part of the request shape now.
    socket: { remoteAddress: opts.remote ?? '127.0.0.1', localAddress: opts.local ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const ORIGINAL = process.env.OPENSWARM_WEB_TOKEN;
const ORIGINAL_TRUST = process.env.OPENSWARM_TRUST_TAILSCALE;
const ORIGINAL_PEERS = process.env.OPENSWARM_TAILSCALE_PEERS;
beforeEach(async () => {
  (await import('./tailscaleNetwork.js')).resetTailscaleInterfaceCacheForTests();
  delete process.env.OPENSWARM_WEB_TOKEN;
  delete process.env.OPENSWARM_TRUST_TAILSCALE;
  delete process.env.OPENSWARM_TAILSCALE_PEERS;
});
afterEach(() => {
  // Restore rather than delete: these are read from the environment at call
  // time, so a leaked value changes what a later test file is even testing.
  for (const [key, value] of [
    ['OPENSWARM_WEB_TOKEN', ORIGINAL],
    ['OPENSWARM_TRUST_TAILSCALE', ORIGINAL_TRUST],
    ['OPENSWARM_TAILSCALE_PEERS', ORIGINAL_PEERS],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it('accepts an IPv4 client arriving mapped, which is how it arrives on a dual-stack bind', () => {
    // The server binds '::' so the Tailscale ULA is reachable at all
    // (AGT-4290). IPv4 clients then present as '::ffff:127.0.0.1' rather than
    // '127.0.0.1'. If this stopped being authorized, the bind change would
    // have locked every localhost browser out to fix the remote one.
    const r = req({ remote: '::ffff:127.0.0.1', origin: 'http://localhost:3847', host: 'localhost:3847' });
    expect(isAuthorizedLocalRead(r)).toBe(true);
    expect(isAuthorizedMutation(r)).toBe(true);
  });

  it('lets an allowlisted Tailscale ULA peer read without a token', () => {
    // The path AGT-4290 made reachable: trust on, peer named exactly, and the
    // Origin matching its own Host.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = 'fd7a:115c:a1e0::b601:f469';
    const r = req({
      remote: 'fd7a:115c:a1e0::b601:f469',
      local: 'fd7a:115c:a1e0::bc01:c823',
      origin: 'http://[fd7a:115c:a1e0::bc01:c823]:3847',
      host: '[fd7a:115c:a1e0::bc01:c823]:3847',
    });
    expect(isAuthorizedLocalRead(r)).toBe(true);
  });

  it('refuses an allowlisted ULA that did not arrive on our Tailscale address', () => {
    // The exposure the dual-stack bind opens: a ULA carries no allocation
    // authority, so a LAN neighbour can self-assign an allowlisted address.
    // Requiring the local end of the socket to be a Tailscale address means
    // the packet came to us through the tailnet, not to our LAN address with
    // a forged source.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = 'fd7a:115c:a1e0::b601:f469';
    const r = req({
      remote: 'fd7a:115c:a1e0::b601:f469',
      local: '192.168.50.43',
      origin: 'http://192.168.50.43:3847',
      host: '192.168.50.43:3847',
    });
    expect(isAuthorizedLocalRead(r)).toBe(false);
    expect(isAuthorizedMutation(r)).toBe(false);
  });

  it('accepts a peer written in any of the spellings IPv6 allows', () => {
    // Node hands us RFC 5952 on the wire. An operator who expanded the address
    // by hand, or copied it out of a URL bar with brackets, was refused — and
    // the symptom was "still asked for a token", the thing this fixes.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    const r = () => req({
      remote: 'fd7a:115c:a1e0::b601:f469',
      local: 'fd7a:115c:a1e0::bc01:c823',
      origin: 'http://[fd7a:115c:a1e0::bc01:c823]:3847',
      host: '[fd7a:115c:a1e0::bc01:c823]:3847',
    });
    for (const spelling of [
      'fd7a:115c:a1e0::b601:f469',
      'fd7a:115c:a1e0:0:0:0:b601:f469',
      'fd7a:115c:a1e0:0000:0000:0000:b601:f469',
      '[fd7a:115c:a1e0::b601:f469]',
      'FD7A:115C:A1E0::B601:F469',
    ]) {
      process.env.OPENSWARM_TAILSCALE_PEERS = spelling;
      expect(isAuthorizedLocalRead(r()), spelling).toBe(true);
    }
  });

  it('lets an allowlisted CGNAT peer read, arriving on our CGNAT address', () => {
    // The address `tailscale status` prints, which is the one an operator
    // types. Both ends are CGNAT here: the browser's source and the daemon's
    // own Tailscale address it connected to (AGT-4294).
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';
    const r = req({
      remote: '100.126.196.94',
      local: '100.95.200.28',
      origin: 'http://100.95.200.28:3847',
      host: '100.95.200.28:3847',
    });
    expect(isAuthorizedLocalRead(r)).toBe(true);
  });

  it('refuses Tailscale trust when no ULA identifies the tailnet interface', async () => {
    // Reached by `tailscale down` or a tailscaled restart, not only by IPv6
    // being disabled. Falling back to the range test there would trust a
    // listed peer arriving on a pod IP or a carrier-NAT uplink — the exact
    // widening interface scoping exists to prevent.
    const os = await import('node:os');
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ address: '100.96.4.17' }], tailscale0: [{ address: '100.95.200.28' }],
    } as never);
    (await import('./tailscaleNetwork.js')).resetTailscaleInterfaceCacheForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(async () => {
      spy.mockRestore();
      (await import('./tailscaleNetwork.js')).resetTailscaleInterfaceCacheForTests();
    });
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';

    const r = req({ remote: '100.126.196.94', local: '100.96.4.17', host: '100.96.4.17:3847' });
    expect(isAuthorizedLocalRead(r)).toBe(false);
    expect(isAuthorizedMutation(r)).toBe(false);

    // ...unless the operator explicitly accepts the weaker rule.
    process.env.OPENSWARM_TAILSCALE_ALLOW_RANGE_LOCAL_END = 'true';
    onTestFinished(() => { delete process.env.OPENSWARM_TAILSCALE_ALLOW_RANGE_LOCAL_END; });
    expect(isAuthorizedLocalRead(r)).toBe(true);
  });

  it('accepts the IPv4-mapped form both ends actually arrive in', () => {
    // The daemon binds '::' (AGT-4290), so an IPv4 client's remoteAddress AND
    // localAddress both arrive '::ffff:'-prefixed — verified against a real
    // dual-stack socket. Every other CGNAT case here uses the bare form, so
    // deleting the strip that makes production work left the suite green.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';
    const r = req({
      remote: '::ffff:100.126.196.94',
      local: '::ffff:100.95.200.28',
      host: '100.95.200.28:3847',
    });
    expect(isAuthorizedLocalRead(r)).toBe(true);
    expect(isAuthorizedMutation(r)).toBe(true);
  });

  it('refuses a listed peer that reached a 100.x address which is not ours', () => {
    // The reason the local end is matched against the interface rather than
    // the range: 100.64.0.0/10 is also carrier-grade NAT and a stock k8s pod
    // range, so a tethered or containerised daemon would otherwise trust a
    // listed peer arriving over the carrier network.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';
    for (const local of ['100.71.3.9', '100.96.4.17']) {
      const r = req({ remote: '100.126.196.94', local, host: `${local}:3847` });
      expect(isAuthorizedLocalRead(r), local).toBe(false);
      expect(isAuthorizedMutation(r), local).toBe(false);
    }
  });

  it('refuses a spoofed peer that reached us on a LAN address with no Origin', () => {
    // The case the local-end check actually exists for. A browser cannot
    // reach it — a LAN Origin is not on the allowlist and a cross-host Origin
    // fails the CSRF match — but a non-browser client sends no Origin at all,
    // and `isTrustedLocalOrigin` allows that by design (same-origin GETs do
    // not send one). So with a self-assigned allowlisted source aimed at our
    // LAN address, nothing else in the chain says no.
    //
    // 100.64.0.0/10 is not internet-routable, so arriving on our Tailscale
    // address is what says the packet came through the tailnet.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';
    const spoofed = req({ remote: '100.126.196.94', local: '192.168.50.43', host: '192.168.50.43:3847' });
    expect(isAuthorizedLocalRead(spoofed)).toBe(false);
    expect(isAuthorizedMutation(spoofed)).toBe(false);

    // Same request, arriving on the daemon's own Tailscale address: allowed.
    const viaTailnet = req({ remote: '100.126.196.94', local: '100.95.200.28', host: '100.95.200.28:3847' });
    expect(isAuthorizedLocalRead(viaTailnet)).toBe(true);
  });

  it('still refuses CGNAT that the operator never listed', () => {
    // 100.64.0.0/10 is shared with carriers, so the address proves no
    // identity. Binding dual-stack must not turn that judgement over.
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = 'fd7a:115c:a1e0::b601:f469';
    const r = req({
      remote: '100.123.244.103',
      // Arriving on our own Tailscale address, so the local-end check passes
      // and the allowlist is the only thing that can refuse this. Without
      // this line the default '127.0.0.1' refused it for the wrong reason and
      // deleting the allowlist check left the test green.
      local: '100.95.200.28',
      origin: 'http://100.95.200.28:3847',
      host: '100.95.200.28:3847',
    });
    expect(isAuthorizedLocalRead(r)).toBe(false);
    expect(isAuthorizedMutation(r)).toBe(false);
  });

  it('refuse loopback when the Origin is not trusted', () => {
    const r = req({ remote: '127.0.0.1', origin: 'http://evil.com', host: 'localhost:3847' });
    expect(isAuthorizedMutation(r)).toBe(false);
  });
});
