import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVerifyToolchainPath, VERIFY_ALLOWED_DEPENDENCY_DIRS, VERIFY_TOOLCHAIN_PATH_PREFIXES } from './toolchainPath.js';

describe('buildVerifyToolchainPath', () => {
  it('keeps project bins and the read-only toolchain prefixes, dropping the rest of the host PATH', () => {
    const path = buildVerifyToolchainPath(
      ['/usr/bin', '/home/user/.local/bin', '/opt/homebrew/bin', '/tmp/evil/bin'].join(':'),
      '/repo',
      '/repo/packages/api',
    );
    const parts = path.split(':');
    for (const prefix of VERIFY_TOOLCHAIN_PATH_PREFIXES) expect(parts).toContain(prefix);
    expect(parts).toContain('/repo/node_modules/.bin');
    expect(parts).toContain('/repo/packages/api/node_modules/.bin');
    expect(parts).not.toContain('/home/user/.local/bin');
    expect(parts).not.toContain('/tmp/evil/bin');
    expect(VERIFY_ALLOWED_DEPENDENCY_DIRS.has('node_modules')).toBe(true);
  });

  it('puts project dependency bins ahead of the system prefixes', () => {
    const parts = buildVerifyToolchainPath('/usr/bin', '/repo').split(':');
    expect(parts.indexOf('/repo/node_modules/.bin')).toBeLessThan(parts.indexOf('/usr/bin'));
  });

  it('preserves nvm/fnm-style version-manager bin directories', () => {
    const path = buildVerifyToolchainPath('/home/user/.nvm/versions/node/v22.0.0/bin:/usr/bin', '/repo');
    expect(path.split(':')).toContain('/home/user/.nvm/versions/node/v22.0.0/bin');
  });

  it('keeps the running interpreter bin ahead of the generic system prefixes', () => {
    const parts = buildVerifyToolchainPath('/usr/bin', '/repo').split(':');
    expect(parts).toContain(dirname(process.execPath));
    // A different major node lives in /usr/local/bin on this host; the sandbox
    // must reach the daemon's own interpreter first.
    expect(parts.indexOf(dirname(process.execPath))).toBeLessThan(parts.indexOf('/usr/bin'));
  });

  it('keeps a project venv bin directory', () => {
    const path = buildVerifyToolchainPath('/repo/.venv-verify/bin:/usr/bin', '/repo');
    expect(path.split(':')).toContain('/repo/.venv-verify/bin');
  });
});
