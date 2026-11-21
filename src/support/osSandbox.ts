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
// cargo). Wrangler's directories are excluded: they hold its credentials. Everything else — other repos, ~/.ssh, the
// daemon's own state and credentials — stays read-only, and the credential
// stores tools read on their own are not readable at all (AGT-4817). The worker's network
// is loopback-only by default (AGT-4798): dependency installs belong to the
// project's `setup` step, which runs with the network open, and a test can
// still start a local server. `workerNetwork: open` restores the old behaviour.

import { daemonTokenDir } from './daemonToken.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { scratchpadDir } from './scratchpad.js';
import { dirname, join, parse, relative, isAbsolute } from 'node:path';

export interface SandboxSpec {
  /** Directories the command may write to. Others are read-only. */
  writableRoots: string[];
  /**
   * Whether the command may reach the network. When false it may still use
   * loopback (a test that starts a local server), never another host.
   */
  allowNetwork: boolean;
  /**
   * Directories the command may not read at all. The daemon's API token lives
   * in one (support/daemonToken.ts): a worker that could read it could call
   * the daemon's mutating API from its shell. (AGT-4814) The others hold the
   * operator's logins (AGT-4817). See defaultHiddenPaths.
   */
  hiddenRoots?: string[];
  /** Single files the command may not read at all (AGT-4817). */
  hiddenFiles?: string[];
}

/** What the sandbox hides: whole directories, and single files inside directories it leaves readable. */
export interface HiddenPaths {
  dirs: string[];
  files: string[];
}

/** True when `child` is `parent` or lies under it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The realpath of each candidate that exists, without duplicates. */
function existingReal(candidates: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      if (!out.includes(real)) out.push(real);
    } catch { /* vanished between the checks */ }
  }
  return out;
}

/**
 * The directory of the ssh-agent socket, when hiding it cannot take the
 * sandbox down with it: it must exist and must not be the filesystem root, the
 * home dir, a temp root, or a directory that holds a writable root (a tmpfs
 * over it would mask the worktree). The worker env drops SSH_AUTH_SOCK, but a
 * path-based unix socket stays connectable under --unshare-net, so a shell
 * that knows the path could still sign with the operator's keys.
 */
function sshAgentSocketDir(env: NodeJS.ProcessEnv, home: string, writableRoots: readonly string[]): string | null {
  const sock = env.SSH_AUTH_SOCK?.trim();
  if (!sock || !isAbsolute(sock)) return null;
  const [dir] = existingReal([dirname(sock)]);
  if (!dir) return null;
  return safeToHideDir(dir, env, home, writableRoots) ? dir : null;
}

/**
 * Whether a tmpfs over `dir` leaves the sandbox usable: not the filesystem
 * root, the home dir or a temp root, and not a directory that holds a
 * writable root (it would mask the worktree).
 */
function safeToHideDir(dir: string, env: NodeJS.ProcessEnv, home: string, writableRoots: readonly string[]): boolean {
  const refused = existingReal([parse(dir).root, home, tmpdir(), env.TMPDIR, '/tmp']);
  if (refused.includes(dir)) return false;
  return !existingReal([...writableRoots]).some((root) => isWithin(root, dir));
}

/**
 * Well-known ssh-agent sockets under $XDG_RUNTIME_DIR (systemd user unit,
 * gnome-keyring, gcr, gpg-agent). A daemon run by systemd usually has no
 * SSH_AUTH_SOCK of its own while the operator's agent still listens here.
 */
const RUNTIME_AGENT_SOCKETS = ['ssh-agent.socket', join('keyring', 'ssh'), join('gcr', 'ssh'), join('gnupg', 'S.gpg-agent.ssh')];

