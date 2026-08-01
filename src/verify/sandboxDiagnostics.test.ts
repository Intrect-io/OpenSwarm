import { describe, expect, it, vi } from 'vitest';
import {
  describeLinuxSandbox,
  formatSandboxUnavailable,
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

  it('attributes an AppArmor failure without prescribing seccomp', () => {
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }, bwrap: { ok: false, stderr: 'denied' } }),
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('AppArmor');
    expect(result.remedy.join('\n')).toContain('apparmor_restrict_unprivileged_userns=0');
    expect(result.remedy.join('\n')).not.toContain('seccomp');
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
    // The smallest invocation that fails for every reason we care about.
    expect(spawn).toHaveBeenCalledWith('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--unshare-user', 'true']);
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
