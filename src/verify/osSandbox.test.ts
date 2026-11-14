import { describe, expect, it, vi } from 'vitest';
import { DARWIN_SANDBOX_EXEC, selectOsSandbox, type OsSandboxDeps } from './osSandbox.js';

// Platform is injected, so the macOS branches run on any host. They were not
// exercised against a real sandbox-exec here.
function deps(overrides: Partial<OsSandboxDeps>): OsSandboxDeps {
  return {
    platform: 'linux',
    exists: () => true,
    realpath: async (path) => path,
    linuxSandbox: () => ({ available: true, executable: '/usr/bin/bwrap' }),
    ...overrides,
  };
}

describe('selectOsSandbox (AGT-3447)', () => {
  it('fails closed on macOS when sandbox-exec is missing instead of running a plain shell', async () => {
    const exists = vi.fn(() => false);
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/zsh', 'npm test', deps({ platform: 'darwin', exists }));
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.output).toContain(`${DARWIN_SANDBOX_EXEC} not found`);
    expect(exists).toHaveBeenCalledWith(DARWIN_SANDBOX_EXEC);
  });

  it('wraps the command in sandbox-exec on macOS with only the sandbox parent writable', async () => {
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/zsh', 'npm test', deps({
      platform: 'darwin',
      realpath: async () => '/private/scratch/x',
    }));
    expect(choice).toMatchObject({ ok: true, executable: DARWIN_SANDBOX_EXEC });
    if (choice.ok) {
      expect(choice.args[0]).toBe('-p');
      expect(choice.args[1]).toContain('(deny default)');
      expect(choice.args[1]).toContain('(subpath "/private/scratch/x")');
      expect(choice.args.slice(2)).toEqual(['/bin/zsh', '-lc', 'npm test']);
    }
  });

  it('fails closed on an unrecognised platform', async () => {
    const choice = await selectOsSandbox('/r/repo', '/bin/sh', 'make test', deps({ platform: 'freebsd' }));
    expect(choice).toEqual({ ok: false, output: '[security] OS verification sandbox is unavailable on platform freebsd' });
  });

  it('fails closed on Windows', async () => {
    const choice = await selectOsSandbox('C:/r/repo', 'cmd', 'test', deps({ platform: 'win32' }));
    expect(choice.ok).toBe(false);
  });

  it('uses bubblewrap on Linux and reports why it is unavailable', async () => {
    const ok = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'npm test', deps({}));
    expect(ok).toMatchObject({ ok: true, executable: '/usr/bin/bwrap' });
    if (ok.ok) expect(ok.args).toEqual(expect.arrayContaining(['--unshare-net', '--bind', '/scratch/x', '/scratch/x']));

    const missing = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'npm test', deps({
      linuxSandbox: () => ({ available: false, reason: 'bwrap missing', remedy: ['install bubblewrap'] }),
    }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.output).toContain('bwrap missing');
  });
});
