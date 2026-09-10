import { networkInterfaces } from 'node:os';

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
    const peer = entry.trim().toLowerCase();
    if (peer) peers.add(peer);
  }
  return peers;
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
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address.toLowerCase();
  if (!isTailscaleAddress(normalized)) return false;
  return authorizedTailscalePeers().has(normalized);
}

/** This machine's Tailscale IPv4 address, detected dynamically. */
export function detectTailscaleIP(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (isTailscaleAddress(address.address)) return address.address;
    }
  }
  return undefined;
}