/**
 * Everything hidden from every sandboxed command, as it exists on this host.
 * Fail-closed, with no knob to turn it off. Each entry is included only when
 * it exists, resolved through realpath (sandbox-exec matches the real path; a
 * dotfile symlinked into a dotfiles repo is hidden at its target). A file
 * candidate that turns out to be a directory is hidden as a directory, since
 * bwrap cannot bind /dev/null over one.
 *
 * - dirs: the daemon token dir (AGT-4814), ~/.ssh (keys), gh's config dir
 *   (its OAuth token), ~/.docker (registry logins in config.json), and the
 *   ssh-agent socket's directory when that is safe to hide.
 * - files: cargo's registry token ($CARGO_HOME and ~/.cargo `credentials` and
 *   `credentials.toml`; ~/.cargo/registry stays a writable cache), the Hugging
 *   Face token and the `stored_tokens` file next to it, which huggingface_hub
 *   0.25+ fills with every login ($HF_TOKEN_PATH, $HF_HOME,
 *   $XDG_CACHE_HOME/huggingface and ~/.cache/huggingface; ~/.cache stays a
 *   writable cache), ~/.netrc, ~/.npmrc, the $SSH_AUTH_SOCK socket itself, and
 *   the well-known agent sockets under $XDG_RUNTIME_DIR.
 *
 * A path inside a hidden directory is not listed again.
 *
 * Limits, on purpose (AGT-4817):
 * - The set is a snapshot taken when each command starts. A credential written
 *   later (an operator `huggingface-cli login` or `cargo login`) is not hidden
 *   from a sandbox that is already running, including a background process an
 *   earlier command left behind. Pre-creating the missing paths as mount points
 *   would write empty files into the operator's real home.
 * - Hiding an agent socket refuses connect() only on Linux (a /dev/null bind
 *   over the socket inode). On macOS it is not verified that the file deny
 *   also refuses a unix socket connect when the network is open. An agent socket at some other
 *   path the daemon does not know (e.g. /tmp/ssh-XXXX/agent.N with no
 *   SSH_AUTH_SOCK) stays reachable.
 * - Linux: the sandbox shares the host pid namespace (no --unshare-pid, so
 *   background jobs survive between bash calls). On a host without an
 *   AppArmor/Yama restriction on /proc/<pid>/root, a command could reach
 *   /proc/<same-uid host pid>/root/<path> and read the host's view of a hidden
 *   path. This host refuses it (EACCES); the sandbox alone does not.
 */
export function defaultHiddenPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  writableRoots: readonly string[] = [],
): HiddenPaths {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(home, '.cache');
  const dirs = existingReal([
    daemonTokenDir(env, home),
    join(home, '.ssh'),
    env.GH_CONFIG_DIR?.trim(),
    join(configHome, 'gh'),
    join(home, '.config', 'gh'),
    env.DOCKER_CONFIG?.trim(),
    join(home, '.docker'),
  ]);
  const agentDir = sshAgentSocketDir(env, home, writableRoots);
  if (agentDir && !dirs.includes(agentDir)) dirs.push(agentDir);
  const cargoHomes = [env.CARGO_HOME?.trim(), join(home, '.cargo')].filter((d): d is string => !!d);
  const hfTokens = [
    env.HF_TOKEN_PATH?.trim(),
    env.HF_HOME?.trim() ? join(env.HF_HOME.trim(), 'token') : undefined,
    join(cacheHome, 'huggingface', 'token'),
    join(home, '.cache', 'huggingface', 'token'),
  ].filter((f): f is string => !!f);
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const sock = env.SSH_AUTH_SOCK?.trim();
  const fileCandidates = existingReal([
    ...cargoHomes.flatMap((d) => [join(d, 'credentials'), join(d, 'credentials.toml')]),
    // huggingface_hub keeps stored_tokens next to the token file.
    ...hfTokens.flatMap((token) => [token, join(dirname(token), 'stored_tokens')]),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    sock && isAbsolute(sock) ? sock : undefined,
    ...(runtimeDir && isAbsolute(runtimeDir) ? RUNTIME_AGENT_SOCKETS.map((s) => join(runtimeDir, s)) : []),
  ]);
  const files: string[] = [];
  for (const path of fileCandidates) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // vanished between the checks
    }
    if (isDir) {
      // An odd HF_TOKEN_PATH or SSH_AUTH_SOCK naming the home dir or a parent
      // of the worktree must not mask the sandbox; such a path is skipped.
      if (!dirs.includes(path) && safeToHideDir(path, env, home, writableRoots)) dirs.push(path);
    } else {
      files.push(path);
    }
  }
  return {
    dirs: dirs.filter((dir) => !dirs.some((other) => other !== dir && isWithin(dir, other))),
    files: files.filter((file) => !dirs.some((dir) => isWithin(file, dir))),
  };
}

