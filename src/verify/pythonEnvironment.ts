import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { linkedMainCheckoutOf } from '../security/gitWorktreeIdentity.js';

/** Relocate plain-path editable installs (including uv's .pth) to this snapshot. */
export async function rebasePythonEnvironment(
  sourceProject: string, sandboxProject: string, sharedPath: string,
): Promise<void> {
  if (!['.venv', '.venv-verify', 'venv'].includes(basename(sharedPath))) return;
  const sourceRoots = [resolve(sourceProject), await realpath(sourceProject), linkedMainCheckoutOf(sourceProject)]
    .filter((root): root is string => root !== null)
    .sort((a, b) => b.length - a.length);
  const environment = join(sandboxProject, sharedPath);
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
  for (const directory of siteDirectories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.pth')) continue;
      const path = join(directory, entry.name);
      const content = await readFile(path, 'utf8');
      const rebased = content.split(/(?<=\n)/).map((line) => {
        const value = line.trim();
        if (!isAbsolute(value)) return line; // Never execute or rewrite import statements.
        for (const root of sourceRoots) {
          const suffix = relative(root, value);
          if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
            return line.replace(value, join(sandboxProject, suffix));
          }
        }
        return line;
      }).join('');
      if (rebased !== content) await writeFile(path, rebased);
    }
  }
}
