// ============================================
// OpenSwarm - OS sandbox wrapping tests (AGT-4387)
// Created: 2026-09-17
// Purpose: Pin the profile/argv shapes, the writable-root policy, and — on a
//   host that has sandbox-exec — that the fence really refuses a write outside
//   the worktree while allowing one inside it.
// Dependencies: vitest
// Test Status: npm test -- src/support/osSandbox.test.ts
// ============================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBwrapArgs,
  buildMacSandboxProfile,
  defaultHiddenPaths,
  defaultWorkerWritableRoots,
  detectSandboxBackend,
  looksLikeSandboxDenial,
  wrapForSandbox,
} from './osSandbox.js';

describe('buildMacSandboxProfile', () => {
  it('allows loopback only, split by direction, when network is denied (AGT-4798)', () => {
    expect(buildMacSandboxProfile({ writableRoots: ['/w'], allowNetwork: false })).toBe(
      '(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) ' +
        '(allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*")) ' +
        '(allow network-outbound (remote ip "localhost:*")) ' +
        '(allow file-write* (subpath "/w") (literal "/dev/null") (literal "/dev/tty"))',
    );
  });

  it('adds network and every writable root for a worker', () => {
    const p = buildMacSandboxProfile({ writableRoots: ['/w', '/Users/x/.npm'], allowNetwork: true });
    expect(p).toContain('(allow network*)');
    expect(p).toContain('(subpath "/w") (subpath "/Users/x/.npm")');
  });

  it('escapes quotes and backslashes in paths so a crafted worktree name cannot break out of the profile', () => {
    const p = buildMacSandboxProfile({ writableRoots: ['/w/a"b\\c'], allowNetwork: false });
    expect(p).toContain('(subpath "/w/a\\"b\\\\c")');
  });
});

describe('buildBwrapArgs', () => {
  it('binds the root read-only, each writable root read-write, and keeps the network unless told otherwise', () => {
    expect(buildBwrapArgs({ writableRoots: ['/w', '/c'], allowNetwork: true })).toEqual([
      '--ro-bind', '/', '/', '--bind', '/w', '/w', '--bind', '/c', '/c',
      '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--',
    ]);
    expect(buildBwrapArgs({ writableRoots: ['/w'], allowNetwork: false })).toContain('--unshare-net');
  });
});

