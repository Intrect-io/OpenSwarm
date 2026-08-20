// ============================================
// OpenSwarm - `openswarm design-pipeline` (INT-1956)
// ============================================
//
// Analyze a project and generate a CI workflow (.github/workflows/ci.yml).
// Detection + YAML generation are pure (unit-tested); runDesignPipeline is the
// fs shell. Node is fully supported; Python/Rust/Go are recognized and emit a
// sensible setup+test template.

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
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
  return { ecosystem: 'node', packageManager, steps: [...steps] };
}

/** Pure: detect the stack from a directory listing + optional package.json reader. */
export function detectStack(files: string[], readPkg?: () => { scripts?: Record<string, string> } | null): ProjectStack {
  if (files.includes('package.json')) {
    const pkg = readPkg?.() ?? null;
    return analyzePackageJson(pkg ?? {}, files);
  }
  if (files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('requirements.txt')) {
    return { ecosystem: 'python', steps: ['test'] };
  }
  if (files.includes('Cargo.toml')) return { ecosystem: 'rust', steps: ['build', 'test'] };
  if (files.includes('go.mod')) return { ecosystem: 'go', steps: ['build', 'test'] };
  return { ecosystem: 'generic', steps: [] };
}

const NODE_INSTALL: Record<NonNullable<ProjectStack['packageManager']>, string> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
};

function nodeRun(pm: NonNullable<ProjectStack['packageManager']>, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

/** Pure: render a GitHub Actions workflow for the detected stack. */
export function generateWorkflow(stack: ProjectStack): string {
  const head = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ];

  const steps: string[] = [];
  if (stack.ecosystem === 'node') {
    const pm = stack.packageManager ?? 'npm';
    steps.push('      - uses: actions/setup-node@v4', '        with:', "          node-version: '22'");
    steps.push(`      - run: ${NODE_INSTALL[pm]}`);
    for (const s of stack.steps) steps.push(`      - run: ${nodeRun(pm, s)}`);
    if (!stack.steps.length) steps.push('      # no lint/build/test scripts detected — add them to package.json');
  } else if (stack.ecosystem === 'python') {
    steps.push('      - uses: actions/setup-python@v5', '        with:', "          python-version: '3.12'");
    steps.push('      - run: pip install -e . || pip install -r requirements.txt', '      - run: pytest');
  } else if (stack.ecosystem === 'rust') {
    steps.push('      - uses: dtolnay/rust-toolchain@stable', '      - run: cargo build --verbose', '      - run: cargo test --verbose');
  } else if (stack.ecosystem === 'go') {
    steps.push('      - uses: actions/setup-go@v5', '        with:', "          go-version: '1.22'");
    steps.push('      - run: go build ./...', '      - run: go test ./...');
  } else {
    steps.push('      # generic project — add your build/test steps here');
  }

  return `${[...head, ...steps].join('\n')}\n`;
}

export interface DesignPipelineOptions {
  path?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** fs shell: detect → generate → write .github/workflows/ci.yml (or print on --dry-run). */
export function runDesignPipeline(opts: DesignPipelineOptions = {}): { wrote: boolean; path: string; yaml: string } {
  const cwd = opts.path ?? process.cwd();
  const files = readdirSync(cwd);
  const stack = detectStack(files, () => {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  });
  const yaml = generateWorkflow(stack);
  const outPath = join(cwd, '.github', 'workflows', 'ci.yml');

  if (opts.dryRun) return { wrote: false, path: outPath, yaml };
  mkdirSync(dirname(outPath), { recursive: true });
  if (opts.force) {
    writeFileSync(outPath, yaml);
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
