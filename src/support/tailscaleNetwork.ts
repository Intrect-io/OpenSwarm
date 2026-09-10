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
  // A URL-bar copy keeps the brackets and the port. '[fd7a:...]:3847' is the
  // exact spelling this daemon's own startup banner prints, so an operator who
  // copies the line they were just shown has to land somewhere.
  const bracketPort = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketPort) text = bracketPort[1];
  // '100.64.0.1:3847' is what you copy from a URL bar and '::ffff:100.64.0.1'
  // is what you copy from a log line on a dual-stack bind. Both used to fail
  // closed and silently, which presents as "still asked for a token" — the
  // symptom this path exists to remove. (AGT-4294)
  const quadPort = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{1,5}$/.exec(text);
  if (quadPort) text = quadPort[1];
  // The shape predicates below strip a '::ffff:' prefix before matching, so the
  // identity compare has to strip it too: otherwise a spelling passes the shape
  // check and then fails the allowlist, which is the same split that made the
  // trust path unusable in the first place (AGT-4290).
  if (text.startsWith('::ffff:')) {
    const rest = text.slice(7);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest) || isIPv6(rest)) text = rest;
  }
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
 * Only ULA addresses match here. A CGNAT address is Tailscale-shaped too, but
 * proving that takes the operator's allowlist — see `isAuthorizedTailscalePeer`.
 */
export function isTailscaleAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  // Trust only on ULA prefix; CGNAT range requires explicit peer identity verification
  return normalized.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * Tailscale's CGNAT range, 100.64.0.0/10.
 *
 * Shape only, and deliberately NOT trust: the range is shared with carrier-
 * grade NAT, so a client behind one can hold such an address without being on
 * any tailnet. It is meaningful only in combination with the operator's
 * explicit peer allowlist, which is how `isAuthorizedTailscalePeer` uses it.
 */
export function isTailscaleCgnatAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  // Anchored and fully quad-shaped, like `isAllowedOrigin`. Unanchored, this
  // accepted '100.64.0.1.evil', '100.64.0.1:3847' and '100.99.evil'. Every
  // caller today passes a socket address, so nothing was reachable — but this
  // is an exported "is this Tailscale" predicate and the next caller may hand
  // it a Host header.
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!m) return false;
  if (m.slice(2).some(part => Number(part) > 255)) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}

/** Either shape Tailscale hands out. Shape is not trust — see the callers. */
export function isTailscaleShapedAddress(address: string | undefined): boolean {
  return isTailscaleAddress(address) || isTailscaleCgnatAddress(address);
}

/**
 * Every address on the interface that carries this host's Tailscale ULA.
 *
 * The ULA prefix `fd7a:115c:a1e0::/48` is assigned by exactly one thing, so
 * the interface holding one IS the tailnet interface — and its CGNAT address
 * is then known to be Tailscale's rather than merely shaped like it.
 *
 * That distinction is the whole point. `100.64.0.0/10` is also handed out by
 * carrier-grade NAT (LTE, Starlink, many fixed ISPs) and by cloud CNIs
 * (100.96/12 is a stock Kubernetes pod range), so "the connection arrived on a
 * 100.x address of ours" does not mean "it arrived over Tailscale". A daemon on
 * a tethered uplink or in a pod would otherwise trust a listed peer address
 * reaching it over the carrier network. (AGT-4294)
 *
 * Empty when this host has no Tailscale ULA — see `isTailscaleLocalEnd`.
 */
export function tailscaleInterfaceAddresses(
  interfaces: NodeJS.Dict<{ address: string }[]> = networkInterfaces(),
): ReadonlySet<string> {
  const found = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    const entries = addresses ?? [];
    if (!entries.some(a => isTailscaleAddress(a.address))) continue;
    // The interface identifies the tailnet; the addresses that count as a
    // local end are still only Tailscale's own. Taking the whole interface
    // would enrol its LAN IPv4 and its link-local, and an on-link attacker
    // who lands a rogue `fd7a:115c:a1e0::/48` router advertisement on `en0`
    // would thereby turn that machine's ordinary LAN address into a trusted
    // local end — a request to it carries no Origin, which
    // `isTrustedLocalOrigin` allows by design.
    for (const a of entries) {
      if (isTailscaleShapedAddress(a.address)) found.add(canonicalIpv6(a.address));
    }
  }
  return found;
}

/**
 * Cached interface lookup.
 *
 * This runs on every authorized request, and `networkInterfaces()` is a
 * syscall. The TTL is short enough that a tailnet coming up mid-run is picked
 * up without a restart, and long enough that a burst of requests costs one
 * lookup.
 */