describe('hidden credential paths (AGT-4817)', () => {
  const homes: string[] = [];
  const tempHome = (prefix = 'osw-cred-home-'): string => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    homes.push(home);
    return home;
  };
  const touch = (path: string, content = 'fake-secret\n'): string => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('hides credential files and directories from the worker sandbox', () => {
    const home = tempHome();
    // Directories.
    mkdirSync(join(home, '.ssh'));
    touch(join(home, '.ssh', 'id_ed25519'));
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    mkdirSync(join(home, '.docker'));
    // Files, at the overridden locations and at the defaults.
    const cargoHome = join(home, 'opt-cargo');
    const cargoToml = touch(join(cargoHome, 'credentials.toml'));
    const cargoDefault = touch(join(home, '.cargo', 'credentials'));
    mkdirSync(join(home, '.cargo', 'registry'), { recursive: true });
    const hfHome = join(home, 'hf');
    const hfHomeToken = touch(join(hfHome, 'token'));
    const xdgCache = join(home, 'xdg-cache');
    const xdgToken = touch(join(xdgCache, 'huggingface', 'token'));
    const defaultHfToken = touch(join(home, '.cache', 'huggingface', 'token'));
    // huggingface_hub 0.25+ keeps every login in stored_tokens next to the token.
    const defaultStored = touch(join(home, '.cache', 'huggingface', 'stored_tokens'));
    const hfHomeStored = touch(join(hfHome, 'stored_tokens'));
    const netrc = touch(join(home, '.netrc'));
    // ~/.npmrc symlinked into a dotfiles repo is hidden at its target.
    const npmrcTarget = touch(join(home, 'dotfiles', 'npmrc'));
    symlinkSync(npmrcTarget, join(home, '.npmrc'));

    const env = { CARGO_HOME: cargoHome, HF_HOME: hfHome, XDG_CACHE_HOME: xdgCache };
    const hidden = defaultHiddenPaths(env, home);
    expect(hidden.dirs.sort()).toEqual([join(home, '.config', 'gh'), join(home, '.docker'), join(home, '.ssh')].sort());
    expect(hidden.files.sort()).toEqual(
      [cargoDefault, cargoToml, defaultHfToken, defaultStored, hfHomeStored, hfHomeToken, netrc, npmrcTarget, xdgToken].sort(),
    );
    // Caches stay out: only the token files inside them are hidden.
    for (const cache of [join(home, '.cache'), join(home, '.cargo'), join(home, '.cargo', 'registry'), xdgCache]) {
      expect(hidden.dirs).not.toContain(cache);
    }
    // A file inside a hidden directory is not listed again.
    expect(hidden.files).not.toContain(join(home, '.ssh', 'id_ed25519'));

    // Missing ones are skipped: an empty home hides nothing.
    expect(defaultHiddenPaths({}, tempHome())).toEqual({ dirs: [], files: [] });
  });

  it('hides a file candidate that is a directory as a directory, so bwrap can still start', () => {
    const home = tempHome();
    const tokenDir = join(home, 'odd', 'token');
    mkdirSync(tokenDir, { recursive: true });
    const hidden = defaultHiddenPaths({ HF_TOKEN_PATH: tokenDir }, home);
    expect(hidden).toEqual({ dirs: [tokenDir], files: [] });
    // The bwrap args then carry a --tmpfs, never a /dev/null bind over a directory.
    const args = buildBwrapArgs({ writableRoots: [], allowNetwork: false, hiddenRoots: hidden.dirs, hiddenFiles: hidden.files });
    expect(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2)).toEqual(['--tmpfs', tokenDir]);
    expect(args).not.toContain('/dev/null');
    // One that names the home dir or holds a writable root is skipped instead.
    const worktree = join(home, 'work', 'repo');
    mkdirSync(worktree, { recursive: true });
    expect(defaultHiddenPaths({ HF_TOKEN_PATH: home }, home)).toEqual({ dirs: [], files: [] });
    expect(defaultHiddenPaths({ SSH_AUTH_SOCK: join(home, 'work') }, home, [worktree])).toEqual({ dirs: [], files: [] });
  });

  it('hides the ssh-agent socket itself and the well-known agent sockets under XDG_RUNTIME_DIR', () => {
    const home = tempHome();
    const runtime = join(home, 'run');
    const sockets = [
      touch(join(runtime, 'ssh-agent.socket'), ''),
      touch(join(runtime, 'keyring', 'ssh'), ''),
      touch(join(runtime, 'gcr', 'ssh'), ''),
      touch(join(runtime, 'gnupg', 'S.gpg-agent.ssh'), ''),
    ];
    // SSH_AUTH_SOCK directly in the home dir: its directory may not be hidden,
    // the socket file still is.
    const homeSock = touch(join(home, 'agent.sock'), '');
    const hidden = defaultHiddenPaths({ XDG_RUNTIME_DIR: runtime, SSH_AUTH_SOCK: homeSock }, home);
    expect(hidden.dirs).toEqual([]);
    expect(hidden.files.sort()).toEqual([...sockets, homeSock].sort());
  });

  it('hides the ssh-agent socket directory only when that cannot mask the sandbox itself', () => {
    const home = tempHome();
    const agentDir = join(home, 'agent.d');
    mkdirSync(agentDir);
    const worktree = join(home, 'work', 'repo');
    mkdirSync(worktree, { recursive: true });
    const dirsFor = (sock: string, roots: string[] = []) => defaultHiddenPaths({ SSH_AUTH_SOCK: sock }, home, roots).dirs;
    expect(dirsFor(join(agentDir, 'agent.123'))).toEqual([agentDir]);
    expect(dirsFor(join(home, 'agent.sock'))).toEqual([]);          // the home dir
    expect(dirsFor('/agent.sock')).toEqual([]);                     // the filesystem root
    expect(dirsFor(join(tmpdir(), 'agent.sock'))).toEqual([]);      // the temp root
    expect(dirsFor('/tmp/agent.sock')).toEqual([]);
    expect(dirsFor(join(home, 'nope', 'agent.sock'))).toEqual([]); // does not exist
    expect(dirsFor(join(home, 'work', 'agent.sock'), [worktree])).toEqual([]); // holds a writable root
    expect(dirsFor('relative/agent.sock')).toEqual([]);
  });
});

