import { describe, expect, it } from 'vitest';
import { DAEMON_PORT_ENV, DEFAULT_DAEMON_PORT, InvalidDaemonPortError, daemonPort } from './daemonPort.js';

describe('daemonPort', () => {
  it('defaults to 3847 when OPENSWARM_WEB_PORT is unset or blank', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(3847);
    expect(daemonPort({})).toBe(3847);
    expect(daemonPort({ [DAEMON_PORT_ENV]: '' })).toBe(3847);
    expect(daemonPort({ [DAEMON_PORT_ENV]: '   ' })).toBe(3847);
  });

  it('reads the port from OPENSWARM_WEB_PORT', () => {
    expect(daemonPort({ [DAEMON_PORT_ENV]: '49152' })).toBe(49152);
    expect(daemonPort({ [DAEMON_PORT_ENV]: ' 3900 ' })).toBe(3900);
  });

  it('refuses a value that is not a TCP port instead of falling back to 3847', () => {
    for (const bad of ['0', '65536', '99999', '-1', '3847abc', '38.47', 'http://x:1', '0x10']) {
      expect(() => daemonPort({ [DAEMON_PORT_ENV]: bad })).toThrow(InvalidDaemonPortError);
    }
  });
});
