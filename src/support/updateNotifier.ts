// ============================================
// OpenSwarm - Update notifier (INT-2270)
// ============================================
//
// Tell a user on an older version that a newer one is on npm. Reads a 24h cache
// (~/.openswarm/update-check.json) so almost every run is instant; at most once
// a day it does a short-timeout registry fetch. Silent on any error, non-TTY,
// CI, `--version`/`--help`, or `NO_UPDATE_NOTIFIER` — it must never slow down or
// break the CLI. The network/fs/clock are injectable for tests.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { c } from './colors.js';

const PKG = '@intrect/openswarm';
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = join(homedir(), '.openswarm', 'update-check.json');

interface UpdateCache {
  latest: string;
  checkedAt: number;
  /** A `latest` version we already installed-and-verified as NOT taking effect (AGT-3183) — skip reinstalling it. */
  failedInstallVersion?: string;
}

/** Numeric semver compare (pre-release tags ignored). `latest` strictly newer? Pure. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/** Skip the check for non-interactive, CI, opted-out, or meta/help invocations. Pure. */
export function shouldSkip(argv: string[], env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (!isTTY) return true;
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.OPENSWARM_NO_UPDATE_NOTIFIER) return true;
  const args = argv.slice(2);
  const META = new Set(['--version', '-V', '--help', '-h', 'help', 'completion']);
  if (args.some((a) => META.has(a))) return true;
  return false;
}

/** Fetch the latest published version from the npm registry (short timeout). */
async function fetchLatest(timeoutMs = 1200): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): UpdateCache | null {
  try {
    const obj = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return typeof obj?.latest === 'string' && typeof obj?.checkedAt === 'number' ? obj : null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Cache is best-effort; a read-only home must not break the CLI.
  }
}

/** The two-line notice, styled with the shared console colors. Pure. */
export function formatUpdateNotice(current: string, latest: string): string {
  return (
    `\n  ${c.dim('Update available')} ${c.dim(current)} ${c.dim('→')} ${c.green(latest)}\n` +
    `  Run ${c.cyan(`npm i -g ${PKG}`)} to update.\n`
  );
}

