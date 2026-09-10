import { networkInterfaces } from 'node:os';

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** True only for Tailscale's IPv4 CGNAT block or its fixed ULA prefix. */
export function isTailscaleAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (normalized.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const match = normalized.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every(part => part >= 0 && part <= 255) && octets[0] >= 64 && octets[0] <= 127;
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

/**
 * Whether a remote socket address may be treated as a Tailscale peer for
 * authorization. CGNAT 100.64/10 is shared RFC 6598 space — only trust it when
 * THIS host actually has a Tailscale interface. The product-specific ULA prefix
 * is accepted on its own.
 */
export function isAuthorizedTailscaleRemote(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (normalized.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  // Shared CGNAT: require a local Tailscale iface so non-Tailscale CGNAT hosts
  // cannot satisfy OPENSWARM_TRUST_TAILSCALE alone.
  if (!detectTailscaleIP()) return false;
  return isTailscaleAddress(address);
}
