import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function canonicalizeExistingPath(candidate: string): string {
  if (existsSync(candidate)) return realpathSync(candidate);
  const suffix: string[] = [];
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

/**
 * Return the main checkout for a genuine linked Git worktree.
 *
 * The worktree-side `.git` file is writable by the worker, so its forward
 * pointer is not authority. Git's reverse `<gitDir>/gitdir` pointer lives in
 * the main checkout; requiring both directions prevents a forged `.git` file
 * from granting reads or mounts from a sibling repository.
 */
export function linkedMainCheckoutOf(root: string): string | null {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    // This helper is an optional worktree exception, not cwd validation.
    // Callers may still safely authorize another absolute root (for example
    // /tmp) when the supplied project cwd is absent on the current host.
    return null;
  }
  const dotGit = path.join(canonicalRoot, '.git');
  let raw: string;
  try {
    if (!statSync(dotGit).isFile()) return null;
    raw = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!match) return null;
  const gitDir = path.resolve(canonicalRoot, match[1]);
  if (path.basename(path.dirname(gitDir)) !== 'worktrees') return null;
  const commonDir = path.dirname(path.dirname(gitDir));
  if (path.basename(commonDir) !== '.git') return null;

  let backLink: string;
  try {
    backLink = readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!backLink
      || canonicalizeExistingPath(path.dirname(path.resolve(gitDir, backLink))) !== canonicalRoot) {
    return null;
  }

  const mainRoot = path.dirname(commonDir);
  if (path.dirname(mainRoot) === mainRoot) return null;
  try {
    return statSync(mainRoot).isDirectory() ? realpathSync(mainRoot) : null;
  } catch {
    return null;
  }
}
