import { lookup } from 'node:dns/promises';
import { lookup as lookupCallback } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const [head, tail] = normalized.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail !== undefined
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return true;
  const words = groups.map((part) => Number.parseInt(part || '0', 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return true;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8
  // multicast. The IPv4 branch folds multicast and reserved space into `a >= 224`;
  // IPv6 needs them named explicitly or a destination like ff02::1 reads as public.
  if ((words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xffc0) === 0xfec0 ||
    (words[0] & 0xff00) === 0xff00) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIpv4(mapped);
  const hexMapped = normalized.match(/::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const compatibleV4 = words.slice(0, 6).every((word) => word === 0) ||
    (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff);
  if (compatibleV4) {
    return isPrivateIpv4(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`);
  }
  return false;
}

/** Resolve and reject destinations that can reach the local machine or a private network. */
export async function assertPublicHttpUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) URLs are allowed');
  if (url.username || url.password) throw new Error('Webhook URLs must not contain userinfo');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private network destinations are not allowed');
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private network destinations are not allowed');
    return url;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('Private network destinations are not allowed');
  }
  return url;
}

interface ResolvedAddress { address: string; family: number }

/** Injectable so the callback contract below can be tested without real DNS. */
export type DnsAllResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void,
) => void;

/**
 * Build the `connect.lookup` hook that pins a request to a public address.
 *
 * Two contracts are easy to get wrong here, and both fail closed only by luck:
 * undici invokes this with `options.all` set and then expects the *matching*
 * callback shape — an array when `all` is true, `(address, family)` otherwise.
 * Answering with the wrong shape aborts every connection with
 * ERR_INVALID_IP_ADDRESS rather than any SSRF-related error.
 */
export function createPublicLookup(resolve: DnsAllResolver = lookupCallback as unknown as DnsAllResolver) {
  return function publicLookup(
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: (error: Error | null, addresses: ResolvedAddress[] | string, family?: number) => void,
  ): void {
    resolve(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
        return callback(new Error('Private network destinations are not allowed'), '', 0);
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

let sharedPublicAgent: Agent | undefined;

function publicNetworkAgent(): Agent {
  sharedPublicAgent ??= new Agent({ connect: { lookup: createPublicLookup() } });
  return sharedPublicAgent;
}

/**
 * Fetch that refuses private destinations before connecting and pins the
 * resolved address, so a rebinding answer cannot move the socket after the
 * check.
 *
 * undici's own `fetch` is required: a dispatcher built from the npm `undici`
 * package is rejected by the copy of undici bundled inside Node's global
 * `fetch` ("invalid onError method"), which would fail every request.
 */
export async function publicFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const validated = await assertPublicHttpUrl(String(url));
  // undici's Response is spec-compatible with the global one; the DOM lib types
  // are structurally distinct, so cross the boundary once, here.
  return undiciFetch(validated.toString(), {
    ...(init as Record<string, unknown>),
    dispatcher: publicNetworkAgent(),
  } as never) as unknown as Response;
}

/** Cheap configuration-time check; send-time validation also resolves DNS. */
export function isPotentiallyPublicHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    return !isIP(hostname) || !isPrivateIp(hostname);
  } catch {
    return false;
  }
}
