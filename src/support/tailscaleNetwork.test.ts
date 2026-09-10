import { describe, expect, it } from 'vitest';
import { isAuthorizedTailscalePeer, isTailscaleAddress } from './tailscaleNetwork.js';

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

  it('never authorizes CGNAT addresses, even when allowlisted', () => {
    process.env.OPENSWARM_TAILSCALE_PEERS = '100.64.0.1';
    expect(isAuthorizedTailscalePeer('100.64.0.1')).toBe(false);
    delete process.env.OPENSWARM_TAILSCALE_PEERS;
  });

  it('rejects empty and undefined addresses', () => {
    expect(isAuthorizedTailscalePeer(undefined)).toBe(false);
    expect(isAuthorizedTailscalePeer('')).toBe(false);
  });
});
