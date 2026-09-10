// ============================================
// OpenSwarm — who is allowed to call the HTTP API
// ============================================
//
// Split out of support/web.ts while adding the browser's own way to
// authenticate (AGT-4280). These functions decide, for every request, whether
// the caller presented an accepted credential or arrived from a network
// position the daemon trusts — one concern, previously interleaved with route
// handling in a 1650-line file, and the surface most worth reading on its own.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorizedTailscalePeer, isLoopbackAddress, isTailscaleLocalEnd } from './tailscaleNetwork.js';
import { isGraphQLRequest } from '../issues/graphql/server.js';

// CORS origin allowlist — hostname-strict match (no substring/prefix pitfalls)
export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const { protocol, hostname } = url;
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  // Exact hostname matches
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname === 'tauri.localhost') return true;

  // Tailscale CGNAT range: 100.64.0.0/10 → first octet 100, second 64–127
  const tailscaleMatch = hostname.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (tailscaleMatch) {
    const second = Number(tailscaleMatch[1]);
    if (second >= 64 && second <= 127) return true;
  }
  // Tailscale ULA, as a URL hostname: `new URL('http://[fd7a:…]:3847').hostname`
  // keeps the brackets. Without this, browsing to the IPv6 address passed the
  // socket check and then failed here — so neither Tailscale address worked for
  // a mutation: CGNAT was refused by the socket check, ULA by this one.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    if (hostname.slice(1, -1).toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  }
  return false;
}

export function isTrustedTailscaleRequest(req: IncomingMessage): boolean {
  return process.env.OPENSWARM_TRUST_TAILSCALE === 'true'
    // Range membership is not trust: the peer must be explicitly allowlisted.
    && isAuthorizedTailscalePeer(req.socket.remoteAddress)
    // ...and the connection must have arrived ON our Tailscale address.
    //
    // A ULA carries no allocation authority — anyone can assign
    // fd7a:115c:a1e0::… to their own interface. While the daemon bound IPv4
    // only, that was moot because nothing could reach the ULA at all. Binding
    // dual-stack (AGT-4290) makes it reachable over EVERY interface, so a
    // neighbour on the LAN could self-assign an allowlisted address and be
    // trusted. Requiring the local end of the socket to be a Tailscale address
    // means the packet was addressed to us through the tailnet, not to our LAN
    // address with a forged source.
    //
    // ...on the Tailscale interface, identified by the ULA it carries rather
    // than by address range. "Not globally routable" is not "same adjacency":
    // 100.64.0.0/10 is also carrier-grade NAT and a stock Kubernetes pod
    // range, so a range test would trust a listed peer reaching a tethered or
    // containerised daemon over the carrier network. (AGT-4294)
    //
    // Still defence in depth, not proof: an on-link attacker who can deliver a
    // frame to this host's MAC defeats it either way. Real proof needs the
    // Tailscale control plane — tailscaled's local API answers `whois` for a
    // source address — which this process does not talk to yet.
    //
    // The bar matters because trust here reaches POST /api/exec, which hands
    // an arbitrary prompt to a coding agent with shell access on this host.
    && isTailscaleLocalEnd(req.socket.localAddress)
    && isTrustedLocalOrigin(req);
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // Linear-time parse (no regex): 'Bearer' + one space/tab + token. A
  // backtracking /^Bearer\s+(.+)$/ is polynomial on adversarial whitespace runs.
  const prefix = header.slice(0, 7).toLowerCase();
  if (prefix !== 'bearer ' && prefix !== 'bearer\t') return null;
  return header.slice(7).trim() || null;
}

export function hasValidWebToken(req: IncomingMessage): boolean {
  const configuredToken = process.env.OPENSWARM_WEB_TOKEN?.trim();
  if (!configuredToken) return false;

  const presentedToken =
    extractBearerToken(req.headers.authorization) ||
    (Array.isArray(req.headers['x-openswarm-token'])
      ? req.headers['x-openswarm-token'][0]
      : req.headers['x-openswarm-token']);
  return presentedToken === configuredToken;
}

export function getEffectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

export function isTrustedLocalOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  if (!isAllowedOrigin(origin)) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  if (originUrl.hostname === 'tauri.localhost') return true;

  const host = req.headers.host;
  if (!host) return false;

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${originUrl.protocol}//${host}`);
  } catch {
    return false;
  }

  const sameHost = originUrl.hostname === hostUrl.hostname;
  const loopbackAlias = isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(hostUrl.hostname);
  return (sameHost || loopbackAlias) && getEffectivePort(originUrl) === getEffectivePort(hostUrl);
}

export function isAuthorizedMutation(req: IncomingMessage): boolean {
  if (hasValidWebToken(req)) return true;
  return (isLoopbackAddress(req.socket.remoteAddress) && isTrustedLocalOrigin(req))
    || isTrustedTailscaleRequest(req);
}

export function isAuthorizedLocalRead(req: IncomingMessage): boolean {
  if (hasValidWebToken(req)) return true;
  return (isLoopbackAddress(req.socket.remoteAddress) && isTrustedLocalOrigin(req))
    || isTrustedTailscaleRequest(req);
}

export function isMutatingApiRequest(pathname: string, method: string | undefined): boolean {
  return pathname.startsWith('/api/') && ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method ?? '');
}

export function isMutatingGraphQLRequest(requestUrl: URL, method: string | undefined): boolean {
  if (!isGraphQLRequest(requestUrl.pathname)) return false;
  if (['DELETE', 'PATCH', 'POST', 'PUT'].includes(method ?? '')) return true;
  if (method !== 'GET') return false;

  const query = requestUrl.searchParams.get('query') ?? '';
  return query.includes('mutation');
}

export function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Refuse a request because it carried no accepted credential.
 *
 * Marked, because 403 is not only ever about authentication: the warehouse
 * routes answer 403 for path containment ("Path escapes the warehouse",
 * "Symbolic-link targets are not accepted"), which says nothing about who the
 * caller is. A browser that treats every 403 as "you need a token" asks a
 * loopback operator — already authorized, possibly on a daemon with no token
 * configured at all — to paste a credential for a symlink refusal, and
 * overwrites the token it already had. The header lets the client tell the
 * gate's own refusal from every other 403. (AGT-4280)
 */
const AUTH_REQUIRED_HEADER = 'X-OpenSwarm-Auth';

export function writeAuthRequired(res: ServerResponse): void {
  res.setHeader(AUTH_REQUIRED_HEADER, 'token-required');
  writeJson(res, 403, { error: 'Forbidden' });
}

