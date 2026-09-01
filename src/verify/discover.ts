import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerifyCommand } from './manifest.js';

const DEFAULT_TIMEOUT_MS = 300_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Cannot access verification input ${path}`, { cause: error });
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read verification input ${path}`, { cause: error });
  }
}

async function pythonCommand(projectPath: string): Promise<string> {
  const candidates = process.platform === 'win32'
    ? ['.venv-verify/Scripts/python.exe', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.venv-verify/bin/python', '.venv/bin/python', 'venv/bin/python'];
  for (const candidate of candidates) {
    if (await exists(join(projectPath, candidate))) return `./${candidate}`;
  }
  return 'python';
}

function command(name: string, run: string, kind: VerifyCommand['kind']): VerifyCommand {
  return { name, run, kind, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export async function discoverVerifyCommands(projectPath: string): Promise<VerifyCommand[]> {
  const commands: VerifyCommand[] = [];

  // Node/TypeScript: prefer repository scripts, then a repository-installed tsc.
  const packageSource = await readText(join(projectPath, 'package.json'));
  let scripts: Record<string, unknown> = {};
  if (packageSource) {
    try {
      const parsed = JSON.parse(packageSource) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
        scripts = parsed.scripts as Record<string, unknown>;
      }
    } catch (error) {
      throw new Error(`Invalid package.json in ${projectPath}`, { cause: error });
    }
  }
  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
    commands.push(command('typecheck', 'npm run typecheck', 'typecheck'));
  } else if (
    await exists(join(projectPath, 'tsconfig.json'))
    && await exists(join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'))
  ) {
    const localTsc = process.platform === 'win32' ? './node_modules/.bin/tsc.cmd' : './node_modules/.bin/tsc';
    commands.push(command('typecheck', `${localTsc} --noEmit`, 'typecheck'));
  }
  if (
    typeof scripts.test === 'string'
    && scripts.test.trim()
    && !scripts.test.includes('Error: no test specified')
  ) {
    commands.push(command('test', 'npm run test', 'test'));
  }

  // Python: require an explicit pytest configuration signal.
  const pytestIni = await exists(join(projectPath, 'pytest.ini'));
  const pyproject = await readText(join(projectPath, 'pyproject.toml'));
  const setupCfg = await readText(join(projectPath, 'setup.cfg'));
  if (pytestIni || pyproject?.includes('[tool.pytest.ini_options]') || setupCfg?.includes('[tool:pytest]')) {
    // Baseline comparison uses -x. If a repository's config enables xdist,
    // parallel scheduling can make base and HEAD stop at different *existing*
    // failures and turn deterministic verification into a false regression.
    // Override only an explicitly configured xdist worker count; generic pytest
    // environments that do not install xdist must not receive an unknown -n flag.
    const pytestConfig = [
      pytestIni ? await readText(join(projectPath, 'pytest.ini')) : null,
      pyproject,
      setupCfg,
    ].filter((value): value is string => value !== null).join('\n');
    const serialXdist = /(?:^|\s)-n(?:\s|=)/m.test(pytestConfig) ? ' -n 0' : '';
    commands.push(command('pytest', `${await pythonCommand(projectPath)} -m pytest${serialXdist} -x -q`, 'test'));
  }

  // Rust repositories use Cargo's native test runner.
  if (await exists(join(projectPath, 'Cargo.toml'))) {
    commands.push(command('cargo test', 'cargo test --quiet', 'test'));
  }

  // Go repositories verify every package below the module root.
  if (await exists(join(projectPath, 'go.mod'))) {
    commands.push(command('go test', 'go test ./...', 'test'));
  }

  return commands;
}
