import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
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

/**
 * The interpreter a command run from `subdir` should use: the subproject's own
 * virtualenv first, else the repository's (reached by a relative path, so the
 * command stays valid inside the companion sandbox), else PATH.
 */
async function pythonCommand(projectPath: string, subdir = ''): Promise<string> {
  const candidates = process.platform === 'win32'
    ? ['.venv-verify/Scripts/python.exe', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.venv-verify/bin/python', '.venv/bin/python', 'venv/bin/python'];
  return (await toolFromVenv(projectPath, subdir, candidates)) ?? 'python';
}

/**
 * Whether the interpreter `pythonCommand` chose can actually run pytest. A
 * virtualenv without pytest makes BOTH the base and the head run fail with
 * the same ModuleNotFoundError, which the runner rightly reads as a
 * pre-existing environment failure — and the tester then passes without a
 * single test having run. cgf-portal's root `.venv` holds only an
 * interpreter (its packages live in apps/pipelines/.venv), so the monorepo
 * command from #534 would have gone green that way. Unknown for a PATH
 * interpreter, which keeps the root behaviour unchanged.
 */
async function interpreterHasPytest(projectPath: string, subdir: string, python: string): Promise<boolean> {
  if (!python.startsWith('.')) return true;
  const bin = dirname(join(projectPath, subdir, python));
  return exists(join(bin, process.platform === 'win32' ? 'pytest.exe' : 'pytest'))
    || exists(join(bin, process.platform === 'win32' ? 'py.test.exe' : 'py.test'));
}

async function toolFromVenv(projectPath: string, subdir: string, candidates: string[]): Promise<string | undefined> {
  for (const base of subdir ? [subdir, ''] : ['']) {
    for (const candidate of candidates) {
      if (await exists(join(projectPath, base, candidate))) {
        const fromCwd = relative(join(projectPath, subdir), join(projectPath, base, candidate)).split(sep).join('/');
        return fromCwd.startsWith('../') ? fromCwd : `./${fromCwd}`;
      }
    }
  }
  return undefined;
}

async function ruffCommand(projectPath: string, subdir = ''): Promise<string | undefined> {
  const candidates = process.platform === 'win32'
    ? ['.venv-verify/Scripts/ruff.exe', '.venv/Scripts/ruff.exe', 'venv/Scripts/ruff.exe']
    : ['.venv-verify/bin/ruff', '.venv/bin/ruff', 'venv/bin/ruff'];
  return toolFromVenv(projectPath, subdir, candidates);
}

/** pytest (and a repository-installed ruff) for one Python project at `subdir` ('' = repository root). */
async function discoverPythonCommands(projectPath: string, subdir: string): Promise<VerifyCommand[]> {
  const dir = join(projectPath, subdir);
  const commands: VerifyCommand[] = [];
  const label = subdir ? `:${subdir.split(sep).join('/')}` : '';
  const cwd = subdir ? { cwd: subdir.split(sep).join('/') } : {};

  // Python: require an explicit pytest configuration signal.
  const pytestIni = await exists(join(dir, 'pytest.ini'));
  const pyproject = await readText(join(dir, 'pyproject.toml'));
  const setupCfg = await readText(join(dir, 'setup.cfg'));
  if (pytestIni || pyproject?.includes('[tool.pytest.ini_options]') || setupCfg?.includes('[tool:pytest]')) {
    // Baseline comparison uses -x. If a repository's config enables xdist,
    // parallel scheduling can make base and HEAD stop at different *existing*
    // failures and turn deterministic verification into a false regression.
    // Override only an explicitly configured xdist worker count; generic pytest
    // environments that do not install xdist must not receive an unknown -n flag.
    const pytestConfig = [
      pytestIni ? await readText(join(dir, 'pytest.ini')) : null,
      pyproject,
      setupCfg,
    ].filter((value): value is string => value !== null).join('\n');
    const serialXdist = /(?:^|\s)-n(?:\s|=)/m.test(pytestConfig) ? ' -n 0' : '';
    const python = await pythonCommand(projectPath, subdir);
    if (!subdir || await interpreterHasPytest(projectPath, subdir, python)) {
      commands.push({ ...command(`pytest${label}`, `${python} -m pytest${serialXdist} -x -q`, 'test'), ...cwd });
    }
  }

  // Python lint: only a repository-installed ruff, so an unknown tool is never
  // introduced and the repository's own ruff config (or ruff's default rule
  // set, which includes pyflakes F-rules) applies. vega-agent#608 shipped an
  // undefined name (F821) and 63 pyflakes errors past a green pytest run;
  // the repository's CI runs `ruff check` and rejected it on arrival.
  // Only alongside a pytest project: a bare virtualenv with ruff in it (a
  // monorepo root, say) is not a Python project of its own.
  if (commands.length === 0) return commands;
  const ruff = await ruffCommand(projectPath, subdir);
  if (ruff) commands.push({ ...command(`ruff${label}`, `${ruff} check .`, 'lint'), ...cwd });
  return commands;
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

  const python = await discoverPythonCommands(projectPath, '');
  commands.push(...python);

  // A monorepo keeps its Python packages one level down (cgf-portal:
  // apps/pipelines/pyproject.toml, nothing at the root). Root-only discovery
  // found nothing there, so the deterministic tester never ran and every one
  // of its 113 attempts on 2026-09-02 fell back to the LLM tester — a six
  // minute timeout at worst, no pytest at best. Look one level into the
  // conventional workspace directories when the root itself is silent.
  if (python.length === 0) {
    for (const parent of ['apps', 'packages', 'services', 'libs']) {
      let entries: string[];
      try {
        entries = (await readdir(join(projectPath, parent), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of entries) {
        commands.push(...await discoverPythonCommands(projectPath, join(parent, name)));
      }
    }
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
