import { describe, expect, it } from 'vitest';
import { isLoopbackRemote } from './oauthPkce.js';

/**
 * The OpenAI redirect_uri is always the advertised localhost form. Callbacks may
 * still arrive over IPv4 127.0.0.1 or IPv6 ::1 on the dual-stack listener.
 */
describe('isLoopbackRemote (OpenAI PKCE callback)', () => {
  const advertisedRedirectUri = (port = 1455) => `http://localhost:${port}/auth/callback`;

  it('accepts IPv4 and IPv6 localhost remotes against the advertised redirect URI', () => {
    expect(advertisedRedirectUri()).toBe('http://localhost:1455/auth/callback');
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
  });
});
