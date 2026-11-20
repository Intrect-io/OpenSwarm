// ============================================
// OpenSwarm - Verify OS sandbox selection
// Purpose: pick the OS sandbox a verify command runs under, failing closed
//          on every host where one cannot be established (AGT-3447).
// ============================================

import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatSandboxUnavailable, type SandboxAvailability } from './sandboxDiagnostics.js';

export const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export type OsSandboxChoice =
  | { ok: true; executable: string; args: string[] }
  | { ok: false; output: string };

export interface OsSandboxDeps {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  realpath: (path: string) => Promise<string>;
  linuxSandbox: () => SandboxAvailability;
  /**
   * The host uv cache, mounted on Linux as a throwaway overlay when
   * {@link OsSandboxDeps.overlaySupported} confirms bwrap can do it: reads come
   * from the host, writes land in `upper` inside the sandbox root and vanish
   * with it. The host cache is never writable from verified code: uv hardlinks
   * cache files into host virtualenvs, so a writable cache would let a worker's
   * tests rewrite host environments or plant wheels for every later uv run.
   * Ignored on macOS (sandbox-exec has no overlay) and whenever the overlay is
   * unavailable, in which case no uv variable is set either.
   */
  uvCacheOverlay?: UvCacheOverlay;
  /** Whether this bwrap can mount and write through the overlay. Absent means no. */
  overlaySupported?: (executable: string, overlay: UvCacheOverlay) => boolean;
}

export interface UvCacheOverlay {
  /** The host cache, resolved with realpath. Only ever an overlay lower layer. */
  cache: string;
  /** Existing empty directories on one filesystem, inside the writable sandbox root. */
  upper: string;
  work: string;
}

type SpawnSyncFn = (executable: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>;

/**
 * A memoized answer to "can this bwrap overlay the uv cache and write through
 * it?". The help text must list `--overlay-src` and `--overlay` (bwrap >= 0.9),
 * and a trial must create a file in the overlaid cache. Knowing the flags is not
 * enough: an old kernel refuses unprivileged overlayfs, and copy-up fails with
 * EINVAL when the cache carries POSIX ACLs the upper layer cannot take (seen
 * with `--tmp-overlay` on an ext4 cache with default ACLs). A failure inside the
 * real run would fail base and head identically, which reads as "same failure,
 * not new", so a refused trial means no cache at all.
 */
export function makeBwrapOverlayProbe(spawn: SpawnSyncFn): (executable: string, overlay: UvCacheOverlay) => boolean {
  const known = new Map<string, boolean>();
  return (executable, overlay) => {
    const key = `${executable}\0${overlay.cache}`;
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    let supported = false;
    let scratch: string | undefined;
    try {
      const help = spawn(executable, ['--help']);
      const text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
      if (text.includes('--overlay-src') && /--overlay\s/.test(text)) {
        scratch = mkdtempSync(join(dirname(overlay.upper), '.uv-overlay-probe-'));
        const trialOverlay = { cache: overlay.cache, upper: join(scratch, 'upper'), work: join(scratch, 'work') };
        mkdirSync(trialOverlay.upper);
        mkdirSync(trialOverlay.work);
        // Same namespaces as the real invocation below, so the trial answers the same question.
        const probeFile = join(overlay.cache, '.openswarm-overlay-probe');
        const trial = spawn(executable, ['--ro-bind', '/', '/', '--bind', scratch, scratch, ...uvCacheOverlayArgs(trialOverlay), '--unshare-net', '--dev', '/dev', '--proc', '/proc', '--', 'touch', probeFile]);
        supported = trial.status === 0;
      }
    } catch {
      supported = false; // An unrunnable probe means no overlay, never a writable cache.
    } finally {
      if (scratch) {
        try { rmdirSync(join(scratch, 'work', 'work')); } catch { /* no overlay ran */ }
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    known.set(key, supported);
    return supported;
  };
}

/** bwrap requires each `--overlay-src` to precede the overlay mount that consumes it. */
function uvCacheOverlayArgs(overlay: UvCacheOverlay): string[] {
  return ['--overlay-src', overlay.cache, '--overlay', overlay.upper, overlay.work, overlay.cache];
}

/** What uv needs to use the overlaid cache: offline, and copying (never hardlinking) out of it. */
function uvCacheEnvArgs(path: string): string[] {
  return ['--setenv', 'UV_CACHE_DIR', path, '--setenv', 'UV_OFFLINE', '1', '--setenv', 'UV_LINK_MODE', 'copy'];
}

/**
 * The sandboxed invocation for `run` with only `dirname(root)` writable, or a
 * failure explaining why no sandbox is available.
 *
 * Every branch that cannot establish a sandbox fails: running a worker's code
 * unsandboxed to decide whether to trust it defeats the point. Before this,
 * a macOS host without `/usr/bin/sandbox-exec` (and any platform other than
 * darwin, linux or win32) fell through to a plain shell.
 */
export async function selectOsSandbox(
  root: string,
  shell: string,
  run: string,
  deps: OsSandboxDeps,
): Promise<OsSandboxChoice> {
  switch (deps.platform) {
    case 'darwin': {
      if (!deps.exists(DARWIN_SANDBOX_EXEC)) {
        return {
          ok: false,
          output: `[security] OS verification sandbox is unavailable on this macOS host: ${DARWIN_SANDBOX_EXEC} not found`,
        };
      }
      const writableRoot = (await deps.realpath(dirname(root))).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const profile = `(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) (allow file-write* (subpath "${writableRoot}") (literal "/dev/null") (literal "/dev/tty"))`;
      return { ok: true, executable: DARWIN_SANDBOX_EXEC, args: ['-p', profile, shell, '-lc', run] };
    }
    case 'linux': {
      // The message names which cause applies (missing binary or blocked user
      // namespace) and how to fix it. (INT-3103)
      const sandbox = deps.linuxSandbox();
      if (!sandbox.available) return { ok: false, output: formatSandboxUnavailable(sandbox) };
      const writableRoot = dirname(root);
      const cache = deps.uvCacheOverlay;
      const overlay = cache && deps.overlaySupported?.(sandbox.executable, cache)
        ? [...uvCacheOverlayArgs(cache), ...uvCacheEnvArgs(cache.cache)]
        : [];
      return {
        ok: true,
        executable: sandbox.executable,
        args: ['--ro-bind', '/', '/', '--bind', writableRoot, writableRoot, ...overlay, '--unshare-net', '--dev', '/dev', '--proc', '/proc', '--', shell, '-lc', run],
      };
    }
    case 'win32':
      return { ok: false, output: '[security] OS verification sandbox is unavailable on this Windows host' };
    default:
      return { ok: false, output: `[security] OS verification sandbox is unavailable on platform ${deps.platform}` };
  }
}
