import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_HOST_ENV,
  DEFAULT_DAEMON_HOST,
  InvalidDaemonHostError,
  daemonBaseUrl,
  daemonHost,
  isRemoteDaemon,
} from './daemonEndpoint.js';

afterEach(() => {
  delete process.env[DAEMON_HOST_ENV];
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
