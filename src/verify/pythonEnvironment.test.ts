import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasEditableInstallInto, rebasePythonEnvironment } from './pythonEnvironment.js';

let root: string;
let repo: string;

async function venvWithPth(environment: string, lines: string[]): Promise<string> {
  const site = join(environment, 'lib', 'python3.12', 'site-packages');
  await mkdir(site, { recursive: true });
  const pth = join(site, '_editable_impl_pkg.pth');
  await writeFile(pth, `${lines.join('\n')}\n`);
  return pth;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-python-env-')));
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('hasEditableInstallInto (AGT-4043)', () => {
  it('is true for a .pth whose absolute entry points into the repo', async () => {
    const env = join(repo, 'apps', 'pipelines', '.venv');
    await venvWithPth(env, [join(repo, 'apps', 'pipelines', 'src')]);
    await expect(hasEditableInstallInto(repo, env)).resolves.toBe(true);
  });

  it('is false for an environment whose .pth points elsewhere or only imports', async () => {
    const env = join(repo, '.venv');
    await venvWithPth(env, ['import _virtualenv', '/opt/somewhere/else/src']);
    await expect(hasEditableInstallInto(repo, env)).resolves.toBe(false);
  });

  it('is false for an environment without any .pth and for non-environment paths', async () => {
    await mkdir(join(repo, 'venv', 'lib', 'python3.12', 'site-packages'), { recursive: true });
    await expect(hasEditableInstallInto(repo, join(repo, 'venv'))).resolves.toBe(false);
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await expect(hasEditableInstallInto(repo, join(repo, 'node_modules'))).resolves.toBe(false);
  });
});

describe('rebasePythonEnvironment', () => {
  it('rewrites repo-rooted .pth entries onto the sandbox and leaves the rest', async () => {
    const sandbox = join(root, 'sandbox');
    const pth = await venvWithPth(join(sandbox, 'apps', 'pipelines', '.venv'), [
      join(repo, 'apps', 'pipelines', 'src'), 'import _virtualenv', '/opt/elsewhere',
    ]);
    await rebasePythonEnvironment(repo, sandbox, 'apps/pipelines/.venv');
    await expect(readFile(pth, 'utf8')).resolves.toBe(
      `${join(sandbox, 'apps', 'pipelines', 'src')}\nimport _virtualenv\n/opt/elsewhere\n`,
    );
  });
});