describe('hidden path ordering (AGT-4817)', () => {
  const spec = {
    writableRoots: ['/w', '/home/u/.cache'],
    allowNetwork: false,
    hiddenRoots: ['/home/u/.ssh'],
    hiddenFiles: ['/home/u/.cache/huggingface/token', '/home/u/.netrc'],
  };

  it('bwrap: dir --tmpfs and file --ro-bind /dev/null come after every writable --bind', () => {
    const args = buildBwrapArgs(spec);
    const lastBind = args.lastIndexOf('--bind');
    expect(args.slice(lastBind, lastBind + 3)).toEqual(['--bind', '/home/u/.cache', '/home/u/.cache']);
    const tmpfs = args.indexOf('--tmpfs');
    expect(args.slice(tmpfs, tmpfs + 2)).toEqual(['--tmpfs', '/home/u/.ssh']);
    const token = args.indexOf('/home/u/.cache/huggingface/token');
    expect(args.slice(token - 2, token + 1)).toEqual(['--ro-bind', '/dev/null', '/home/u/.cache/huggingface/token']);
    const netrc = args.indexOf('/home/u/.netrc');
    expect(args.slice(netrc - 2, netrc + 1)).toEqual(['--ro-bind', '/dev/null', '/home/u/.netrc']);
    expect(tmpfs).toBeGreaterThan(lastBind);
    expect(token - 2).toBeGreaterThan(lastBind);
    expect(netrc - 2).toBeGreaterThan(lastBind);
    // All before the command separator.
    expect(Math.max(tmpfs, token, netrc)).toBeLessThan(args.indexOf('--'));
  });

  it('macOS: the deny literal/subpath rules come after the write allow', () => {
    const profile = buildMacSandboxProfile(spec);
    const writeAllow = profile.indexOf('(allow file-write*');
    const denyDir = profile.indexOf('(deny file-read* file-write* (subpath "/home/u/.ssh"))');
    const denyToken = profile.indexOf('(deny file-read* file-write* (literal "/home/u/.cache/huggingface/token"))');
    const denyNetrc = profile.indexOf('(deny file-read* file-write* (literal "/home/u/.netrc"))');
    expect(writeAllow).toBeGreaterThan(-1);
    for (const deny of [denyDir, denyToken, denyNetrc]) expect(deny).toBeGreaterThan(writeAllow);
    // The rename guards are last of all, after the write allow too.
    for (const guard of [
      '(deny file-link (literal "/home/u/.cache/huggingface/token"))',
      '(deny file-write* (literal "/home/u/.cache/huggingface"))',
    ]) {
      expect(profile.indexOf(guard)).toBeGreaterThan(writeAllow);
    }
  });

  it('macOS: a hidden path under a writable root keeps its name (no renaming its parents)', () => {
    const profile = buildMacSandboxProfile(spec);
    // mv ~/.cache/huggingface ~/.cache/hf would move the token out from under
    // its literal deny; the parent and the writable root itself are pinned.
    expect(profile).toContain('(deny file-write* (literal "/home/u/.cache/huggingface"))');
    expect(profile).toContain('(deny file-write* (literal "/home/u/.cache"))');
    expect(profile).toContain('(deny file-link (literal "/home/u/.cache/huggingface/token"))');
    expect(profile).toContain('(deny file-link (subpath "/home/u/.ssh"))');
    // Nothing outside a writable root is listed: it cannot be renamed anyway.
    expect(profile).not.toContain('(deny file-write* (literal "/home/u"))');
    expect(profile).not.toContain('(deny file-write* (literal "/home"))');
  });

  it('wrapForSandbox fills both hidden lists from the host when the caller gives none', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'osw-wrap-home-')));
    try {
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, '.netrc'), 'fake\n');
      vi.stubEnv('HOME', home);
      for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CARGO_HOME', 'HF_HOME', 'HF_TOKEN_PATH', 'GH_CONFIG_DIR', 'DOCKER_CONFIG', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR', 'OPENSWARM_DAEMON_TOKEN_DIR']) {
        vi.stubEnv(key, undefined);
      }
      const w = wrapForSandbox(['true'], { writableRoots: ['/w'], allowNetwork: false }, 'bwrap')!;
      expect(w.args).toEqual(expect.arrayContaining(['--tmpfs', join(home, '.ssh')]));
      const i = w.args.indexOf(join(home, '.netrc'));
      expect(w.args.slice(i - 2, i + 1)).toEqual(['--ro-bind', '/dev/null', join(home, '.netrc')]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('hides the credentials from a live Linux sandbox while the cache stays writable', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'osw-live-cred-home-')));
    const wt = realpathSync(mkdtempSync(join(tmpdir(), 'osw-live-cred-wt-')));
    try {
      const token = join(home, '.cache', 'huggingface', 'token');
      const key = join(home, '.ssh', 'id_ed25519');
      mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true });
      mkdirSync(join(home, '.ssh'));
      writeFileSync(token, 'hf_FAKE_TOKEN_SENTINEL\n');
      writeFileSync(key, 'FAKE_KEY_SENTINEL\n');
      const stored = join(home, '.cache', 'huggingface', 'stored_tokens');
      writeFileSync(stored, '[default]\nhf_token = hf_FAKE_STORED_SENTINEL\n');
      if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
        // The sandbox resolves the hidden set and the writable caches against
        // homedir(), which follows HOME on Linux: point it at the temp home so
        // the real computation runs, with nothing stubbed.
        vi.stubEnv('HOME', home);
        for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CARGO_HOME', 'HF_HOME', 'HF_TOKEN_PATH', 'GH_CONFIG_DIR', 'DOCKER_CONFIG', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR', 'OPENSWARM_DAEMON_TOKEN_DIR']) {
          vi.stubEnv(k, undefined);
        }
        const roots = defaultWorkerWritableRoots(wt);
        expect(roots).toContain(join(home, '.cache'));
        const script = [
          `cat "${token}"; echo "token_exit=$?"`,
          `cat "${key}"; echo "key_exit=$?"`,
          `cat "${stored}"; echo "stored_exit=$?"`,
          `echo x > "${token}" 2>/dev/null; echo "token_write_exit=$?"`,
          `touch "${join(home, '.cache', 'written')}" && echo cache=writable`,
        ].join('\n');
        const wrapped = wrapForSandbox(['bash', '-c', script], { writableRoots: roots, allowNetwork: false }, 'bwrap')!;
        const out = execFileSync(wrapped.file, wrapped.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        expect(out).not.toContain('FAKE_TOKEN_SENTINEL');
        expect(out).not.toContain('FAKE_KEY_SENTINEL');
        expect(out).not.toContain('FAKE_STORED_SENTINEL');
        expect(out).toMatch(/^stored_exit=[1-9]\d*$/m);
        // Both reads fail: the token is /dev/null bound on a nodev mount
        // (EACCES), the key is gone under an empty tmpfs (ENOENT).
        expect(out).toMatch(/^token_exit=[1-9]\d*$/m);
        expect(out).toMatch(/^key_exit=[1-9]\d*$/m);
        expect(out).not.toMatch(/^token_write_exit=0$/m);
        expect(out).toContain('cache=writable');
        expect(existsSync(join(home, '.cache', 'written'))).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

const hasLinuxBwrap = process.platform === 'linux' && existsSync('/usr/bin/bwrap');
describe.runIf(hasLinuxBwrap)('hidden agent socket (live bwrap, AGT-4817)', () => {
  it('refuses a connect to a hidden ssh-agent socket even with the network open', async () => {
    const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'osw-live-run-')));
    const sock = join(runtime, 'ssh-agent.socket');
    const server = createServer((c) => c.end());
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const probe = [
        'import socket, sys',
        'c = socket.socket(socket.AF_UNIX)',
        'try:',
        '    c.connect(sys.argv[1]); print("agent=CONNECTED")',
        'except OSError as e:',
        '    print("agent=refused")',
      ].join('\n');
      const run = (spec: Parameters<typeof wrapForSandbox>[1]) => {
        const w = wrapForSandbox(['python3', '-c', probe, sock], spec, 'bwrap')!;
        return execFileSync(w.file, w.args, { encoding: 'utf8' });
      };
      // Control: unhidden, the path socket is reachable through --unshare-net too.
      expect(run({ writableRoots: [], allowNetwork: false, hiddenRoots: [], hiddenFiles: [] })).toContain('agent=CONNECTED');
      const sockHome = realpathSync(mkdtempSync(join(tmpdir(), 'osw-live-sockhome-')));
      const hidden = defaultHiddenPaths({ XDG_RUNTIME_DIR: runtime }, sockHome);
      rmSync(sockHome, { recursive: true, force: true });
      expect(hidden.files).toEqual([sock]);
      expect(run({ writableRoots: [], allowNetwork: true, hiddenRoots: hidden.dirs, hiddenFiles: hidden.files })).toContain('agent=refused');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe('wrapForSandbox', () => {
  const spec = { writableRoots: ['/w'], allowNetwork: true };

  it('returns null when the host has no sandbox', () => {
    expect(wrapForSandbox(['bash', '-c', 'true'], spec, null)).toBeNull();
  });

  it('prefixes sandbox-exec with the profile on macOS', () => {
    const w = wrapForSandbox(['bash', '-c', 'true'], spec, 'sandbox-exec');
    expect(w?.file).toBe('/usr/bin/sandbox-exec');
    expect(w?.args.slice(0, 1)).toEqual(['-p']);
    expect(w?.args.slice(-3)).toEqual(['bash', '-c', 'true']);
  });

  it('prefixes bwrap with the bind list on Linux', () => {
    const w = wrapForSandbox(['bash', '-c', 'true'], spec, 'bwrap');
    expect(w?.file).toMatch(/bwrap$/);
    expect(w?.args.slice(-4)).toEqual(['--', 'bash', '-c', 'true']);
  });

  it('refuses an empty argv', () => {
    expect(() => wrapForSandbox([], spec, 'sandbox-exec')).toThrow(/empty argv/);
  });
});

describe('defaultWorkerWritableRoots', () => {
  it('starts with the worktree (realpath), includes the temp dir, and drops caches the host never created', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-sbx-'));
    const home = mkdtempSync(join(tmpdir(), 'osw-home-'));
    const roots = defaultWorkerWritableRoots(wt, { TMPDIR: tmpdir() }, home);
    expect(roots[0]).toBe(realpathSync(wt));
    expect(roots).toContain(realpathSync(tmpdir()));
    // An empty home has none of the cache dirs, so none are listed.
    expect(roots.some((r) => r.startsWith(realpathSync(home)))).toBe(false);
    // No duplicates even when TMPDIR and /tmp resolve to the same place.
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('excludes Wrangler directories from writable roots and refuses a Linux sandbox write', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-wrangler-wt-'));
    const home = mkdtempSync(join(process.env.HOME ?? '/home', 'osw-wrangler-home-'));
    try {
      mkdirSync(join(home, '.wrangler'));
      mkdirSync(join(home, 'Library', 'Preferences', '.wrangler'), { recursive: true });
      const roots = defaultWorkerWritableRoots(wt, { TMPDIR: '/tmp' }, home);
      expect(roots).not.toContain(realpathSync(join(home, '.wrangler')));
      expect(roots).not.toContain(realpathSync(join(home, 'Library', 'Preferences', '.wrangler')));
      if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
        const wrapped = wrapForSandbox(['bash', '-c', `touch "${join(home, '.wrangler', 'x')}"`],
          { writableRoots: roots, allowNetwork: false }, 'bwrap')!;
        expect(() => execFileSync(wrapped.file, wrapped.args, { stdio: 'pipe' })).toThrow();
        expect(existsSync(join(home, '.wrangler', 'x'))).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('looksLikeSandboxDenial', () => {
  it('recognises the OS refusals and nothing else', () => {
    expect(looksLikeSandboxDenial('touch: /Users/x/y: Operation not permitted')).toBe(true);
    expect(looksLikeSandboxDenial('EROFS: read-only file system')).toBe(true);
    expect(looksLikeSandboxDenial('grep: no matches')).toBe(false);
  });
});

// The real fence, on a host that has it. CI's ubuntu runner may lack a usable
// bwrap (user namespaces), so this only runs where sandbox-exec exists.
const hasMacSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
describe.runIf(hasMacSandbox)('sandbox-exec fence (live)', () => {
  it('allows a write inside the worktree and refuses one outside it', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-fence-'));
    const outside = mkdtempSync(join(tmpdir(), 'osw-outside-'));
    const spec = { writableRoots: [realpathSync(wt)], allowNetwork: false };
    const inside = wrapForSandbox(['bash', '-c', `touch "${wt}/ok" && echo inside-ok`], spec, 'sandbox-exec')!;
    expect(execFileSync(inside.file, inside.args, { encoding: 'utf8' })).toContain('inside-ok');
    const escape = wrapForSandbox(['bash', '-c', `touch "${outside}/nope" 2>&1; echo "exit=$?"`], spec, 'sandbox-exec')!;
    const out = execFileSync(escape.file, escape.args, { encoding: 'utf8' });
    expect(out).toMatch(/Operation not permitted/);
    expect(out).toMatch(/exit=1/);
    expect(existsSync(join(outside, 'nope'))).toBe(false);
    expect(detectSandboxBackend('darwin')).toBe('sandbox-exec');
  });

  it('keeps a hidden token hidden when a worker renames its parent (AGT-4817)', () => {
    const cache = realpathSync(mkdtempSync(join(tmpdir(), 'osw-mac-cache-')));
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'osw-mac-other-')));
    const hf = join(cache, 'huggingface');
    mkdirSync(hf);
    const token = join(hf, 'token');
    writeFileSync(token, 'hf_FAKE_MAC_SENTINEL\n');
    const spec = { writableRoots: [cache, other], allowNetwork: false, hiddenRoots: [], hiddenFiles: [token] };
    const script = [
      `cat "${token}"; echo "cat_exit=$?"`,
      `mv "${hf}" "${cache}/hf" 2>/dev/null; echo "mv_parent_exit=$?"`,
      `cat "${cache}/hf/token" 2>/dev/null`,
      `mv "${cache}" "${other}/c" 2>/dev/null; echo "mv_root_exit=$?"`,
      `cat "${other}/c/huggingface/token" 2>/dev/null`,
      `ln "${token}" "${cache}/linked" 2>/dev/null; echo "ln_exit=$?"`,
      `cat "${cache}/linked" 2>/dev/null`,
      `touch "${hf}/model.bin" && touch "${cache}/direct" && echo cache=writable`,
    ].join('\n');
    const w = wrapForSandbox(['bash', '-c', script], spec, 'sandbox-exec')!;
    const out = execFileSync(w.file, w.args, { encoding: 'utf8' });
    expect(out).not.toContain('FAKE_MAC_SENTINEL');
    expect(out).toMatch(/^cat_exit=[1-9]\d*$/m);
    expect(out).toMatch(/^mv_parent_exit=[1-9]\d*$/m);
    expect(out).toMatch(/^mv_root_exit=[1-9]\d*$/m);
    expect(out).toMatch(/^ln_exit=[1-9]\d*$/m);
    expect(out).toContain('cache=writable');
  });

  // The distinguishing error is EPERM: a host that is merely offline fails
  // with ENETUNREACH or a timeout instead, so this cannot pass by accident.
  it('without network, serves loopback and refuses a remote host (AGT-4798)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'osw-net-'));
    const probe = [
      'import socket, errno',
      's = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen()',
      'c = socket.socket(); c.connect(s.getsockname()); print("loopback=ok")',
      'try:',
      '    socket.create_connection(("1.1.1.1", 443), timeout=3); print("remote=OPEN")',
      'except OSError as e:',
      '    print("remote=" + ("EPERM" if e.errno == errno.EPERM else "other:" + str(e.errno)))',
    ].join('\n');
    const spec = { writableRoots: [realpathSync(wt)], allowNetwork: false };
    const fenced = wrapForSandbox(['python3', '-c', probe], spec, 'sandbox-exec')!;
    const out = execFileSync(fenced.file, fenced.args, { encoding: 'utf8' });
    expect(out).toContain('loopback=ok');
    expect(out).toContain('remote=EPERM');
  });
});
