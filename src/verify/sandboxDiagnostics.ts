// ============================================
// OpenSwarm — Linux verification sandbox diagnostics
// ============================================
//
// Deterministic verify refuses to run without an OS sandbox, which is correct:
// executing a worker's code unsandboxed to decide whether to trust it defeats
// the point. But "unavailable" was a single message covering several very
// different situations, and none said what to do about it.
//
// The availability decision is made by ACTUALLY RUNNING bwrap, not by reading
// sysctls. Those only describe one of several ways namespace creation can be
// denied — a container can block it through seccomp, missing capabilities, or
// `user.max_user_namespaces=0` while every sysctl here reads permissive — and
// they also produce false negatives in the other direction, since
// `unprivileged_userns_clone=0` does not stop a setuid-root bwrap or a caller
// holding CAP_SYS_ADMIN. Probing answers the question the sysctls only
// approximate; they are consulted afterwards, to explain a failure that already
// happened. (INT-3103)

export interface SandboxProbe {
  /** Does this path exist? */
  exists: (path: string) => boolean;
  /** Read a sysctl-style file, or undefined when it is absent/unreadable. */
  readSysctl: (path: string) => string | undefined;
  /**
   * Run `bwrap` with a trivial command in a fresh namespace. Returns the exit
   * status and stderr; `ok` is true only when the namespace was created and the
   * command ran.
   */
  tryBwrap: (executable: string) => { ok: boolean; stderr: string };
}

export type SandboxAvailability =
  | { available: true; executable: string }
  | { available: false; reason: string; remedy: string[] };

const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'];

/** Debian/Ubuntu toggle: 0 means unprivileged callers cannot create a namespace. */
const USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';
/** Ubuntu 24.04+: 1 means AppArmor *mediates* unprivileged userns — a profile may still allow it. */
const APPARMOR_USERNS = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

/**
 * Why did the sandbox fail, and what would fix it?
 *
 * Only reached after a real bwrap invocation failed, so these are explanations
 * for an observed denial rather than predictions. Each remedy has to actually
 * address the cause it is attached to: `seccomp=unconfined` does not change a
 * kernel sysctl and does not alter AppArmor mediation, so it belongs only on the
 * generic container case.
 */
function explainFailure(probe: SandboxProbe, stderr: string): { reason: string; remedy: string[] } {
  if (probe.readSysctl(USERNS_CLONE)?.trim() === '0') {
    return {
      reason: 'unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)',
      remedy: [
        'Host: sudo sysctl -w kernel.unprivileged_userns_clone=1',
        'Or install a setuid-root bwrap, or grant the process CAP_SYS_ADMIN',
      ],
    };
  }

  if (probe.readSysctl(APPARMOR_USERNS)?.trim() === '1') {
    return {
      reason: 'AppArmor is mediating unprivileged user namespaces and no profile permits this binary (Ubuntu 24.04+ default)',
      remedy: [
        'Host: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
        'Or install an AppArmor profile granting userns to bwrap',
      ],
    };
  }

  return {
    reason: `bwrap could not create a namespace${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
    remedy: [
      'Docker: --security-opt seccomp=unconfined (the default profile denies the syscall)',
      'Docker: --cap-add SYS_ADMIN, if the runtime also drops the capability',
      'Check sysctl user.max_user_namespaces — 0 disables them outright',
    ],
  };
}

export function describeLinuxSandbox(probe: SandboxProbe): SandboxAvailability {
  const executable = BWRAP_PATHS.find(probe.exists);
  if (!executable) {
    return {
      available: false,
      reason: 'bubblewrap (bwrap) is not installed',
      remedy: [
        'Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y bubblewrap',
        'Alpine: sudo apk add bubblewrap',
        'GitHub Actions (ubuntu-latest): add that apt-get step before the gate — the runner user is not root',
      ],
    };
  }

  const attempt = probe.tryBwrap(executable);
  if (attempt.ok) return { available: true, executable };

  return { available: false, ...explainFailure(probe, attempt.stderr) };
}

/**
 * The real probe, kept here rather than at the call site so it is reachable from
 * any host. The Linux branch of the verify runner never executes on macOS, so
 * wiring assembled inline there would ship untested.
 *
 * `--unshare-user` with a trivial command is the smallest thing that fails for
 * every reason we care about: no permission to create the namespace, a dropped
 * capability, a seccomp filter, or an exhausted `user.max_user_namespaces`.
 */
export function makeSystemProbe(deps: {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  spawn: (executable: string, args: string[]) => { status: number | null; stderr?: string; error?: Error };
}): SandboxProbe {
  return {
    exists: deps.exists,
    readSysctl: (path) => {
      try {
        return deps.readFile(path);
      } catch {
        return undefined;
      }
    },
    tryBwrap: (executable) => {
      const probe = deps.spawn(executable, ['--ro-bind', '/', '/', '--unshare-user', 'true']);
      return {
        ok: probe.status === 0,
        stderr: probe.stderr ?? String(probe.error?.message ?? ''),
      };
    },
  };
}

/** One-line reason plus indented remedies, for the evidence tail. */
export function formatSandboxUnavailable(result: Extract<SandboxAvailability, { available: false }>): string {
  return [
    `[security] OS verification sandbox is unavailable: ${result.reason}`,
    ...result.remedy.map((line) => `  fix: ${line}`),
    '  Verification fails closed rather than running unsandboxed code.',
  ].join('\n');
}