/**
 * How much network a worker's shell gets (AGT-4798). `loopback` (default): only
 * 127.0.0.1/::1, so a script that wraps `gh`, `wrangler` or `curl` cannot reach
 * a remote even with a credential it found on disk. `open`: the previous
 * behaviour, for a host whose sandbox cannot isolate the network (e.g. a
 * container where bwrap cannot create a network namespace).
 */
export type WorkerNetworkPolicy = 'loopback' | 'open';

let workerNetworkPolicy: WorkerNetworkPolicy = 'loopback';
let workerNetworkPolicyConfigured = false;

/** Set once at daemon (or `openswarm work`) start from `autonomous.workerNetwork`. */
export function setWorkerNetworkPolicy(policy: WorkerNetworkPolicy): void {
  workerNetworkPolicy = policy;
  workerNetworkPolicyConfigured = true;
}

/**
 * Whether this process is a factory worker host that declared its policy (the
 * daemon or `openswarm work`). A chat or ad-hoc process never set it, and its
 * failed network commands must not pause the factory (AGT-4809).
 */
export function isWorkerNetworkPolicyConfigured(): boolean {
  return workerNetworkPolicyConfigured;
}

/** Tests only: back to the unconfigured process default. */
export function resetWorkerNetworkPolicyForTests(): void {
  workerNetworkPolicy = 'loopback';
  workerNetworkPolicyConfigured = false;
}

export function getWorkerNetworkPolicy(): WorkerNetworkPolicy {
  return workerNetworkPolicy;
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
 * The directories a macOS profile must keep from being renamed so a hidden
 * path keeps its name. Seatbelt checks a path as it is when accessed, and a
 * rename only against its own source and destination: `mv ~/.cache/huggingface
 * ~/.cache/hf && cat ~/.cache/hf/token` would slip past a literal deny on the
 * token. So every ancestor of a hidden path that lies inside a writable root,
 * the writable root itself included (it could be moved into another writable
 * root on the same volume), is denied file-write* as a literal: it cannot be
 * renamed, moved or removed, while files inside it can still be created.
 * (AGT-4817)
 */
function protectedAncestors(hidden: readonly string[], writableRoots: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of hidden) {
    for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
      if (!writableRoots.some((root) => isWithin(dir, root))) continue;
      if (!out.includes(dir)) out.push(dir);
    }
  }
  return out;
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
  // Loopback only, split by direction. A single `(allow network* (local ip
  // "localhost:*"))` also admits outbound connections to remote hosts (an
  // outbound socket's local end matches), measured on macOS 2026-10-21.
  const network = spec.allowNetwork
    ? ' (allow network*)'
    : ' (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))'
      + ' (allow network-outbound (remote ip "localhost:*"))';
  // Later rules win in a sandbox profile, so the deny follows the read-all allow.
  // A hidden path under a writable root (a token in ~/.cache) stays hidden.
  const hiddenRoots = spec.hiddenRoots ?? [];
  const hiddenFiles = spec.hiddenFiles ?? [];
  // Every rule here only denies, so their order among themselves is free.
  const hidden = [
    // A hard link would give a hidden file a second name the literal does not match.
    ...hiddenRoots.map((root) => ` (deny file-link (subpath ${schemeString(root)}))`),
    ...hiddenFiles.map((file) => ` (deny file-link (literal ${schemeString(file)}))`),
    ...protectedAncestors([...hiddenRoots, ...hiddenFiles], spec.writableRoots)
      .map((dir) => ` (deny file-write* (literal ${schemeString(dir)}))`),
    ...hiddenRoots.map((root) => ` (deny file-read* file-write* (subpath ${schemeString(root)}))`),
    ...hiddenFiles.map((file) => ` (deny file-read* file-write* (literal ${schemeString(file)}))`),
  ].join('');
  return `(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read)${network} (allow file-write* ${writes})${hidden}`;
}

