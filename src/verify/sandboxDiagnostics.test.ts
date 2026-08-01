import { describe, expect, it, vi } from 'vitest';
import {
  describeLinuxSandbox,
  formatSandboxUnavailable,
  makeSandboxCache,
  type SandboxProbe,
} from './sandboxDiagnostics.js';

function probe(over: Partial<{
  paths: string[];
  sysctl: Record<string, string>;
  bwrap: { ok: boolean; stderr: string };
}> = {}): SandboxProbe {
  const paths = over.paths ?? ['/usr/bin/bwrap'];
  const sysctl = over.sysctl ?? {};
  const bwrap = over.bwrap ?? { ok: true, stderr: '' };
  return {
    exists: (p) => paths.includes(p),
    readSysctl: (p) => sysctl[p],
    tryBwrap: () => bwrap,
  };
}

describe('describeLinuxSandbox', () => {
  it('accepts a host where bwrap actually creates a namespace', () => {
    expect(describeLinuxSandbox(probe())).toEqual({ available: true, executable: '/usr/bin/bwrap' });
  });

  it('finds bwrap at the alternate prefix', () => {
    expect(describeLinuxSandbox(probe({ paths: ['/usr/local/bin/bwrap'] })))
      .toMatchObject({ available: true, executable: '/usr/local/bin/bwrap' });
  });

  it('names the install step when bwrap is missing, with sudo for the CI runner', () => {
    // ubuntu-latest steps run as a non-root user, so a bare apt-get cannot take
    // the package-manager lock.
    const result = describeLinuxSandbox(probe({ paths: [] }));
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('not installed');
    expect(result.remedy.join('\n')).toContain('sudo apt-get');
  });

  it('trusts the probe over a restrictive sysctl', () => {
    // unprivileged_userns_clone=0 does NOT stop a setuid-root bwrap or a caller
    // holding CAP_SYS_ADMIN. Reading the sysctl alone rejected working hosts.
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/unprivileged_userns_clone': '0' }, bwrap: { ok: true, stderr: '' } }),
    );
    expect(result.available).toBe(true);
  });

  it('trusts the probe over AppArmor mediation being enabled', () => {
    // The sysctl means AppArmor *mediates* userns, not that it denies it — a
    // profile can grant it to bwrap.
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }, bwrap: { ok: true, stderr: '' } }),
    );
    expect(result.available).toBe(true);
  });

  it('fails when the probe fails even though every sysctl reads permissive', () => {
    // The case sysctl-reading could not see at all: a container denying the
    // syscall through seccomp, dropped capabilities, or user.max_user_namespaces=0.
    const result = describeLinuxSandbox(probe({ bwrap: { ok: false, stderr: 'bwrap: No permissions to creating new namespace' } }));
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.remedy.join('\n')).toContain('seccomp=unconfined');
    expect(result.remedy.join('\n')).toContain('user.max_user_namespaces');
    expect(result.reason).toContain('No permissions');
  });

  it('attributes a failure to the sysctl when one explains it, without prescribing seccomp', () => {
    // seccomp=unconfined does not change a kernel sysctl, so offering it here
    // would send the operator after a fix that cannot work.
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/unprivileged_userns_clone': '0' }, bwrap: { ok: false, stderr: 'denied' } }),
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('unprivileged_userns_clone=0');
    expect(result.remedy.join('\n')).toContain('sysctl -w kernel.unprivileged_userns_clone=1');
    expect(result.remedy.join('\n')).not.toContain('seccomp');
  });

  it('names AppArmor as the likeliest cause without claiming it was the cause', () => {
    // Mediation being enabled does not mean it is what denied us: a profile may
    // already permit bwrap while seccomp or an exhausted user.max_user_namespaces
    // is the real cause. The remedy leads with the AppArmor fix and keeps the
    // others for when that was not it, and the raw stderr is quoted either way.
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }, bwrap: { ok: false, stderr: 'denied' } }),
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('AppArmor');
    expect(result.reason).toContain('likeliest cause');
    expect(result.reason).toContain('denied');
    expect(result.remedy[0]).toContain('apparmor_restrict_unprivileged_userns=0');
    expect(result.remedy.join('\n')).toContain('seccomp');
  });

  it('quotes bwrap stderr in the sysctl-attributed reason too', () => {
    const result = describeLinuxSandbox(
      probe({
        sysctl: { '/proc/sys/kernel/unprivileged_userns_clone': '0' },
        bwrap: { ok: false, stderr: 'bwrap: setting up uid map: Permission denied' },
      }),
    );
    if (result.available) throw new Error('expected unavailable');
    expect(result.reason).toContain('unprivileged_userns_clone=0');
    expect(result.reason).toContain('setting up uid map');
  });

  it('keeps the install remedies runnable as root, where bwrap is usually missing', () => {
    // A minimal Debian/Alpine container runs as root and has no sudo, so a
    // sudo-prefixed command fails before reaching the package manager.
    const result = describeLinuxSandbox(probe({ paths: [] }));
    if (result.available) throw new Error('expected unavailable');
    expect(result.remedy[0]).toMatch(/^Debian\/Ubuntu: apt-get /);
    expect(result.remedy[1]).toMatch(/^Alpine: apk /);
    // The Actions runner is specifically not root, so that one keeps sudo.
    expect(result.remedy[2]).toContain('sudo apt-get');
  });

  it('does not run the probe when there is no binary to probe', () => {
    const tryBwrap = vi.fn(() => ({ ok: true, stderr: '' }));
    describeLinuxSandbox({ exists: () => false, readSysctl: () => undefined, tryBwrap });
    expect(tryBwrap).not.toHaveBeenCalled();
  });
});