const INTERFACE_CACHE_MS = 30_000;
let cachedAddresses: ReadonlySet<string> | undefined;
let cachedAt = 0;

function currentTailscaleAddresses(now: number): ReadonlySet<string> {
  // abs, so an NTP step backwards expires the entry instead of pinning it —
  // and a pinned empty set is what engages the refusal above.
  if (cachedAddresses && Math.abs(now - cachedAt) < INTERFACE_CACHE_MS) return cachedAddresses;
  cachedAddresses = tailscaleInterfaceAddresses();
  cachedAt = now;
  // Re-arm the one-shot warning whenever the tailnet is back, so a second
  // outage is reported too. Latching it for the process lifetime would make
  // the `tailscale down` this branch exists for silent after the first time.
  if (cachedAddresses.size > 0) warnedNoUla = false;
  return cachedAddresses;
}

/**
 * Whether a connection arrived on this host's Tailscale interface.
 *
 * Fails closed when no ULA is present anywhere. Without one there is nothing
 * to identify the tailnet interface by, so the only rule left is the range
 * test — and that is exactly the rule interface scoping replaced, because
 * 100.64.0.0/10 is also carrier-grade NAT and a stock Kubernetes pod range.
 *
 * An earlier version fell back to it automatically, which was wrong twice
 * over. The condition is not "IPv6 is disabled", the case it was written for —
 * it is "no ULA right now", which `tailscale down` or a `tailscaled` restart
 * satisfies on an ordinary dual-stack host. Thirty seconds later the check
 * would have silently degraded, permanently, on a daemon that was fine a
 * moment earlier. And the degraded rule grants `POST /api/exec`.
 *
 * A host that genuinely cannot run IPv6 can opt in with
 * OPENSWARM_TAILSCALE_ALLOW_RANGE_LOCAL_END=true, which is a choice an
 * operator makes rather than a state they fall into.
 */
export function isTailscaleLocalEnd(
  address: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!address) return false;
  const normalized = canonicalIpv6(address);
  const onInterface = currentTailscaleAddresses(now);
  if (onInterface.size > 0) return onInterface.has(normalized);
  if (process.env.OPENSWARM_TAILSCALE_ALLOW_RANGE_LOCAL_END !== 'true') {
    if (!warnedNoUla) {
      warnedNoUla = true;
      console.warn('[Tailscale] No Tailscale ULA on any interface, so the tailnet interface '
        + 'cannot be identified; refusing Tailscale trust. If this host cannot run IPv6, set '
        + 'OPENSWARM_TAILSCALE_ALLOW_RANGE_LOCAL_END=true — that accepts any 100.64/10 address '
        + 'of this host, which carrier NAT and Kubernetes pod networks also use.');
    }
    return false;
  }
  return isTailscaleShapedAddress(normalized);
}

let warnedNoUla = false;

/** Drop the interface cache and the one-shot warning. */
export function resetTailscaleInterfaceCacheForTests(): void {
  warnedNoUla = false;
  cachedAddresses = undefined;
  cachedAt = 0;
}

/**
 * True only when the address is a Tailscale-shaped address AND appears in the
 * operator's explicit peer allowlist. This is the trust decision; range
 * membership alone never authorizes a request.
 */
export function isAuthorizedTailscalePeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = canonicalIpv6(address);
  // ULA or CGNAT: `tailscale status` prints the CGNAT address and MagicDNS is
  // commonly off, so CGNAT is the address an operator actually has to hand.
  // Refusing it outright meant the trust path existed and nobody could use it
  // (AGT-4294). The range alone still proves nothing — membership in the
  // operator's explicit list is what authorizes, exactly as before.
  if (!isTailscaleShapedAddress(normalized)) return false;
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
  const found = detectTailscaleAddresses();
  return found.ula ?? found.cgnat;
}

/**
 * Both addresses this host answers on, for the startup banner.
 *
 * The CGNAT one is what `tailscale status` prints and what an operator reaches
 * for, so printing only the ULA made a trusted address undiscoverable — half
 * of what AGT-4290 was reported as. (AGT-4294)
 */
export function detectTailscaleAddresses(): { ula?: string; cgnat?: string } {
  const out: { ula?: string; cgnat?: string } = {};
  for (const addresses of Object.values(networkInterfaces())) {
    const entries = (addresses ?? []).filter(a => !a.internal);
    if (!entries.some(a => isTailscaleAddress(a.address))) continue;
    for (const a of entries) {
      if (isTailscaleAddress(a.address)) out.ula ??= a.address;
      else if (isTailscaleCgnatAddress(a.address)) out.cgnat ??= a.address;
    }
  }
  return out;
}
