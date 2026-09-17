// ============================================
// OpenSwarm - OS sandbox wrapping for agent shell commands (AGT-4387)
// ============================================
//
// One place that knows how to run a command with the filesystem fenced:
// macOS `sandbox-exec` with a deny-default profile, Linux `bwrap` with a
// read-only root. The verify stage has used this shape since INT-3103; the
// worker's `bash` tool did not, so on a native (non-container) daemon the
// worker ran as the user with the whole home directory writable, gated only
// by a regex denylist. This module lets both stages share the fence.
//
// Policy, measured on cgf-portal (2026-09-17, AGT-4387): a worker needs to
// write its worktree, the temp dir, and the package-manager caches (uv, npm,
// cargo, wrangler's log dir). Everything else — other repos, ~/.ssh, the
// daemon's own state and credentials — stays read-only. Network stays open:
// workers install dependencies and call the tracker.

import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxSpec {
  /** Directories the command may write to. Others are read-only. */
  writableRoots: string[];
  /** Whether the command may open network connections. */
  allowNetwork: boolean;
}

export interface SandboxedCommand {
  file: string;
  args: string[];
}

export type SandboxBackend = 'sandbox-exec' | 'bwrap';

const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'];

/** Which OS sandbox this host offers, or null when none is usable. */
export function detectSandboxBackend(platform: NodeJS.Platform = process.platform): SandboxBackend | null {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec' : null;
  if (platform === 'linux') return BWRAP_PATHS.some((p) => existsSync(p)) ? 'bwrap' : null;
  return null;
}

/** Escape a path for a Scheme string literal inside a sandbox profile. */
function schemeString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The macOS profile: deny by default, read everything, write only under the
 * given roots. `(allow process*)` and `(allow sysctl-read)` are what a shell
 * and a toolchain need to start at all; `/dev/null` and `/dev/tty` keep
 * redirections and prompts from tripping the fence.
 */
export function buildMacSandboxProfile(spec: SandboxSpec): string {
  const writes = [
    ...spec.writableRoots.map((root) => `(subpath ${schemeString(root)})`),
    '(literal "/dev/null")',
    '(literal "/dev/tty")',
  ].join(' ');
  const network = spec.allowNetwork ? ' (allow network*)' : '';
  return `(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read)${network} (allow file-write* ${writes})`;
}

/**
 * The bwrap argument list: the whole filesystem read-only, the writable roots
 * bound read-write on top, a fresh /dev and /proc. Without `--unshare-net` the
 * command keeps the host network.
 */
export function buildBwrapArgs(spec: SandboxSpec): string[] {
  const args = ['--ro-bind', '/', '/'];
  for (const root of spec.writableRoots) args.push('--bind', root, root);
  if (!spec.allowNetwork) args.push('--unshare-net');
  args.push('--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--');
  return args;
}

/**
 * Wrap `argv` so it runs inside the host sandbox. Returns null when the host
 * has no sandbox — the caller decides whether that is a warning or a refusal
 * (the verify stage refuses; the worker warns once and runs open, so a
 * Windows host is not silently shut out of every task).
 */
export function wrapForSandbox(
  argv: string[],
  spec: SandboxSpec,
  backend: SandboxBackend | null = detectSandboxBackend(),
): SandboxedCommand | null {
  if (argv.length === 0) throw new Error('wrapForSandbox: empty argv');
  if (backend === 'sandbox-exec') {
    return { file: '/usr/bin/sandbox-exec', args: ['-p', buildMacSandboxProfile(spec), ...argv] };
  }
  if (backend === 'bwrap') {
    const file = BWRAP_PATHS.find((p) => existsSync(p)) ?? BWRAP_PATHS[0];
    return { file, args: [...buildBwrapArgs(spec), ...argv] };
  }
  return null;
}

/**
 * The writable set a coding worker needs, measured on cgf-portal: its own
 * worktree, the temp dirs, and the caches uv / npm / cargo / wrangler write
 * to. Paths are resolved through realpath — sandbox-exec matches the real
 * path, and on macOS $TMPDIR and /tmp are both symlinks into /private.
 * Directories that do not exist are dropped: bwrap fails on a missing bind
 * source, and a cache the host has never created needs no exception yet.
 */
export function defaultWorkerWritableRoots(
  worktreeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const candidates = [
    worktreeRoot,
    env.TMPDIR || tmpdir(),
    '/tmp',
    join(home, '.cache'),
    join(home, '.npm'),
    join(home, 'Library', 'Caches'),
    join(home, 'Library', 'Preferences', '.wrangler'),
    join(home, '.wrangler'),
    join(home, '.cargo', 'registry'),
  ];
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** True when stderr/stdout carries the OS sandbox's refusal, so the tool can name the fence. */
export function looksLikeSandboxDenial(output: string): boolean {
  return /operation not permitted|read-only file system|EPERM|EROFS/i.test(output);
}
