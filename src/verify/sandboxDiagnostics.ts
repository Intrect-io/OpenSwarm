// ============================================
// OpenSwarm — Linux verification sandbox diagnostics
// ============================================
//
// Deterministic verify refuses to run without an OS sandbox, which is correct:
// executing a worker's code unsandboxed to decide whether to trust it defeats
// the point. But "unavailable" was a single message covering two very different
// situations, and neither said what to do about it.
//
// CI containers hit both. `bwrap` is frequently not installed, and even when it
// is, unprivileged user namespaces are commonly blocked — Docker's default
// seccomp profile denies the syscall, and Ubuntu 24.04+ restricts it through
// AppArmor. A bwrap that cannot unshare fails at exec time with a message that
// does not name either cause. (INT-3103)

export interface SandboxProbe {
  /** Does this path exist? */
  exists: (path: string) => boolean;
  /** Read a sysctl-style file, or undefined when it is absent/unreadable. */
  readSysctl: (path: string) => string | undefined;
}

export type SandboxAvailability =
  | { available: true; executable: string }
  | { available: false; reason: string; remedy: string[] };

const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'];

/** Debian/Ubuntu toggle: 0 means unprivileged userns creation is off. */
const USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';
/** Ubuntu 24.04+: 1 means AppArmor confines unprivileged userns. */
const APPARMOR_USERNS = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

/**
 * Why can't we sandbox here, and what would fix it?
 *
 * Absent sysctls are treated as "no restriction" rather than "blocked": most
 * kernels do not expose them at all, and refusing to run on a missing file would
 * turn a healthy host into a broken one. A wrong guess in that direction costs a
 * confusing failure at exec time; the other direction costs every run.
 */
export function describeLinuxSandbox(probe: SandboxProbe): SandboxAvailability {
  const executable = BWRAP_PATHS.find(probe.exists);
  if (!executable) {
    return {
      available: false,
      reason: 'bubblewrap (bwrap) is not installed',
      remedy: [
        'Debian/Ubuntu: apt-get install -y bubblewrap',
        'Alpine: apk add bubblewrap',
        'GitHub Actions (ubuntu-latest): add the apt-get step above before running the gate',
      ],
    };
  }

  const clone = probe.readSysctl(USERNS_CLONE)?.trim();
  if (clone === '0') {
    return {
      available: false,
      reason: 'unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)',
      remedy: [
        'Host: sysctl -w kernel.unprivileged_userns_clone=1',
        'Docker: run with --security-opt seccomp=unconfined (the default profile denies the syscall)',
      ],
    };
  }

  const apparmor = probe.readSysctl(APPARMOR_USERNS)?.trim();
  if (apparmor === '1') {
    return {
      available: false,
      reason: 'AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+ default)',
      remedy: [
        'Host: sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
        'Docker: run with --security-opt seccomp=unconfined',
      ],
    };
  }

  return { available: true, executable };
}

/** One-line reason plus indented remedies, for the evidence tail. */
export function formatSandboxUnavailable(result: Extract<SandboxAvailability, { available: false }>): string {
  return [
    `[security] OS verification sandbox is unavailable: ${result.reason}`,
    ...result.remedy.map((line) => `  fix: ${line}`),
    '  Verification fails closed rather than running unsandboxed code.',
  ].join('\n');
}
