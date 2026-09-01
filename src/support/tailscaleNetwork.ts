import { networkInterfaces } from 'node:os';

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 
 * Checks if an address belongs to Tailscale's known ranges.
 * 
 * WARNING: This function currently only validates ULA prefix and MUST NOT be used
 * as a sole trust decision mechanism. All sensitive operations must verify peer
 * identity through Tailscale control plane (e.g., node key, capability check).
 * 
 	 * Only ULA addresses are accepted. CGNAT (100.64.0.0/10) is not trusted.
	 * Peer identity must be verified through the Tailscale control plane.
	 */
	export function isTailscaleAddress(address: string | undefined): boolean {
	  if (!address) return false;
	  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
	  // Trust only on ULA prefix; CGNAT range requires explicit peer identity verification
	  return normalized.toLowerCase().startsWith('fd7a:115c:a1e0:');
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
