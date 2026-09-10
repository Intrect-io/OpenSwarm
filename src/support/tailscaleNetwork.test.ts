import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The interface list `isTailscaleLocalEnd` reads.
 *
 * It takes no injection point — it is the live-host lookup, which is the
 * property under test — so the host is mocked instead. Assigning to this
 * between assertions is how an outage is staged.
 */
let interfaces: Record<string, { address: string }[]> = {};
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => interfaces };
});

import {
  isAuthorizedTailscalePeer, isTailscaleAddress, isTailscaleCgnatAddress,
  isTailscaleLocalEnd, isTailscaleShapedAddress, resetTailscaleInterfaceCacheForTests,
  tailscaleInterfaceAddresses,
} from './tailscaleNetwork.js';

const ULA = 'fd7a:115c:a1e0::bc01:c823';
const CGNAT = '100.95.200.28';
/** One interface carrying both, exactly as tailscaled presents it. */
const TAILNET_UP = {
  lo0: [{ address: '127.0.0.1' }],
  en0: [{ address: '192.168.50.43' }],
  utun2: [{ address: CGNAT }, { address: ULA }, { address: 'fe80::9e76:eff:fe49:b36f' }],
};

describe('isTailscaleAddress', () => {
  it('should reject CGNAT addresses without explicit identity proof', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
    expect(isTailscaleAddress('100.127.255.254')).toBe(false);
  });

  it('should accept Tailscale ULA addresses', () => {
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0:1234:5678:9abc:def0:1234')).toBe(true);
    expect(isTailscaleAddress('::ffff:fd7a:115c:a1e0::1')).toBe(true);
  });

  it('should reject non-Tailscale addresses', () => {
    expect(isTailscaleAddress('2001:db8::1')).toBe(false);
    expect(isTailscaleAddress('192.168.1.1')).toBe(false);
    expect(isTailscaleAddress('')).toBe(false);
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
  });

  it('does not trust CGNAT-only addresses without additional proof', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
    expect(isTailscaleAddress('100.65.0.1')).toBe(false);
    expect(isTailscaleAddress('100.127.255.254')).toBe(false);
  });

  it('continues to accept Tailscale ULA addresses', () => {
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0:ab12::1')).toBe(true);
  });

  it('rejects arbitrary 100.x.x.x addresses without Tailscale identity proof', () => {
    // CGNAT range is 100.64.0.0/10 — these should all be rejected
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
    expect(isTailscaleAddress('100.65.0.1')).toBe(false);
    expect(isTailscaleAddress('100.80.0.1')).toBe(false);
    expect(isTailscaleAddress('100.100.0.1')).toBe(false);
    expect(isTailscaleAddress('100.127.255.254')).toBe(false);
  });
});
describe('isAuthorizedTailscalePeer', () => {
  const PEER = 'fd7a:115c:a1e0::b601:f469';

  it('rejects a Tailscale-shaped address that is not explicitly allowlisted', () => {
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
    expect(isAuthorizedTailscalePeer(PEER)).toBe(false);
  });

  it('accepts only the exact peer named in OPENSWARM_TAILSCALE_PEERS', () => {
    process.env.OPENSWARM_TAILSCALE_PEERS = `${PEER}, 100.101.1.5`;
    expect(isAuthorizedTailscalePeer(PEER)).toBe(true);
    expect(isAuthorizedTailscalePeer(`::ffff:${PEER}`)).toBe(true);
    expect(isAuthorizedTailscalePeer('fd7a:115c:a1e0::other-peer')).toBe(false);
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('accepts the bracketed IPv6 spelling this daemon prints in its own banner', () => {
    // `web.ts` logs `http://[fd7a:...]:3847`. An operator copying the line
    // they were just shown must land somewhere; dropping it silently is the
    // same "still asked for a token" failure this path exists to remove.
    for (const entry of [`[${PEER}]:3847`, `[${PEER}]`, PEER.toUpperCase(), `${PEER}%utun2`]) {
      process.env.OPENSWARM_TAILSCALE_PEERS = entry;
      expect(isAuthorizedTailscalePeer(PEER), entry).toBe(true);
    }
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('refuses a CGNAT address that is not in the list — the range is never enough', () => {
    // This is the property the old "never authorizes CGNAT" case was really
    // protecting, and it is unchanged: 100.64.0.0/10 is shared with carrier
    // NAT, so holding such an address proves nothing on its own.
    process.env.OPENSWARM_TAILSCALE_PEERS = 'fd7a:115c:a1e0::b601:f469';
    expect(isAuthorizedTailscalePeer('100.64.0.1')).toBe(false);
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('authorizes a CGNAT address the operator named explicitly', () => {
    // `tailscale status` prints the CGNAT address and MagicDNS is commonly
    // off, so this is the address an operator actually has to hand. Refusing
    // it outright left the trust path working and unusable: the machine that
    // could reach the ULA was not the machine the browser was on (AGT-4294).
    // The doc comment on `authorizedTailscalePeers` has always given a CGNAT
    // address as an example of a valid entry.
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.126.196.94';
    expect(isAuthorizedTailscalePeer('100.126.196.94')).toBe(true);
    expect(isAuthorizedTailscalePeer('100.126.196.95')).toBe(false);
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('accepts an entry copied from a URL bar or a log line', () => {
    // Fail-closed either way, but both present as "still asked for a token",
    // and both get likelier with CGNAT.
    for (const entry of ['100.126.196.94:3847', '::ffff:100.126.196.94', '[100.126.196.94]', ' 100.126.196.94 ', '[100.126.196.94]:3847']) {
      process.env.OPENSWARM_TAILSCALE_PEERS = entry;
      expect(isAuthorizedTailscalePeer('100.126.196.94'), entry).toBe(true);
    }
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('still refuses an address outside both Tailscale ranges, listed or not', () => {
    // The list is named TAILSCALE_PEERS. Without a shape gate it would quietly
    // become a general allowlist, and a LAN address would read as a tailnet
    // peer.
    for (const addr of ['192.168.50.99', '10.0.0.5', '100.63.255.255', '100.128.0.1', 'fd00::1']) {
      process.env.OPENSWARM_TAILSCALE_PEERS = addr;
      expect(isAuthorizedTailscalePeer(addr), addr).toBe(false);
    }
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('rejects empty and undefined addresses', () => {
    expect(isAuthorizedTailscalePeer(undefined)).toBe(false);
    expect(isAuthorizedTailscalePeer('')).toBe(false);
  });
});


describe('isTailscaleCgnatAddress', () => {
  it('accepts the range Tailscale hands out, and only its second octet 64-127', () => {
    expect(isTailscaleCgnatAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleCgnatAddress('100.127.255.255')).toBe(true);
    expect(isTailscaleCgnatAddress('100.63.255.255')).toBe(false);
    expect(isTailscaleCgnatAddress('100.128.0.1')).toBe(false);
  });

  it('accepts the IPv4-mapped form, which is how a dual-stack bind delivers it', () => {
    expect(isTailscaleCgnatAddress('::ffff:100.126.196.94')).toBe(true);
  });

  it('requires a whole dotted quad, not a prefix of one', () => {
    // Unanchored, all of these passed. Nothing reaches it with a non-address
    // today, but it is exported and the next caller may pass a Host header.
    for (const bad of [
      '100.64.0.1.evil', '100.64.', '100.99.evil', '100.64.0.1:3847',
      '100.64.257.1', '100.65.0.0/10', ' 100.64.0.1', '100.64.0.1\n',
    ]) {
      expect(isTailscaleCgnatAddress(bad), bad).toBe(false);
    }
  });

  it('rejects nothing-like inputs', () => {
    expect(isTailscaleCgnatAddress(undefined)).toBe(false);
    expect(isTailscaleCgnatAddress('')).toBe(false);
    expect(isTailscaleCgnatAddress('fd7a:115c:a1e0::1')).toBe(false);
  });
});

describe('isTailscaleShapedAddress', () => {
  it('accepts either form Tailscale hands out, and nothing else', () => {
    expect(isTailscaleShapedAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleShapedAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleShapedAddress('192.168.1.1')).toBe(false);
    expect(isTailscaleShapedAddress('fd00::1')).toBe(false);
  });
});

describe('tailscaleInterfaceAddresses', () => {
  it('takes every address on the interface that carries the ULA, and no others', () => {
    // The ULA prefix is assigned by exactly one thing, so the interface
    // holding one IS the tailnet interface — and its CGNAT address is then
    // known to be Tailscale's rather than merely shaped like it.
    const got = tailscaleInterfaceAddresses({
      lo0: [{ address: '127.0.0.1' }],
      en0: [{ address: '192.168.50.43' }],
      // A carrier-NAT uplink: 100.x, but no ULA, so not the tailnet.
      pdp_ip0: [{ address: '100.71.3.9' }],
      // The link-local is on the tailnet interface and is NOT a Tailscale
      // address. A real `utun` always has one, so a fixture without it cannot
      // show what "every address on the interface" would have admitted.
      utun2: [{ address: CGNAT }, { address: ULA }, { address: 'fe80::9e76:eff:fe49:b36f' }],
    });

    expect([...got].sort()).toEqual([CGNAT, ULA]);
    expect(got.has('100.71.3.9')).toBe(false);
    expect(got.has('fe80::9e76:eff:fe49:b36f')).toBe(false);
  });

  it('does not enrol an interface\'s other addresses when a rogue RA lands a ULA on it', () => {
    // An on-link attacker can advertise `fd7a:115c:a1e0:dead::/64`; SLAAC then
    // auto-configures a matching address on `en0` with no privilege on this
    // host. Scoping to the interface must not promote that interface's plain
    // LAN address to a trusted local end — a request to it carries no Origin,
    // which `isTrustedLocalOrigin` allows by design, so the next hop would be
    // `POST /api/exec`.
    const got = tailscaleInterfaceAddresses({
      en0: [{ address: '192.168.50.196' }, { address: 'fd7a:115c:a1e0:dead::1' }],
    });

    expect(got.has('192.168.50.196')).toBe(false);
    expect(got.has('fd7a:115c:a1e0:dead::1')).toBe(true);
  });

  it('finds nothing when no interface carries a ULA', () => {
    expect(tailscaleInterfaceAddresses({ pdp_ip0: [{ address: '100.71.3.9' }] }).size).toBe(0);
  });
});

describe('isTailscaleLocalEnd', () => {
  afterEach(() => {
    interfaces = {};
    resetTailscaleInterfaceCacheForTests();
    vi.restoreAllMocks();
  });

  it('accepts this host\'s tailnet addresses and nothing else on that interface', () => {
    interfaces = TAILNET_UP;
    resetTailscaleInterfaceCacheForTests();

    expect(isTailscaleLocalEnd(CGNAT)).toBe(true);
    expect(isTailscaleLocalEnd(ULA)).toBe(true);
    // Same interface, not Tailscale's — see the rogue-RA case above.
    expect(isTailscaleLocalEnd('fe80::9e76:eff:fe49:b36f')).toBe(false);
    expect(isTailscaleLocalEnd('192.168.50.43')).toBe(false);
    expect(isTailscaleLocalEnd(undefined)).toBe(false);
    expect(isTailscaleLocalEnd('')).toBe(false);
  });

  it('expires the cache when the clock steps backwards', () => {
    // A pinned entry is not merely stale here: pinning an empty set keeps the
    // refusal engaged after the tailnet is back, and pinning a full one keeps
    // trust alive after it is gone. `Math.abs` is what makes a backward NTP
    // step expire rather than pin, and without this the mutant survives.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    interfaces = {};
    resetTailscaleInterfaceCacheForTests();
    const t0 = 1_000_000;
    expect(isTailscaleLocalEnd(CGNAT, t0)).toBe(false);

    interfaces = TAILNET_UP;
    // Inside the TTL going forward: still the cached empty set.
    expect(isTailscaleLocalEnd(CGNAT, t0 + 1_000)).toBe(false);
    // A step backwards is |delta| > TTL, so the entry expires and is re-read.
    expect(isTailscaleLocalEnd(CGNAT, t0 - 60_000)).toBe(true);
  });

  it('warns once per outage, not once per process', () => {
    // The doc comment names a `tailscaled` restart as the case this branch is
    // for, and a restart happens more than once. Latching the flag for the
    // process lifetime would make every outage after the first one silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    interfaces = {};
    resetTailscaleInterfaceCacheForTests();
    expect(isTailscaleLocalEnd(CGNAT, 0)).toBe(false);
    expect(isTailscaleLocalEnd(CGNAT, 1_000)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    interfaces = TAILNET_UP;
    expect(isTailscaleLocalEnd(CGNAT, 60_000)).toBe(true);

    interfaces = {};
    expect(isTailscaleLocalEnd(CGNAT, 120_000)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
