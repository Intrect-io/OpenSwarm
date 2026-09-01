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

  test('does not trust CGNAT-only addresses without additional proof', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(false);
    expect(isPrivateIPv4('100.64.0.1')).toBe(true);
  });

  test('continues to accept Tailscale ULA addresses', () => {
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0:ab12::1')).toBe(true);
  });
});
