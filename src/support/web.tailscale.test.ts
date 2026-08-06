// ============================================
// OpenSwarm - Tailscale address detection tests
// ============================================
//
// The dashboard used to print a literal Tailscale address that belonged to one
// developer's machine. It was committed to a public repo and was wrong for
// every other user the moment Tailscale reassigned it. These tests pin both
// halves of the replacement: the address is derived from this host, and the
// literal never comes back.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

async function withInterfaces(interfaces: Record<string, unknown[]>) {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const networkInterfaces = () => interfaces;
    return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
  });
  const mod = await import('./web.js');
  return mod.detectTailscaleIP();
}

const iface = (address: string, over: Record<string, unknown> = {}) => ({
  address, family: 'IPv4', internal: false, netmask: '255.255.255.255', mac: '00:00:00:00:00:00', cidr: null, ...over,
});

describe('detectTailscaleIP', () => {
  it('returns the address in the Tailscale CGNAT range', async () => {
    await expect(
      withInterfaces({ en0: [iface('192.168.1.20')], utun3: [iface('100.95.200.28')] }),
    ).resolves.toBe('100.95.200.28');
  });

  it('accepts both ends of 100.64.0.0/10', async () => {
    await expect(withInterfaces({ utun3: [iface('100.64.0.1')] })).resolves.toBe('100.64.0.1');
    await expect(withInterfaces({ utun3: [iface('100.127.255.254')] })).resolves.toBe('100.127.255.254');
  });

  // 100.x outside /10 is ordinary public space — a host on 100.128.x is not on
  // Tailscale, and printing its address as the Tailscale URL would send the
  // user somewhere wrong.
  it('rejects 100.x addresses outside the CGNAT range', async () => {
    await expect(withInterfaces({ en0: [iface('100.128.0.1')] })).resolves.toBeUndefined();
    await expect(withInterfaces({ en0: [iface('100.63.255.255')] })).resolves.toBeUndefined();
  });

  it('ignores loopback and IPv6 entries', async () => {
    await expect(
      withInterfaces({
        lo0: [iface('100.95.200.28', { internal: true })],
        en0: [iface('fd7a:115c:a1e0::1', { family: 'IPv6' })],
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when Tailscale is not up', async () => {
    await expect(withInterfaces({ en0: [iface('192.168.1.20')] })).resolves.toBeUndefined();
  });

  // Guards the actual regression: a specific node's address baked into a public
  // source file. A CIDR mention like "100.64.0.0/10" is the range, not someone's
  // host, so the trailing-prefix form is allowed.
  it('does not hardcode any Tailscale host address in the source', () => {
    const source = readFileSync(new URL('./web.ts', import.meta.url), 'utf-8');
    const literals =
      source.match(/(?<!\d)100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\/\d)/g) ?? [];
    expect(literals).toEqual([]);
  });
});

describe('isTailscaleAddress', () => {
  it('accepts Tailscale IPv4, mapped IPv4, and ULA addresses', async () => {
    const { isTailscaleAddress } = await import('./web.js');
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('::ffff:100.123.244.103')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0::b601:f469')).toBe(true);
  });

  it('rejects LAN, loopback, and addresses outside the CGNAT range', async () => {
    const { isTailscaleAddress } = await import('./web.js');
    expect(isTailscaleAddress('192.168.50.196')).toBe(false);
    expect(isTailscaleAddress('127.0.0.1')).toBe(false);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('fd00::1')).toBe(false);
  });
});
