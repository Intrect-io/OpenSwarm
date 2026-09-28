import { describe, expect, it } from 'vitest';
import {
  createPinnedPublicLookup,
  createPublicLookup,
  isPrivateIp,
  type DnsAllResolver,
} from './outboundUrl.js';

function resolverReturning(addresses: Array<{ address: string; family: number }>): DnsAllResolver {
  return (_hostname, _options, callback) => callback(null, addresses);
}

/**
 * undici drives this hook with `options.all` set and then reads the callback
 * arguments according to that flag. Answering with the other shape aborts every
 * connection with ERR_INVALID_IP_ADDRESS — a failure that looks like a network
 * outage rather than a bug, and that mocked-fetch suites cannot see.
 */
describe('createPublicLookup callback contract', () => {
  it('answers an all:true lookup with the address array undici expects', () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    const lookup = createPublicLookup(resolverReturning(addresses));
    const seen: unknown[] = [];
    lookup('example.com', { all: true }, (...args) => seen.push(args));
    expect(seen).toEqual([[null, addresses]]);
  });

  it('answers a single-address lookup with (address, family)', () => {
    const lookup = createPublicLookup(resolverReturning([{ address: '93.184.216.34', family: 4 }]));
    const seen: unknown[] = [];
    lookup('example.com', {}, (...args) => seen.push(args));
    expect(seen).toEqual([[null, '93.184.216.34', 4]]);
  });

  it('refuses the connection when any resolved address is private', () => {
    const lookup = createPublicLookup(resolverReturning([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]));
    let error: Error | null = null;
    lookup('rebind.example', { all: true }, (err) => { error = err; });
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as Error).message).toBe('Private network destinations are not allowed');
  });

  it('refuses the connection when the name resolves to nothing', () => {
    const lookup = createPublicLookup(resolverReturning([]));
    let error: Error | null = null;
    lookup('empty.example', { all: true }, (err) => { error = err; });
    expect(error).toBeInstanceOf(Error);
  });
});

/**
 * The connect-time hook publicFetch installs. It answers from the addresses
 * resolvePublicHttpUrl already validated instead of re-resolving, so a second
 * DNS answer cannot move the socket after the check (rebinding).
 */
describe('createPinnedPublicLookup', () => {
  it('answers both callback shapes from the pinned set without a DNS round-trip', () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    const lookup = createPinnedPublicLookup(addresses);
    const seen: unknown[] = [];
    lookup('example.com', { all: true }, (...args) => seen.push(args));
    lookup('example.com', {}, (...args) => seen.push(args));
    expect(seen).toEqual([
      [null, addresses],
      [null, '93.184.216.34', 4],
    ]);
  });

  it('refuses when the pinned set includes a private address', () => {
    const lookup = createPinnedPublicLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    let error: Error | null = null;
    lookup('rebind.example', { all: true }, (err) => { error = err; });
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as Error).message).toBe('Private network destinations are not allowed');
  });

  it('refuses an empty pinned set', () => {
    const lookup = createPinnedPublicLookup([]);
    let error: Error | null = null;
    lookup('empty.example', { all: true }, (err) => { error = err; });
    expect(error).toBeInstanceOf(Error);
  });
});

describe('isPrivateIp IPv6 canonicalization', () => {
  it.each([
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:0:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
  ])('rejects private address %s in expanded form', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it('keeps a public IPv6 destination eligible', () => {
    expect(isPrivateIp('2606:4700:4700:0:0:0:0:1111')).toBe(false);
  });

  // The IPv4 branch folds these into `a >= 224`; IPv6 has no such catch-all, so
  // each range needs its own guard or the "public only" boundary leaks.
  it.each([
    ['ff02::1', 'link-local all-nodes multicast'],
    ['ff05::1:3', 'site-local multicast'],
    ['ff0e::1', 'global-scope multicast'],
    ['fec0::1', 'deprecated site-local unicast'],
    ['feff::1', 'top of the site-local range'],
  ])('rejects %s (%s)', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  // These reach a private IPv4 while looking like ordinary global unicast, so a
  // guard that only matches the textual `::ffff:` shape lets them straight through.
  it.each([
    ['64:ff9b::127.0.0.1', 'NAT64, dotted form'],
    ['64:ff9b::7f00:1', 'NAT64, hex form'],
    ['2002:7f00:1::1', '6to4 wrapping 127.0.0.1'],
    ['2002:0a00:0001::1', '6to4 wrapping 10.0.0.1'],
    ['::127.0.0.1', 'v4-compatible loopback'],
  ])('rejects %s (%s)', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each([
    ['64:ff9b::8.8.8.8', 'NAT64 to a public resolver'],
    ['2002:0808:0808::1', '6to4 wrapping 8.8.8.8'],
  ])('still allows %s (%s)', (address) => {
    expect(isPrivateIp(address)).toBe(false);
  });

  // The notification guard listed the RFC 5737 documentation blocks while this
  // shared predicate let them through, so the same address read as private at
  // one boundary and public at the other. Both IPv4 literals and their
  // IPv4-mapped spellings have to agree. (AGT-3432)
  it.each([
    ['198.51.100.1', 'TEST-NET-2, literal'],
    ['198.51.100.254', 'TEST-NET-2, last host'],
    ['203.0.113.1', 'TEST-NET-3, literal'],
    ['203.0.113.254', 'TEST-NET-3, last host'],
    ['::ffff:c633:6401', 'TEST-NET-2 mapped'],
    ['::ffff:cb00:7101', 'TEST-NET-3 mapped'],
  ])('rejects %s (%s)', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each([
    ['198.51.99.1', 'one below TEST-NET-2'],
    ['198.51.101.1', 'one above TEST-NET-2'],
    ['203.0.112.1', 'one below TEST-NET-3'],
    ['203.0.114.1', 'one above TEST-NET-3'],
  ])('still allows %s (%s)', (address) => {
    expect(isPrivateIp(address)).toBe(false);
  });
});
