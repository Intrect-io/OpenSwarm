import { networkInterfaces } from 'node:os';
import { isIPv6 } from 'node:net';

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Explicitly authorized Tailscale peer identities.
 *
 * Range membership (CGNAT 100.64.0.0/10 or the Tailscale ULA fd7a:115c:a1e0::/48)
 * is NOT evidence of trust: the CGNAT range is shared with other carriers and
 * the ULA prefix is identical on every Tailscale tailnet. Trust requires the
 * operator to name the exact peer address in OPENSWARM_TAILSCALE_PEERS
 * (comma-separated IPs, e.g. "100.101.1.5,fd7a:115c:a1e0::b601:f469").
 */
export function authorizedTailscalePeers(): ReadonlySet<string> {
  const raw = process.env.OPENSWARM_TAILSCALE_PEERS ?? '';
  const peers = new Set<string>();
  for (const entry of raw.split(',')) {
    const peer = canonicalIpv6(entry.trim());
    if (peer) peers.add(peer);
  }
  return peers;
}

/**
 * One spelling per address.
 *
 * IPv6 has many textual forms of the same address and Node hands us RFC 5952
 * canonical form on the wire, so a plain string compare rejects an operator
 * who wrote the expanded form — or who copied the address out of a browser and
 * kept the brackets. That failure is closed, but it presents as "still asked
 * for a token", which is the exact symptom this whole path exists to remove.
 */
export function canonicalIpv6(value: string): string {
  let text = value.trim().toLowerCase();
  if (!text) return '';
  // A URL-bar copy keeps the brackets; a zone suffix names a local interface
  // and is not part of the address identity.
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!isIPv6(text)) return text;
  // Round-trip through the platform parser: URL normalises to RFC 5952, the
  // same form `remoteAddress` arrives in.
  try {
    return new URL(`http://[${text}]`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return text;
  }
}

/**
 * Checks if an address belongs to Tailscale's known ranges.
 *
 * WARNING: This function only validates that the address is *shaped* like a
 * Tailscale address. It MUST NOT be used as a sole trust decision mechanism.
 * All sensitive operations must additionally verify peer identity through
 * `isAuthorizedTailscalePeer` (operator-configured allowlist) or the Tailscale
 * control plane (node key / capability check).
 *
 * Only ULA addresses are accepted. CGNAT (100.64.0.0/10) is not trusted.
 */
export function isTailscaleAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  // Trust only on ULA prefix; CGNAT range requires explicit peer identity verification
  return normalized.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * True only when the address is a Tailscale-shaped address AND appears in the
 * operator's explicit peer allowlist. This is the trust decision; range
 * membership alone never authorizes a request.
 */
export function isAuthorizedTailscalePeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = canonicalIpv6(address.startsWith('::ffff:') ? address.slice(7) : address);
  if (!isTailscaleAddress(normalized)) return false;
  return authorizedTailscalePeers().has(normalized);
}

/**
 * This machine's Tailscale address, detected dynamically.
 *
 * Previously this skipped every non-IPv4 interface and then asked
 * `isTailscaleAddress`, which only ever accepts the IPv6 ULA prefix — two
 * conditions that cannot both hold, so it always returned undefined and the
 * startup banner fell through to "token required" even on a Tailscale-only
 * daemon. That banner is what an operator reads to find out how to connect.
 */
export function detectTailscaleIP(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (isTailscaleAddress(address.address)) return address.address;
    }
  }
  return undefined;
}
