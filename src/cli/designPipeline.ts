// ============================================
// OpenSwarm - `openswarm design-pipeline` (INT-1956)
// ============================================
//
// Analyze a project and generate a CI workflow (.github/workflows/ci.yml).
// Detection + YAML generation are pure (unit-tested); runDesignPipeline is the
// fs shell. Node is fully supported; Python/Rust/Go are recognized and emit a
// sensible setup+test template.

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Ecosystem = 'node' | 'python' | 'rust' | 'go' | 'generic';

export interface ProjectStack {
  ecosystem: Ecosystem;
  /** npm | pnpm | yarn (node only) */
  packageManager?: 'npm' | 'pnpm' | 'yarn';
  /** package.json scripts that exist, in run order. */
  steps: Array<'lint' | 'build' | 'test'>;
}

/** Pure: derive a Node stack from a parsed package.json. */
export function analyzePackageJson(pkg: { scripts?: Record<string, string> }, lockfiles: string[] = []): ProjectStack {
  const scripts = pkg.scripts ?? {};
  const steps = (['lint', 'build', 'test'] as const).filter((s) => typeof scripts[s] === 'string' && scripts[s]);
  const packageManager = lockfiles.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : lockfiles.includes('yarn.lock')
      ? 'yarn'
      : 'npm';
  return { ecosystem: 'node', packageManager, steps };
}

/** Pure: detect stack from file listing. */
export function detectStack(files: string[], readPkg?: () => { scripts?: Record<string, string> }): ProjectStack {
  const has = (s: string) => files.some((f) => f === s || f.startsWith(s + '/'));

  if (has('package.json')) {
    const pkg = readPkg?.() ?? {};
    const lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].filter((f) => has(f));
    return analyzePackageJson(pkg, lockfiles);
  }
  if (has('Cargo.toml')) return { ecosystem: 'rust', steps: ['build', 'test'] };
  if (has('go.mod')) return { ecosystem: 'go', steps: ['build', 'test'] };
  if (has('setup.py') || has('pyproject.toml') || has('requirements.txt')) return { ecosystem: 'python', steps: ['test'] };
  return { ecosystem: 'generic', steps: [] };
}

/** Pure: generate a GitHub Actions workflow YAML string. */
export function generateWorkflow(stack: ProjectStack): string {
  const { ecosystem, packageManager, steps } = stack;

  const setup: string[] = [];
  const run: string[] = [];

  if (ecosystem === 'node') {
    const pm = packageManager ?? 'npm';
    const installCmd = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'npm ci';
    setup.push(`      - uses: actions/setup-node@v4
        with:
          node-version: lts/*`);
    if (pm !== 'npm') {
      setup.push(`      - run: corepack enable && corepack prepare ${pm}@latest --activate`);
    }
    setup.push(`      - run: ${installCmd}`);
    for (const step of steps) {
      run.push(`      - run: ${pm} run ${step}`);
    }
  } else if (ecosystem === 'python') {
    setup.push(`      - uses: actions/setup-python@v5
        with:
          python-version: '3.x'
      - run: pip install -e ".[dev,test]" 2>/dev/null || pip install -r requirements.txt 2>/dev/null || true`);
    if (steps.includes('test')) run.push('      - run: python -m pytest');
  } else if (ecosystem === 'rust') {
    setup.push(`      - run: rustup show`);
    if (steps.includes('build')) run.push('      - run: cargo build --locked');
    if (steps.includes('test')) run.push('      - run: cargo test --locked');
  } else if (ecosystem === 'go') {
    setup.push(`      - uses: actions/setup-go@v5
        with:
          go-version: stable`);
    if (steps.includes('build')) run.push('      - run: go build ./...');
    if (steps.includes('test')) run.push('      - run: go test ./...');
  } else {
    run.push('      - run: echo "No CI workflow configured for this project"');
  }

  return `name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup.join('\n')}
${run.join('\n')}
`;
}

export interface DesignPipelineOptions {
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
}

/**
 * Analyze the project at cwd and write .github/workflows/ci.yml.
 * Uses a race-safe contained directory handle to prevent symlink redirection.
 */
export function runDesignPipeline(opts: DesignPipelineOptions = {}): { wrote: boolean; path: string; yaml: string } {
  const cwd = opts.cwd ?? process.cwd();
  const files = readdirSync(cwd);
  const stack = detectStack(files, () => {
    try {
      return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    } catch {
      return {};
    }
  });
  const yaml = generateWorkflow(stack);
  const outPath = join(cwd, '.github', 'workflows', 'ci.yml');

  if (opts.dryRun) return { wrote: false, path: outPath, yaml };
  mkdirSync(dirname(outPath), { recursive: true });

  // Resolve the target directory to a real path to prevent symlink redirection.
  const resolvedDir = realpathSync(dirname(outPath));
  if (!resolvedDir.startsWith(realpathSync(cwd) + '/')) {
    throw new Error(`Refusing to write outside project root: ${resolvedDir}`);
  }

  if (opts.force) {
    let fd: number | undefined;
    try {
      fd = openSync(outPath, 'w', 0o644);
      writeFileSync(fd, yaml);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } else {
    let fd: number | undefined;
    try {
      fd = openSync(outPath, 'wx', 0o644);
      writeFileSync(fd, yaml);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${outPath} already exists — pass --force to overwrite`);
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { wrote: true, path: outPath, yaml };
}