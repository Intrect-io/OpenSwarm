import { describe, expect, it } from 'vitest';
import {
  describeLinuxSandbox,
  formatSandboxUnavailable,
  type SandboxProbe,
} from './sandboxDiagnostics.js';

function probe(over: Partial<{ paths: string[]; sysctl: Record<string, string> }> = {}): SandboxProbe {
  const paths = over.paths ?? ['/usr/bin/bwrap'];
  const sysctl = over.sysctl ?? {};
  return {
    exists: (p) => paths.includes(p),
    readSysctl: (p) => sysctl[p],
  };
}

describe('describeLinuxSandbox', () => {
  it('accepts a host with bwrap and no userns restriction', () => {
    expect(describeLinuxSandbox(probe())).toEqual({ available: true, executable: '/usr/bin/bwrap' });
  });

  it('finds bwrap at the alternate prefix', () => {
    const result = describeLinuxSandbox(probe({ paths: ['/usr/local/bin/bwrap'] }));
    expect(result).toMatchObject({ available: true, executable: '/usr/local/bin/bwrap' });
  });

  it('names the install step when bwrap is missing', () => {
    const result = describeLinuxSandbox(probe({ paths: [] }));
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('not installed');
    expect(result.remedy.join('\n')).toContain('apt-get install -y bubblewrap');
  });

  it('separates a blocked user namespace from a missing binary', () => {
    // The case that used to surface as an opaque bwrap exec failure: the binary
    // is present, so the old existence check passed, and the run died later.
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/unprivileged_userns_clone': '0' } }),
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('unprivileged user namespaces are disabled');
    expect(result.remedy.join('\n')).toContain('seccomp=unconfined');
  });

  it('reports the AppArmor restriction Ubuntu 24.04 enables by default', () => {
    const result = describeLinuxSandbox(
      probe({ sysctl: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' } }),
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('AppArmor');
    expect(result.remedy.join('\n')).toContain('apparmor_restrict_unprivileged_userns=0');
  });

  it('treats an absent sysctl as unrestricted rather than blocked', () => {
    // Most kernels do not expose these files. Refusing to run on a missing file
    // would break every healthy host to guard against a rarer failure.
    expect(describeLinuxSandbox(probe({ sysctl: {} })).available).toBe(true);
  });

  it('treats a permissive sysctl value as unrestricted', () => {
    const result = describeLinuxSandbox(
      probe({
        sysctl: {
          '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
        },
      }),
    );
    expect(result.available).toBe(true);
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