describe('formatSandboxUnavailable', () => {
  it('states the cause, the fixes, and that the gate failed closed', () => {
    const result = describeLinuxSandbox(probe({ paths: [] }));
    if (result.available) throw new Error('expected unavailable');
    const text = formatSandboxUnavailable(result);
    expect(text).toContain('[security] OS verification sandbox is unavailable');
    expect(text).toContain('fix: ');
    expect(text).toContain('fails closed');
  });
});

describe('makeSystemProbe', () => {
  it('reports ok only when bwrap exits zero', async () => {
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const spawn = vi.fn(() => ({ status: 0, stderr: '' }));
    const p = makeSystemProbe({ exists: () => true, readFile: () => '1', spawn });
    expect(p.tryBwrap('/usr/bin/bwrap')).toEqual({ ok: true, stderr: '' });
    // Every namespace the real invocation sets up. A host that permits user
    // namespaces but denies network ones would pass a narrower probe and then
    // fail every verification command — the failure this module exists to catch.
    expect(spawn).toHaveBeenCalledWith('/usr/bin/bwrap', [
      '--ro-bind', '/', '/', '--unshare-net', '--dev', '/dev', '--proc', '/proc', '--', '/usr/bin/true',
    ]);
  });

  it('probes the same namespaces the runner actually uses', async () => {
    // Read the runner's argv rather than restating it: a probe that drifts from
    // the real invocation is a probe that answers a different question.
    const { readFileSync } = await import('node:fs');
    const runner = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
    const invocation = runner.split('\n').find((line) => line.includes('--ro-bind'));
    expect(invocation).toBeDefined();
    for (const namespaceFlag of ['--unshare-net', '--dev', '--proc']) {
      expect(invocation).toContain(namespaceFlag);
    }

    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const spawn = vi.fn(() => ({ status: 0, stderr: '' }));
    makeSystemProbe({ exists: () => true, readFile: () => '', spawn }).tryBwrap('/usr/bin/bwrap');
    const args = spawn.mock.calls[0][1] as string[];
    for (const namespaceFlag of ['--unshare-net', '--dev', '--proc']) {
      expect(args).toContain(namespaceFlag);
    }
  });

  it('runs an absolute command, never a PATH-resolved one', async () => {
    // Inside the sandbox a bare `true` is resolved with execvp against the
    // inherited PATH, so a project-supplied node_modules/.bin would choose what
    // the probe runs.
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const spawn = vi.fn(() => ({ status: 0, stderr: '' }));
    makeSystemProbe({ exists: (path) => path === '/bin/true', readFile: () => '', spawn })
      .tryBwrap('/usr/bin/bwrap');
    const args = spawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('true');
    expect(args.slice(-2)).toEqual(['--', '/bin/true']);
  });

  it('falls back to bwrap itself when no true(1) is present', async () => {
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const spawn = vi.fn(() => ({ status: 0, stderr: '' }));
    makeSystemProbe({ exists: () => false, readFile: () => '', spawn }).tryBwrap('/usr/bin/bwrap');
    expect((spawn.mock.calls[0][1] as string[]).slice(-3)).toEqual(['--', '/usr/bin/bwrap', '--version']);
  });

  it('carries bwrap stderr through so the reason can be quoted', async () => {
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const p = makeSystemProbe({
      exists: () => true,
      readFile: () => '',
      spawn: () => ({ status: 1, stderr: 'bwrap: No permissions' }),
    });
    expect(p.tryBwrap('/usr/bin/bwrap')).toEqual({ ok: false, stderr: 'bwrap: No permissions' });
  });

  it('falls back to the spawn error when the binary could not be executed', async () => {
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const p = makeSystemProbe({
      exists: () => true,
      readFile: () => '',
      spawn: () => ({ status: null, error: new Error('ENOENT') }),
    });
    expect(p.tryBwrap('/usr/bin/bwrap')).toMatchObject({ ok: false, stderr: 'ENOENT' });
  });

  it('treats an unreadable sysctl as absent rather than throwing', async () => {
    const { makeSystemProbe } = await import('./sandboxDiagnostics.js');
    const p = makeSystemProbe({
      exists: () => true,
      readFile: () => { throw new Error('EACCES'); },
      spawn: () => ({ status: 0 }),
    });
    expect(p.readSysctl('/proc/sys/kernel/anything')).toBeUndefined();
  });
});

describe('makeSandboxCache', () => {
  it('probes once while the sandbox works', () => {
    const probe = vi.fn(() => ({ available: true, executable: '/usr/bin/bwrap' }) as const);
    const sandbox = makeSandboxCache(probe);
    expect(sandbox()).toMatchObject({ available: true });
    expect(sandbox()).toMatchObject({ available: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes a broken sandbox so a remedy takes effect without a restart', () => {
    // The daemon outlives the fix. Caching the failure would keep verification
    // fail-closed for every later task even after the operator installed bwrap.
    const results = [
      { available: false, reason: 'bubblewrap (bwrap) is not installed', remedy: [] },
      { available: false, reason: 'bubblewrap (bwrap) is not installed', remedy: [] },
      { available: true, executable: '/usr/bin/bwrap' },
    ] as const;
    let call = 0;
    const sandbox = makeSandboxCache(() => results[Math.min(call++, results.length - 1)]);

    expect(sandbox()).toMatchObject({ available: false });
    expect(sandbox()).toMatchObject({ available: false });
    expect(sandbox()).toMatchObject({ available: true, executable: '/usr/bin/bwrap' });
    // ...and from then on it is memoized like any other working sandbox.
    expect(sandbox()).toMatchObject({ available: true });
    expect(call).toBe(3);
  });
});
