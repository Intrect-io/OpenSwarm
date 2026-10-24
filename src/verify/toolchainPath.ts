import { delimiter, dirname, join } from 'node:path';

/** Shared dependency directories the verify sandbox may bind read-only from the live tree. */
export const VERIFY_ALLOWED_DEPENDENCY_DIRS = new Set([
  'node_modules', '.venv-verify', '.venv', 'venv',
]);

/** Read-only toolchain PATH prefixes the verifier may inherit from the host. */
export const VERIFY_TOOLCHAIN_PATH_PREFIXES = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
] as const;

/**
 * Build the sandbox PATH from project-local dependency bins plus an explicit
 * read-only toolchain allowlist. Host PATH entries outside those prefixes are
 * dropped, so a writable tool install cannot shadow a sandbox tool.
 */
export function buildVerifyToolchainPath(
  envPath: string | undefined,
  root: string,
  cwd: string = root,
): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    entries.push(candidate);
  };

  for (const base of [cwd, root]) {
    add(join(base, 'node_modules', '.bin'));
    for (const venv of VERIFY_ALLOWED_DEPENDENCY_DIRS) {
      if (venv === 'node_modules') continue;
      add(join(base, venv, process.platform === 'win32' ? 'Scripts' : 'bin'));
    }
  }

  // Use the selected daemon's interpreter before generic system prefixes.
  add(dirname(process.execPath));
  for (const prefix of VERIFY_TOOLCHAIN_PATH_PREFIXES) add(prefix);

  for (const part of (envPath ?? '').split(delimiter)) {
    if (!part) continue;
    const normalized = part.replace(/\\/g, '/').replace(/\/+$/, '');
    const allowedPrefix = VERIFY_TOOLCHAIN_PATH_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
    const projectLocal = /(?:^|\/)(?:node_modules\/\.bin|(?:\.venv-verify|\.venv|venv)\/(?:bin|Scripts))$/
      .test(normalized);
    const versionManagerBin = /(?:^|\/)(?:\.?nvm|fnm|asdf|volta|n)(?:\/|$)/.test(normalized)
      && normalized.endsWith('/bin');
    if (allowedPrefix || projectLocal || versionManagerBin) add(part);
  }

  return entries.join(delimiter);
}
