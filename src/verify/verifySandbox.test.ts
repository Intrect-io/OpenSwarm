import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DARWIN_SANDBOX_EXEC, makeBwrapOverlayProbe, selectOsSandbox, type OsSandboxDeps } from './verifySandbox.js';

// Platform is injected, so the macOS branches run on any host. They were not
// exercised against a real sandbox-exec here.
function deps(overrides: Partial<OsSandboxDeps>): OsSandboxDeps {
  return {
    platform: 'linux',
    exists: () => true,
    realpath: async (path) => path,
    linuxSandbox: () => ({ available: true, executable: '/usr/bin/bwrap' }),
    ...overrides,
  };
}

describe('selectOsSandbox (AGT-3447)', () => {
  it('fails closed on macOS when sandbox-exec is missing instead of running a plain shell', async () => {
    const exists = vi.fn(() => false);
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/zsh', 'npm test', deps({ platform: 'darwin', exists }));
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.output).toContain(`${DARWIN_SANDBOX_EXEC} not found`);
    expect(exists).toHaveBeenCalledWith(DARWIN_SANDBOX_EXEC);
  });

  it('wraps the command in sandbox-exec on macOS with only the sandbox parent writable', async () => {
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/zsh', 'npm test', deps({
      platform: 'darwin',
      realpath: async () => '/private/scratch/x',
    }));
    expect(choice).toMatchObject({ ok: true, executable: DARWIN_SANDBOX_EXEC });
    if (choice.ok) {
      expect(choice.args[0]).toBe('-p');
      expect(choice.args[1]).toContain('(deny default)');
      expect(choice.args[1]).toContain('(subpath "/private/scratch/x")');
      expect(choice.args.slice(2)).toEqual(['/bin/zsh', '-lc', 'npm test']);
    }
  });

  it('fails closed on an unrecognised platform', async () => {
    const choice = await selectOsSandbox('/r/repo', '/bin/sh', 'make test', deps({ platform: 'freebsd' }));
    expect(choice).toEqual({ ok: false, output: '[security] OS verification sandbox is unavailable on platform freebsd' });
  });

  it('fails closed on Windows', async () => {
    const choice = await selectOsSandbox('C:/r/repo', 'cmd', 'test', deps({ platform: 'win32' }));
    expect(choice.ok).toBe(false);
  });

  it('uses bubblewrap on Linux and reports why it is unavailable', async () => {
    const ok = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'npm test', deps({}));
    expect(ok).toMatchObject({ ok: true, executable: '/usr/bin/bwrap' });
    if (ok.ok) expect(ok.args).toEqual(expect.arrayContaining(['--unshare-net', '--bind', '/scratch/x', '/scratch/x']));

    const missing = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'npm test', deps({
      linuxSandbox: () => ({ available: false, reason: 'bwrap missing', remedy: ['install bubblewrap'] }),
    }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.output).toContain('bwrap missing');
  });
});

// #817: the host uv cache is reachable only as a throwaway overlay, never writable.
describe('selectOsSandbox uvCacheOverlay (#817, offline uv cache)', () => {
  const overlay = { cache: '/home/u/.cache/uv', upper: '/scratch/x/uv-cache/upper', work: '/scratch/x/uv-cache/work' };

  it('mounts the cache as an overlay after the root bind and sets offline copy mode', async () => {
    const overlaySupported = vi.fn(() => true);
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'uv run pytest', deps({ uvCacheOverlay: overlay, overlaySupported }));
    expect(overlaySupported).toHaveBeenCalledWith('/usr/bin/bwrap', overlay);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const at = choice.args.indexOf('--overlay-src');
    expect(choice.args.slice(at, at + 6)).toEqual(['--overlay-src', overlay.cache, '--overlay', overlay.upper, overlay.work, overlay.cache]);
    expect(at).toBeGreaterThan(choice.args.indexOf('/scratch/x'));
    expect(at).toBeLessThan(choice.args.indexOf('--unshare-net'));
    const joined = choice.args.join(' ');
    expect(joined).toContain(`--setenv UV_CACHE_DIR ${overlay.cache}`);
    expect(joined).toContain('--setenv UV_OFFLINE 1');
    expect(joined).toContain('--setenv UV_LINK_MODE copy');
    // The cache itself is never bound writable.
    expect(choice.args.filter((a) => a === '--bind')).toHaveLength(1);
  });

  it('exposes no cache and sets no uv variables when bwrap cannot overlay', async () => {
    for (const overlaySupported of [() => false, undefined]) {
      const choice = await selectOsSandbox('/scratch/x/repo', '/bin/sh', 'uv run pytest', deps({ uvCacheOverlay: overlay, overlaySupported }));
      expect(choice.ok).toBe(true);
      if (!choice.ok) continue;
      expect(choice.args).not.toContain(overlay.cache);
      expect(choice.args.join(' ')).not.toMatch(/UV_|overlay/);
    }
  });

  it('never adds the cache to the macOS write allowlist', async () => {
    const choice = await selectOsSandbox('/scratch/x/repo', '/bin/zsh', 'uv run pytest', deps({
      platform: 'darwin',
      realpath: async () => '/private/scratch/x',
      uvCacheOverlay: { ...overlay, cache: '/Users/u/.cache/uv' },
      overlaySupported: () => true,
    }));
    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.args[1]).not.toContain('.cache/uv');
      expect(choice.args.join(' ')).not.toContain('UV_');
    }
  });
});

describe('makeBwrapOverlayProbe', () => {
  const ok = { status: 0, stdout: '', stderr: '' };
  let scratch: string;
  beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'osw-overlay-probe-')); });
  afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });
  const overlayIn = () => ({ cache: '/c', upper: join(scratch, 'upper'), work: join(scratch, 'work') });

  it('requires the overlay flags in --help and a write through a trial mount, and memoizes the answer', async () => {
    const spawn = vi.fn((_: string, args: string[]) => (args[0] === '--help'
      ? { ...ok, stdout: '--overlay-src SRC\n--overlay RWSRC WORKDIR DEST\n' }
      : ok));
    const probe = makeBwrapOverlayProbe(spawn);
    expect(probe('/usr/bin/bwrap', overlayIn())).toBe(true);
    expect(probe('/usr/bin/bwrap', overlayIn())).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    const trial = spawn.mock.calls[1][1];
    expect(trial.indexOf('--overlay-src')).toBeLessThan(trial.indexOf('--overlay'));
    expect(trial.slice(-2)).toEqual(['touch', '/c/.openswarm-overlay-probe']);
    expect(await readdir(scratch)).toEqual([]); // the trial's upper/work are cleaned up
  });

  it('says no for an old bwrap, a refused trial write, or a probe that throws', () => {
    expect(makeBwrapOverlayProbe(() => ({ ...ok, stdout: '--bind SRC DEST' }))('/b', overlayIn())).toBe(false);
    expect(makeBwrapOverlayProbe((_, args) => (args[0] === '--help'
      ? { ...ok, stdout: '--overlay-src SRC --overlay RWSRC WORKDIR DEST' }
      : { status: 1, stdout: '', stderr: 'touch: Invalid argument' }))('/b', overlayIn())).toBe(false);
    expect(makeBwrapOverlayProbe(() => { throw new Error('spawn failed'); })('/b', overlayIn())).toBe(false);
  });
});
