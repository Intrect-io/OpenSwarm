import { describe, expect, it } from 'vitest';
import { isLoopbackRemote } from './oauthPkce.js';

/**
 * The OpenAI redirect_uri is always the advertised localhost form. Callbacks may
 * still arrive over IPv4 127.0.0.1 or IPv6 ::1, and Node reports an IPv4 client
 * on a dual-stack socket in the IPv4-mapped form.
 */
describe('isLoopbackRemote (OpenAI PKCE callback)', () => {
  it('accepts the IPv4 and IPv6 loopback remotes Node reports', () => {
    expect(isLoopbackRemote('127.0.0.1')).toBe(true);
    expect(isLoopbackRemote('::1')).toBe(true);
    expect(isLoopbackRemote('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback remotes that must never drive the callback', () => {
    expect(isLoopbackRemote(undefined)).toBe(false);
    expect(isLoopbackRemote('')).toBe(false);
    expect(isLoopbackRemote('10.0.0.1')).toBe(false);
    expect(isLoopbackRemote('192.168.1.1')).toBe(false);
    expect(isLoopbackRemote('8.8.8.8')).toBe(false);
    expect(isLoopbackRemote('fe80::1')).toBe(false);
    expect(isLoopbackRemote('2001:db8::1')).toBe(false);
    // A mapped non-loopback address is still a remote host.
    expect(isLoopbackRemote('::ffff:10.0.0.1')).toBe(false);
  });
});
