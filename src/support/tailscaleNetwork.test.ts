import { isTailscaleAddress } from './tailscaleNetwork';

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