/**
 * The bwrap argument list: the whole filesystem read-only, the writable roots
 * bound read-write on top, a fresh /dev and /proc. Without `--unshare-net` the
 * command keeps the host network.
 */
export function buildBwrapArgs(spec: SandboxSpec): string[] {
  const args = ['--ro-bind', '/', '/'];
  for (const root of spec.writableRoots) args.push('--bind', root, root);
  // An empty tmpfs over a hidden directory: inside the sandbox it exists and
  // holds nothing. (AGT-4814)
  // Both come after every writable --bind: a later mount covers an earlier
  // one, so a hidden path under a writable root (a token in ~/.cache) stays
  // hidden. (AGT-4814, AGT-4817)
  for (const root of spec.hiddenRoots ?? []) args.push('--tmpfs', root);
  // An empty read-only file over a hidden file. (AGT-4817)
  for (const file of spec.hiddenFiles ?? []) args.push('--ro-bind', '/dev/null', file);
  if (!spec.allowNetwork) args.push('--unshare-net');
  args.push('--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--');
  return args;
}

/**
 * Wrap `argv` so it runs inside the host sandbox. Returns null when the host
 * has no sandbox — the caller decides what that means. Both the verify stage
 * and the worker's bash tool refuse (AGT-4783); a host that cannot sandbox
 * opts out explicitly with `autonomous.workerSandbox: off`.
 */
export function wrapForSandbox(
  argv: string[],
  spec: SandboxSpec,
  backend: SandboxBackend | null = detectSandboxBackend(),
): SandboxedCommand | null {
  if (argv.length === 0) throw new Error('wrapForSandbox: empty argv');
  const hidden = spec.hiddenRoots && spec.hiddenFiles ? null : defaultHiddenPaths(process.env, homedir(), spec.writableRoots);
  spec = { ...spec, hiddenRoots: spec.hiddenRoots ?? hidden?.dirs, hiddenFiles: spec.hiddenFiles ?? hidden?.files };
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
 * worktree, the temp dirs, and the caches uv / npm / cargo write to
 * (wrangler's directories are excluded; they hold its credentials). Paths are resolved through realpath — sandbox-exec matches the real
 * path, and on macOS $TMPDIR and /tmp are both symlinks into /private.
 * Directories that do not exist are dropped: bwrap fails on a missing bind
 * source, and a cache the host has never created needs no exception yet.
 */
/**
 * Every directory a worker's `bash` may write to, including its scratchpad.
 *
 * The scratchpad grant is the run's OWN directory and never its parent.
 * `~/.openswarm` also holds `automation.db` and the session transcripts, so a
 * grant one level up would let a worker edit the ledger and rewrite the record
 * of what it did — the audit trail is only worth having if the thing being
 * audited cannot reach it. (AGT-4459)
 */
export function workerWritableRoots(
  worktreeRoot: string,
  scratchpadRunId?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const roots = defaultWorkerWritableRoots(worktreeRoot, env, home);
  if (!scratchpadRunId) return roots;
  return [...roots, scratchpadDir(scratchpadRunId)];
}

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

/**
 * `looksLikeSandboxDenial`, plus: when the refusal was a network connect (or a
 * name lookup) for a non-loopback target and the worker network policy is
 * loopback-only, record it for the anomaly monitor (AGT-4809). The detector
 * is shared with the CLI adapters: support/sandboxNetworkSignal.ts.
 * Recording is fire-and-forget and never fails the tool call.
 */
export function noteSandboxDenial(output: string, command: string, cwd: string): boolean {
  void import('./sandboxNetworkSignal.js').then(({ noteNetworkDenial }) => noteNetworkDenial(output, command, cwd)).catch(() => { /* bookkeeping only */ });
  return looksLikeSandboxDenial(output);
}
