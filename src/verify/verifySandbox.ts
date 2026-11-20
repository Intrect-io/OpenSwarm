// ============================================
// OpenSwarm - Verify OS sandbox selection
// Purpose: pick the OS sandbox a verify command runs under, failing closed
//          on every host where one cannot be established (AGT-3447).
// ============================================

import { dirname } from 'node:path';
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
  /** Extra paths the sandboxed command may write (e.g. the host uv cache, used offline). */
  extraWritable?: readonly string[];
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
      const extra = await Promise.all((deps.extraWritable ?? []).map(async (path) => ` (subpath "${(await deps.realpath(path)).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`));
      const profile = `(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) (allow file-write* (subpath "${writableRoot}")${extra.join('')} (literal "/dev/null") (literal "/dev/tty"))`;
      return { ok: true, executable: DARWIN_SANDBOX_EXEC, args: ['-p', profile, shell, '-lc', run] };
    }
    case 'linux': {
      // The message names which cause applies (missing binary or blocked user
      // namespace) and how to fix it. (INT-3103)
      const sandbox = deps.linuxSandbox();
      if (!sandbox.available) return { ok: false, output: formatSandboxUnavailable(sandbox) };
      const writableRoot = dirname(root);
      return {
        ok: true,
        executable: sandbox.executable,
        args: ['--ro-bind', '/', '/', '--bind', writableRoot, writableRoot, ...(deps.extraWritable ?? []).flatMap((path) => ['--bind', path, path]), '--unshare-net', '--dev', '/dev', '--proc', '/proc', '--', shell, '-lc', run],
      };
    }
    case 'win32':
      return { ok: false, output: '[security] OS verification sandbox is unavailable on this Windows host' };
    default:
      return { ok: false, output: `[security] OS verification sandbox is unavailable on platform ${deps.platform}` };
  }
}
