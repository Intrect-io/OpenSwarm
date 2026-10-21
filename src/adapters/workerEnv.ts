// ============================================
// OpenSwarm - Worker shell environment (AGT-4783)
// ============================================
//
// The worker's `bash` tool used to inherit the daemon's whole environment and
// its real HOME. On 2026-10-20 a cgf-portal worker ran
// `bash scripts/dev/release.sh --help`; the script called `gh workflow run` with
// the operator's GitHub credentials and shipped an unapproved production deploy.
// No command-name matcher can see inside a script, so the shell is given no
// identity to act with instead:
//
//   - only an allowlist of variables crosses over (toolchain, locale, terminal,
//     test-resource budget) — tokens, keys, DSNs and the daemon's own secrets
//     do not;
//   - HOME is a private directory, so file-based logins under the real HOME
//     (`wrangler`'s OAuth file, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`)
//     are not found by the tools that read them; caches and toolchain homes are
//     re-pointed at the real directories so builds stay as fast as before;
//   - `gh` gets an empty config dir, git's credential helpers are reset to none,
//     and git over ssh gets no identity.
//
// This removes the credentials tools pick up on their own. A command that
// deliberately reads a token file by absolute path is still possible while the
// worker sandbox allows the network; network-off (S6 W1) closes that.

import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { withTestResourceBudget } from '../support/testResourceBudget.js';

/** Variables a worker shell may inherit verbatim. Everything else is dropped. */
const INHERITED_KEYS = new Set([
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  // Toolchain selection, no credentials.
  'JAVA_HOME', 'GOROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYENV_VERSION',
  // Trust stores; a corporate proxy's CA is not a credential.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // Test-resource budget emitted by withTestResourceBudget.
  'OPENSWARM_TEST_PARALLELISM', 'PYTEST_XDIST_AUTO_NUM_WORKERS', 'CARGO_BUILD_JOBS',
  'RAYON_NUM_THREADS', 'CMAKE_BUILD_PARALLEL_LEVEL', 'GOMAXPROCS', 'UV_CONCURRENT_BUILDS',
  // Windows process basics.
  'SystemRoot', 'ComSpec', 'PATHEXT', 'windir',
]);

/**
 * Tool homes and caches that live under the real HOME. They are pointed back at
 * the real directories (when present and not already set) so an isolated HOME
 * does not force a cold toolchain or a re-download on every command. None of
 * them is where the tool keeps a login.
 */
function realToolHomes(home: string): Record<string, string> {
  const library = path.join(home, 'Library', 'Caches');
  return {
    CARGO_HOME: path.join(home, '.cargo'),
    RUSTUP_HOME: path.join(home, '.rustup'),
    NVM_DIR: path.join(home, '.nvm'),
    PYENV_ROOT: path.join(home, '.pyenv'),
    BUN_INSTALL: path.join(home, '.bun'),
    GOPATH: path.join(home, 'go'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    UV_CACHE_DIR: path.join(home, '.cache', 'uv'),
    UV_PYTHON_INSTALL_DIR: path.join(home, '.local', 'share', 'uv', 'python'),
    npm_config_cache: path.join(home, '.npm'),
    PIP_CACHE_DIR: process.platform === 'darwin' ? path.join(library, 'pip') : path.join(home, '.cache', 'pip'),
    GOCACHE: process.platform === 'darwin' ? path.join(library, 'go-build') : path.join(home, '.cache', 'go-build'),
  };
}

/** User tool bins a login shell would add; the bash tool runs non-login. (INT-2485) */
function userToolBins(home: string): string[] {
  return [
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

let processWorkerHome: string | undefined;

/** One private HOME per daemon process, created on first use under the temp dir. */
function defaultWorkerHome(): string {
  if (processWorkerHome && existsSync(processWorkerHome)) return processWorkerHome;
  processWorkerHome = mkdtempSync(path.join(tmpdir(), 'openswarm-worker-home-'));
  return processWorkerHome;
}

export interface WorkerShellEnvOptions {
  /** The real home the tool homes and PATH bins are resolved against. */
  realHome?: string;
  /** The private HOME the shell sees. Defaults to one temp dir per process. */
  workerHome?: string;
}

/**
 * The environment a worker's shell command runs with. See the file header for
 * what it withholds and why.
 */
export function buildWorkerShellEnv(
  base: NodeJS.ProcessEnv = process.env,
  options: WorkerShellEnvOptions = {},
): NodeJS.ProcessEnv {
  const realHome = options.realHome ?? homedir();
  const workerHome = options.workerHome ?? defaultWorkerHome();
  const ghConfigDir = path.join(workerHome, '.config', 'gh');
  mkdirSync(ghConfigDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (INHERITED_KEYS.has(key) || key.startsWith('LC_'))) env[key] = value;
  }

  const current = (base.PATH ?? base.Path ?? '').split(path.delimiter).filter(Boolean);
  const bins = userToolBins(realHome);
  env.PATH = [...bins.filter((p) => !current.includes(p)), ...current].join(path.delimiter);

  for (const [key, dir] of Object.entries(realToolHomes(realHome))) {
    const inherited = base[key];
    if (inherited) env[key] = inherited;
    else if (existsSync(dir)) env[key] = dir;
  }

  Object.assign(env, {
    HOME: workerHome,
    USERPROFILE: workerHome,
    XDG_CONFIG_HOME: path.join(workerHome, '.config'),
    XDG_DATA_HOME: path.join(workerHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(workerHome, '.local', 'state'),
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    // An empty credential.helper at command-line precedence clears every helper
    // configured in the system or global config (osxkeychain included).
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_SSH_COMMAND: 'ssh -F /dev/null -o IdentitiesOnly=yes -i /dev/null -o BatchMode=yes',
    // The private HOME has no ~/.gitconfig; commands that need an identity
    // (stash, a local commit in a scratch repo) still work.
    GIT_AUTHOR_NAME: 'OpenSwarm worker',
    GIT_AUTHOR_EMAIL: 'worker@openswarm.invalid',
    GIT_COMMITTER_NAME: 'OpenSwarm worker',
    GIT_COMMITTER_EMAIL: 'worker@openswarm.invalid',
  });

  return withTestResourceBudget(env);
}

/** Test seam: forget the per-process worker HOME. */
export function resetWorkerHomeForTests(): void {
  processWorkerHome = undefined;
}
