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
  // bwrap's own message is the only ground truth here; a sysctl is a likely
  // cause, never a proven one. Carrying the last stderr line into every reason
  // keeps the operator from chasing a guess when the real cause was something
  // this function cannot see.
  const detail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : '';
  const generic = [
    'Docker: --security-opt seccomp=unconfined (the default profile denies the syscall)',
    'Docker: --cap-add SYS_ADMIN, if the runtime also drops the capability',
    'Check sysctl user.max_user_namespaces — 0 disables them outright',
  ];

  if (probe.readSysctl(USERNS_CLONE)?.trim() === '0') {
    return {
      reason: `unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)${detail}`,
      remedy: [
        'Host: sysctl -w kernel.unprivileged_userns_clone=1 (prefix with sudo unless already root)',
        'Or install a setuid-root bwrap, or grant the process CAP_SYS_ADMIN',
      ],
    };
  }

  if (probe.readSysctl(APPARMOR_USERNS)?.trim() === '1') {
    // Mediation being ON does not mean it was the thing that denied us — a
    // profile may already permit bwrap while seccomp or an exhausted
    // user.max_user_namespaces is the real cause. Named as the likeliest
    // suspect, with the generic remedies kept for when it is not.
    return {
      reason: `AppArmor is mediating unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 24.04+ default) — the likeliest cause${detail}`,
      remedy: [
        'Host: sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (prefix with sudo unless already root)',
        'Or install an AppArmor profile granting userns to bwrap',
        'If a profile already permits bwrap, the denial is elsewhere:',
        ...generic,
      ],
    };
  }

  return {
    reason: `bwrap could not set up the sandbox${detail}`,
    remedy: generic,
  };
}

export function describeLinuxSandbox(probe: SandboxProbe): SandboxAvailability {
  const executable = BWRAP_PATHS.find(probe.exists);
  if (!executable) {
    return {
      available: false,
      reason: 'bubblewrap (bwrap) is not installed',
      // No sudo in the package commands: the environment where bwrap is most
      // often missing is a minimal Debian/Alpine container running as root,
      // where sudo itself is not installed and the advertised command would fail
      // before reaching the package manager. The Actions line keeps it, because
      // that runner is specifically not root.
      remedy: [
        'Debian/Ubuntu: apt-get update && apt-get install -y bubblewrap (prefix with sudo unless already root)',
        'Alpine: apk add bubblewrap (prefix with sudo unless already root)',
        'GitHub Actions (ubuntu-latest): sudo apt-get update && sudo apt-get install -y bubblewrap, before the gate',
      ],
    };
  }

  const attempt = probe.tryBwrap(executable);
  if (attempt.ok) return { available: true, executable };

  return { available: false, ...explainFailure(probe, attempt.stderr) };
}

/** Absolute paths for the probe's no-op command, most specific first. */
const TRUE_PATHS = ['/usr/bin/true', '/bin/true'];

/**
 * The namespaces the probe must set up, mirroring the real invocation in
 * `runner.ts`. Probing a strict subset is how a probe lies: on a host that
 * permits user namespaces but denies network ones, `--unshare-user` alone
 * succeeds and every verification command afterwards fails, which is the exact
 * failure this module exists to catch before it happens. Keep in step with the
 * runner's argv.
 */
const PROBE_NAMESPACE_ARGS = ['--ro-bind', '/', '/', '--unshare-net', '--dev', '/dev', '--proc', '/proc'];

/**
 * The real probe, kept here rather than at the call site so it is reachable from
 * any host. The Linux branch of the verify runner never executes on macOS, so
 * wiring assembled inline there would ship untested.
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
      // An absolute command, never the bare `true`. Inside the sandbox the token
      // is resolved with execvp against the inherited PATH, so a project-supplied
      // directory on it — `node_modules/.bin`, say — decides what the probe runs.
      // Falls back to bwrap itself, which is guaranteed to exist at this point.
      const trueBin = TRUE_PATHS.find(deps.exists);
      const command = trueBin ? [trueBin] : [executable, '--version'];
      const probe = deps.spawn(executable, [...PROBE_NAMESPACE_ARGS, '--', ...command]);
      return {
        ok: probe.status === 0,
        stderr: probe.stderr ?? String(probe.error?.message ?? ''),
      };
    },
  };
}

/**
 * Memoize a working sandbox, re-probe a broken one.
 *
 * A success cannot regress in a way that matters — every later command runs the
 * same bwrap anyway — so paying for one namespace creation per verification
 * command is waste. A failure is different: the daemon is long-lived, so caching
 * it would mean an operator who follows the emitted remedy (installs bubblewrap,
 * flips the sysctl) keeps getting fail-closed until they restart the process. A
 * re-probe costs one `bwrap true` on a host that is already broken.
 *
 * A factory rather than module state so the decision is testable without a Linux
 * host and without leaking a cache between tests.
 */
export function makeSandboxCache(probe: () => SandboxAvailability): () => SandboxAvailability {
  let cached: Extract<SandboxAvailability, { available: true }> | undefined;
  return () => {
    if (cached) return cached;
    const result = probe();
    if (result.available) cached = result;
    return result;
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
