import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { linkedMainCheckoutOf } from '../security/gitWorktreeIdentity.js';

const PYTHON_ENVIRONMENT_NAMES = ['.venv', '.venv-verify', 'venv'];

/** The roots an editable `.pth` line may point into when it belongs to `sourceProject`. */
async function sourceRootsOf(sourceProject: string): Promise<string[]> {
  return [resolve(sourceProject), await realpath(sourceProject).catch(() => null), linkedMainCheckoutOf(sourceProject)]
    .filter((root): root is string => root !== null)
    .sort((a, b) => b.length - a.length);
}

function insideAnyRoot(value: string, roots: string[]): string | null {
  for (const root of roots) {
    const suffix = relative(root, value);
    if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) return root;
  }
  return null;
}

/** `site-packages` directories of a virtualenv (POSIX and Windows layouts). */
async function sitePackagesOf(environment: string): Promise<string[]> {
  const siteDirectories = [join(environment, 'Lib', 'site-packages')];
  try {
    for (const entry of await readdir(join(environment, 'lib'), { withFileTypes: true })) {
      if (entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name)) {
        siteDirectories.push(join(environment, 'lib', entry.name, 'site-packages'));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return siteDirectories;
}

/** Every `.pth` file under the environment's site-packages, with its content. */
async function pthFilesOf(environment: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const directory of await sitePackagesOf(environment)) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.pth')) continue;
      const path = join(directory, entry.name);
      out.push({ path, content: await readFile(path, 'utf8') });
    }
  }
  return out;
}

/**
 * Whether `environment` (an absolute path to a virtualenv) carries a plain-path
 * editable install that resolves INTO `sourceProject`. Such an environment
 * cannot be shared by symlink: any interpreter using it imports the source
 * checkout's code, not the tree it runs in (AGT-4043). Non-environment paths
 * and environments without such a `.pth` answer `false`.
 */
export async function hasEditableInstallInto(sourceProject: string, environment: string): Promise<boolean> {
  if (!PYTHON_ENVIRONMENT_NAMES.includes(basename(environment))) return false;
  const roots = await sourceRootsOf(sourceProject);
  for (const { content } of await pthFilesOf(environment)) {
    for (const line of content.split('\n')) {
      const value = line.trim();
      if (!isAbsolute(value)) continue; // import statements and relative entries are not editable paths
      if (insideAnyRoot(value, roots)) return true;
    }
  }
  return false;
}

/** Relocate plain-path editable installs (including uv's .pth) to this snapshot. */
export async function rebasePythonEnvironment(
  sourceProject: string, sandboxProject: string, sharedPath: string,
): Promise<void> {
  if (!PYTHON_ENVIRONMENT_NAMES.includes(basename(sharedPath))) return;
  const sourceRoots = await sourceRootsOf(sourceProject);
  const environment = join(sandboxProject, sharedPath);
  for (const { path, content } of await pthFilesOf(environment)) {
    const rebased = content.split(/(?<=\n)/).map((line) => {
      const value = line.trim();
      if (!isAbsolute(value)) return line; // Never execute or rewrite import statements.
      const root = insideAnyRoot(value, sourceRoots);
      return root ? line.replace(value, join(sandboxProject, relative(root, value))) : line;
    }).join('');
    if (rebased !== content) await writeFile(path, rebased);
  }
}