export interface NotifierDeps {
  fetchLatest?: (timeoutMs?: number) => Promise<string | null>;
  readCache?: () => UpdateCache | null;
  writeCache?: (cache: UpdateCache) => void;
  now?: () => number;
  write?: (s: string) => void;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/**
 * Print an "update available" notice if the running version is behind the latest
 * on npm. Uses the 24h cache; only fetches when the cache is stale (and backs off
 * — stamping checkedAt even on a failed fetch — so it never refetches every run).
 * Never throws. (INT-2270)
 */
export async function maybeNotifyUpdate(current: string, deps: NotifierDeps = {}): Promise<void> {
  try {
    const argv = deps.argv ?? process.argv;
    const env = deps.env ?? process.env;
    const isTTY = deps.isTTY ?? !!process.stdout.isTTY;
    if (shouldSkip(argv, env, isTTY)) return;

    const now = deps.now ?? (() => Date.now());
    const read = deps.readCache ?? readCache;
    const write = deps.writeCache ?? writeCache;
    const fetchFn = deps.fetchLatest ?? fetchLatest;
    const out = deps.write ?? ((s: string) => process.stderr.write(s));

    const cache = read();
    let latest = cache?.latest ?? null;
    const fresh = cache != null && now() - cache.checkedAt < DAY_MS;

    if (!fresh) {
      const fetched = await fetchFn();
      // Back off even on failure (reuse the last known latest, or the current
      // version) so a registry hiccup doesn't make every run hit the network.
      // Registry data is intentionally not persisted. The notifier only needs
      // it for this invocation; keeping the locally installed version as the
      // cache marker retains the daily backoff without turning an HTTP response
      // into a file write.
      write({ latest: current, checkedAt: now() });
      if (fetched) latest = fetched;
    }

    if (latest && isNewer(latest, current)) out(formatUpdateNotice(current, latest));
  } catch {
    // A notifier must never break the CLI.
  }
}

/** `npm install -g <pkg>@latest`. Returns true on success. (INT-2394) */
function defaultInstall(pkg: string): boolean {
  try {
    execFileSync('npm', ['install', '-g', `${pkg}@latest`], { stdio: 'inherit', timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * What re-running the exact command `defaultReexec` is about to run would
 * report as its own version — not what npm just installed. `npm install`
 * exiting 0 only proves the package landed somewhere; when that somewhere is
 * not on the resolution path this process's own entry point re-execs into
 * (prefix/PATH mismatch — nvm/homebrew/asdf, a stray `npm link`, ...), the
 * binary that actually runs next is unchanged. This asks the same question
 * `reexec()` is about to answer, before claiming success. (AGT-3183)
 */
function resolvedVersion(): string | null {
  try {
    const entry = process.argv[1];
    if (!entry) return null;
    const result = spawnSync(process.execPath, [entry, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, OPENSWARM_UPDATED: '1' },
    });
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Best-effort `npm prefix -g`, for the diagnostic warning only — never throws. */
function installPrefix(): string | null {
  try {
    const result = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5_000 });
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Explains a verified-unchanged install instead of silently claiming "Updated" and looping. */
function formatInstallMismatchWarning(
  latest: string,
  resolved: string | null,
  current: string,
  getInstallPrefix: () => string | null,
): string {
  const lines = [
    `\n  ${c.dim('npm installed')} ${c.green(latest)} ${c.dim('but the binary this process re-execs into still resolves to')} ${c.dim(resolved ?? current)}.`,
    `  ${c.dim("npm's global install prefix likely does not match what actually runs `openswarm` — mixed nvm/homebrew/asdf, or a stray `npm link`.")}`,
  ];
  const prefix = getInstallPrefix();
  if (prefix) lines.push(`  ${c.dim(`npm installed to: ${prefix}`)}`);
  lines.push(`  ${c.dim(`Currently running from: ${process.argv[1] ?? 'unknown'}`)}`);
  lines.push(`  ${c.dim(`Run npm i -g ${PKG} manually and check which one PATH resolves.`)}\n`);
  return lines.join('\n');
}

/**
 * Re-run the current command with the freshly-installed binary. Marks the child
 * with OPENSWARM_UPDATED=1 so it won't try to update again (loop guard), waits
 * for it, and exits with its code. Does not return on success. (INT-2394)
 */
function defaultReexec(): void {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, OPENSWARM_UPDATED: '1' },
  });
  process.exit(child.status ?? 0);
}

export interface AutoUpdateDeps extends NotifierDeps {
  install?: (pkg: string) => boolean;
  reexec?: () => void;
  /** What re-execing would actually report as its version, post-install. Injectable for tests. (AGT-3183) */
  resolvedVersion?: () => string | null;
  /** Best-effort `npm prefix -g`, for the mismatch diagnostic only. Injectable for tests. (AGT-3183) */
  installPrefix?: () => string | null;
}

/**
 * Auto-update: if a newer version is on npm, `npm i -g` it and re-exec the
 * current command on the new binary. Default ON; falls back to a passive notice
 * when opted out (OPENSWARM_NO_AUTO_UPDATE). Skips CI/non-TTY/meta invocations
 * (never installs unattended) and no-ops once re-executed (OPENSWARM_UPDATED).
 * Uses the same 24h cache as the notice. Never throws. (INT-2394)
 *
 * `npm install` exiting 0 only proves the package landed somewhere — not that
 * the binary this process re-execs into changed (INT-2394 assumed it did and
 * looped forever when npm's install prefix and PATH disagreed, AGT-3183). So a
 * successful install is verified against `resolvedVersion()` before it is
 * reported or re-exec'd into; a verified-unchanged version is remembered
 * (`failedInstallVersion`) so the next run skips straight to a passive notice
 * instead of paying for another `npm install` it already knows won't take.
 */
export async function maybeAutoUpdate(current: string, deps: AutoUpdateDeps = {}): Promise<void> {
  try {
    const argv = deps.argv ?? process.argv;
    const env = deps.env ?? process.env;
    const isTTY = deps.isTTY ?? !!process.stdout.isTTY;

    if (env.OPENSWARM_UPDATED) return;                       // already the re-exec'd child
    if (env.OPENSWARM_NO_AUTO_UPDATE) return maybeNotifyUpdate(current, deps); // opted out → notice only
    if (shouldSkip(argv, env, isTTY)) return;                // CI / non-TTY / --version etc.

    const now = deps.now ?? (() => Date.now());
    const read = deps.readCache ?? readCache;
    const write = deps.writeCache ?? writeCache;
    const fetchFn = deps.fetchLatest ?? fetchLatest;
    const out = deps.write ?? ((s: string) => process.stderr.write(s));
    const install = deps.install ?? defaultInstall;
    const reexec = deps.reexec ?? defaultReexec;
    const getResolvedVersion = deps.resolvedVersion ?? resolvedVersion;
    const getInstallPrefix = deps.installPrefix ?? installPrefix;

    const cache = read();
    let latest = cache?.latest ?? null;
    const failedInstallVersion = cache?.failedInstallVersion;
    const fresh = cache != null && now() - cache.checkedAt < DAY_MS;
    if (!fresh) {
      const fetched = await fetchFn();
      // Keep the downloaded version in memory for this re-exec decision, but
      // do not persist remote registry data to the local cache. Carry the
      // failure marker forward — a routine daily refresh must not forget it.
      write({ latest: current, checkedAt: now(), failedInstallVersion });
      if (fetched) latest = fetched;
    }

    if (!latest || !isNewer(latest, current)) return;

    if (failedInstallVersion === latest) {
      // Already installed-and-verified this exact version as a no-op once —
      // reinstalling every run is the actual cost the bug report measured
      // ("모든 명령이 수 초씩 느려지고"). Fall back to the passive notice.
      out(formatUpdateNotice(current, latest));
      return;
    }

    out(`\n  ${c.dim('Updating')} ${c.dim(current)} ${c.dim('→')} ${c.green(latest)}…\n`);
    if (!install(PKG)) {
      out(`  ${c.dim(`Auto-update failed; continuing on ${current}. Run npm i -g ${PKG} manually.`)}\n`);
      write({ latest: current, checkedAt: now(), failedInstallVersion: latest });
      return;
    }

    const resolved = getResolvedVersion();
    if (resolved == null || isNewer(latest, resolved)) {
      out(formatInstallMismatchWarning(latest, resolved, current, getInstallPrefix));
      write({ latest: current, checkedAt: now(), failedInstallVersion: latest });
      return;
    }

    out(`  ${c.green('Updated')} ${c.dim('→')} ${c.green(latest)}. ${c.dim('Restarting…')}\n`);
    reexec(); // replaces/exits the process on success
  } catch {
    // Auto-update must never break the CLI.
  }
}
