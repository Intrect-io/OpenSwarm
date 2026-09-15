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
  it('returns the address in the Tailscale ULA range', async () => {
    await expect(
      withInterfaces({ en0: [iface('192.168.1.20')], utun3: [iface('fd7a:115c:a1e0::b601:f469')] }),
    ).resolves.toBe('fd7a:115c:a1e0::b601:f469');
  });

  it('returns undefined when no Tailscale interface is present', async () => {
    await expect(
      withInterfaces({ en0: [iface('192.168.1.20')] }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when only CGNAT addresses are present (not trusted)', async () => {
    await expect(
      withInterfaces({ en0: [iface('192.168.1.20')], utun3: [iface('100.95.20.1')] }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when only loopback is present', async () => {
    await expect(
      withInterfaces({ lo0: [iface('127.0.0.1', { internal: true })] }),
    ).resolves.toBeUndefined();
  });

  it('ignores internal interfaces', async () => {
    await expect(
      withInterfaces({ lo0: [iface('fd7a:115c:a1e0::1', { internal: true })] }),
    ).resolves.toBeUndefined();
  });

  it('prefers the first Tailscale ULA address', async () => {
    await expect(
      withInterfaces({
        utun3: [iface('fd7a:115c:a1e0::b601:f469')],
        utun4: [iface('fd7a:115c:a1e0::b602:f470')],
      }),
    ).resolves.toBe('fd7a:115c:a1e0::b601:f469');
  });
});

describe('isTailscaleAddress', () => {
  it('accepts Tailscale ULA addresses', async () => {
    const { isTailscaleAddress } = await import('./web.js');
    expect(isTailscaleAddress('fd7a:115c:a1e0::b601:f469')).toBe(true);
  });

  it('rejects CGNAT addresses (no longer trusted by range alone)', async () => {
    const { isTailscaleAddress } = await import('./web.js');
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
    expect(isTailscaleAddress('::ffff:100.123.244.103')).toBe(false);
  });

  it('rejects LAN, loopback, and addresses outside the Tailscale ULA range', async () => {
    const { isTailscaleAddress } = await import('./web.js');
    expect(isTailscaleAddress('192.168.50.196')).toBe(false);
    expect(isTailscaleAddress('127.0.0.1')).toBe(false);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('fd00::1')).toBe(false);
  });
});