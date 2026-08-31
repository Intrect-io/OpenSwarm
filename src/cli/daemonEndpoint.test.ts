import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_HOST_ENV,
  ALLOW_PLAINTEXT_TOKEN_ENV,
  DAEMON_SCHEME_ENV,
  DAEMON_TOKEN_ENV,
  daemonAuthHeaders,
  daemonScheme,
  DEFAULT_DAEMON_HOST,
  InvalidDaemonHostError,
  daemonBaseUrl,
  daemonHost,
  isRemoteDaemon,
} from './daemonEndpoint.js';

afterEach(() => {
  delete process.env[DAEMON_HOST_ENV];
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_SCHEME_ENV];
  delete process.env[ALLOW_PLAINTEXT_TOKEN_ENV];
});

describe('daemonHost', () => {
  it('defaults to loopback so coordination traffic stays on this machine', () => {
    expect(daemonHost(undefined)).toBe(DEFAULT_DAEMON_HOST);
    expect(daemonHost('')).toBe(DEFAULT_DAEMON_HOST);
    expect(daemonHost('   ')).toBe(DEFAULT_DAEMON_HOST);
  });

  it('accepts a bare hostname or address', () => {
    expect(daemonHost('vela')).toBe('vela');
    expect(daemonHost('100.95.200.28')).toBe('100.95.200.28');
    expect(daemonHost('  vela  ')).toBe('vela');
    expect(daemonHost('[::1]')).toBe('[::1]');
  });

  it.each([
    ['http://vela', 'a scheme'],
    ['vela:3847', 'a port'],
    ['vela/api', 'a path'],
    ['vela?x=1', 'a query'],
    ['user@vela', 'credentials'],
    ['ve la', 'whitespace'],
  ])('rejects %s (%s) rather than silently using loopback', (value) => {
    expect(() => daemonHost(value)).toThrow(InvalidDaemonHostError);
  });

  it('names the scheme, not the slashes, when a URL is pasted in', () => {
    // `http://vela` trips the separator check too; the operator needs to be
    // told which part to delete.
    expect(() => daemonHost('http://vela')).toThrow(/includes a scheme/);
  });

  it('reads the environment when no argument is passed', () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    expect(daemonHost()).toBe('vela');
    expect(isRemoteDaemon()).toBe(true);
  });

  it.each([undefined, DEFAULT_DAEMON_HOST, 'localhost', '[::1]'])(
    'reports loopback spelled as %s as local', (value) => {
      // isRemoteDaemon gates auto-starting the daemon, which only makes sense
      // on this machine — calling `localhost` remote would refuse a start it
      // could perfectly well do.
      if (value === undefined) delete process.env[DAEMON_HOST_ENV];
      else process.env[DAEMON_HOST_ENV] = value;
      expect(isRemoteDaemon()).toBe(false);
    });
});

describe('daemonBaseUrl', () => {
  it('builds a loopback URL by default', () => {
    expect(daemonBaseUrl(3847)).toBe('http://127.0.0.1:3847');
  });

  it('honours the host override', () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    expect(daemonBaseUrl(3847)).toBe('http://vela:3847');
  });

  it.each([0, 65_536, 1.5, Number.NaN])('rejects out-of-range port %s', (port) => {
    expect(() => daemonBaseUrl(port)).toThrow(/between 1 and 65535/);
  });
});

describe('daemonAuthHeaders', () => {
  // web.ts authorises on token OR loopback OR trusted Tailscale. A remote CLI
  // has only the token, so a daemon secured with OPENSWARM_WEB_TOKEN refuses
  // every remote command without this.
  it('sends nothing when no token is configured', () => {
    expect(daemonAuthHeaders()).toEqual({});
  });

  it('presents the token in the header the daemon reads without parsing', () => {
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    expect(daemonAuthHeaders()).toEqual({ 'x-openswarm-token': 's3cret' });
  });

  it('ignores a blank token rather than sending an empty header', () => {
    process.env[DAEMON_TOKEN_ENV] = '   ';
    expect(daemonAuthHeaders()).toEqual({});
  });
});

describe('daemonScheme', () => {
  it('defaults to http, matching the daemon\'s own listener', () => {
    expect(daemonScheme(undefined)).toBe('http');
    expect(daemonScheme('')).toBe('http');
  });

  it.each(['https', 'HTTPS', ' https ', 'https:'])('accepts %s', (value) => {
    expect(daemonScheme(value)).toBe('https');
  });

  it('rejects anything else instead of building a nonsense URL', () => {
    expect(() => daemonScheme('ftp')).toThrow(/must be "http" or "https"/);
  });
});

describe('plaintext credential guard', () => {
  // The token is bearer-equivalent. Over http to another machine it, and the
  // coordination content around it, are on the wire in the clear.
  it('refuses to send the token to a remote host over http', () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    expect(() => daemonBaseUrl(3847)).toThrow(/Refusing to send/);
  });

  it('allows it over https', () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    process.env[DAEMON_SCHEME_ENV] = 'https';
    expect(daemonBaseUrl(3847)).toBe('https://vela:3847');
  });

  it('allows it when the operator states the link is already encrypted', () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    process.env[ALLOW_PLAINTEXT_TOKEN_ENV] = 'true';
    expect(daemonBaseUrl(3847)).toBe('http://vela:3847');
  });

  it('never blocks loopback, which does not leave the machine', () => {
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    expect(daemonBaseUrl(3847)).toBe('http://127.0.0.1:3847');
    process.env[DAEMON_HOST_ENV] = 'localhost';
    expect(daemonBaseUrl(3847)).toBe('http://localhost:3847');
  });

  it('never blocks a remote host when no token is configured', () => {
    // Tailscale already encrypts the link; a tokenless read exposes no credential.
    process.env[DAEMON_HOST_ENV] = '100.95.200.28';
    expect(daemonBaseUrl(3847)).toBe('http://100.95.200.28:3847');
  });
});
