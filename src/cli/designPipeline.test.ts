import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzePackageJson, detectStack, generateWorkflow, runDesignPipeline } from './designPipeline.js';

describe('analyzePackageJson (INT-1956)', () => {
  it('picks existing lint/build/test scripts and the package manager', () => {
    const s = analyzePackageJson({ scripts: { test: 'vitest', build: 'tsc', start: 'node x' } }, ['pnpm-lock.yaml']);
    expect(s).toEqual({ ecosystem: 'node', packageManager: 'pnpm', steps: ['build', 'test'] });
  });
  it('defaults to npm when no known lockfile', () => {
    expect(analyzePackageJson({ scripts: { test: 'x' } }).packageManager).toBe('npm');
  });
});

describe('detectStack (INT-1956)', () => {
  it('detects node, python, rust, go, generic', () => {
    expect(detectStack(['package.json'], () => ({ scripts: { test: 't' } })).ecosystem).toBe('node');
    expect(detectStack(['pyproject.toml']).ecosystem).toBe('python');
    expect(detectStack(['Cargo.toml']).ecosystem).toBe('rust');
    expect(detectStack(['go.mod']).ecosystem).toBe('go');
    expect(detectStack(['README.md']).ecosystem).toBe('generic');
  });
});

describe('generateWorkflow (INT-1956)', () => {
  it('emits node steps with the right package manager and scripts', () => {
    const y = generateWorkflow({ ecosystem: 'node', packageManager: 'pnpm', steps: ['lint', 'test'] });
    expect(y).toContain('actions/setup-node@v4');
    expect(y).toContain('pnpm install --frozen-lockfile');
    expect(y).toContain('pnpm lint');
    expect(y).toContain('pnpm test');
  });
  it('emits python / rust / go templates', () => {
    expect(generateWorkflow({ ecosystem: 'python', steps: ['test'] })).toContain('pytest');
    expect(generateWorkflow({ ecosystem: 'rust', steps: [] })).toContain('cargo test');
    expect(generateWorkflow({ ecosystem: 'go', steps: [] })).toContain('go test ./...');
  });
});

describe('runDesignPipeline (INT-1956)', () => {
  it('dry-run returns yaml without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      const r = runDesignPipeline({ path: dir, dryRun: true });
      expect(r.wrote).toBe(false);
      expect(r.yaml).toContain('npm run test');
      expect(existsSync(join(dir, '.github', 'workflows', 'ci.yml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes ci.yml and refuses to overwrite without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module x\n');
      const r = runDesignPipeline({ path: dir });
      expect(r.wrote).toBe(true);
      expect(readFileSync(r.path, 'utf8')).toContain('go test ./...');
      expect(() => runDesignPipeline({ path: dir })).toThrow(/already exists/);
      expect(runDesignPipeline({ path: dir, force: true }).wrote).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write through a symlinked ci.yml with --force (AGT-3424)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'dp-outside-'));
    const outsideFile = join(outsideDir, 'sensitive.yml');
    writeFileSync(outsideFile, 'do-not-touch\n');
    try {
      writeFileSync(join(dir, 'go.mod'), 'module x\n');
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      const outPath = join(dir, '.github', 'workflows', 'ci.yml');
      symlinkSync(outsideFile, outPath);

      const r = runDesignPipeline({ path: dir, force: true });

      expect(r.wrote).toBe(true);
      // The outside file's content must be untouched — the symlink itself
      // was replaced by a fresh regular file, not written through.
      expect(readFileSync(outsideFile, 'utf8')).toBe('do-not-touch\n');
      expect(readFileSync(outPath, 'utf8')).toContain('go test ./...');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
