import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeTestParallelism, effectiveTestParallelism, resourceAwareTestCommand, testResourceShellPrefix, withTestResourceBudget } from './testResourceBudget.js';

describe('test resource budget', () => {
  it('allows bounded parallelism on an idle capable host', () => {
    expect(computeTestParallelism({ logicalCpus: 12, load1: 0.5, freeMemoryBytes: 32 * 1024 ** 3 })).toBe(4);
  });

  it('falls back to one worker when CPU or memory is pressured', () => {
    expect(computeTestParallelism({ logicalCpus: 10, load1: 12, freeMemoryBytes: 16 * 1024 ** 3 })).toBe(1);
    expect(computeTestParallelism({ logicalCpus: 10, load1: 0, freeMemoryBytes: 0.5 * 1024 ** 3 })).toBe(1);
  });

  it('treats the operator setting as a ceiling on the host budget', () => {
    const idle = { logicalCpus: 12, load1: 0, freeMemoryBytes: 32 * 1024 ** 3 };
    expect(effectiveTestParallelism(idle, { OPENSWARM_TEST_PARALLELISM: '2' })).toBe(2);
    expect(effectiveTestParallelism(idle, { OPENSWARM_TEST_PARALLELISM: '99' })).toBe(4);
  });

  it('exports runtime caps without raising a stricter operator limit', () => {
    const env = withTestResourceBudget(
      { CARGO_BUILD_JOBS: '1', PYTEST_XDIST_AUTO_NUM_WORKERS: '99', OPENSWARM_TEST_PARALLELISM: '2' },
      { logicalCpus: 8, load1: 3, freeMemoryBytes: 8 * 1024 ** 3 },
    );
    expect(env.OPENSWARM_TEST_PARALLELISM).toBe('2');
    expect(env.PYTEST_XDIST_AUTO_NUM_WORKERS).toBe('2');
    expect(env.CARGO_BUILD_JOBS).toBe('1');
    expect(env.RAYON_NUM_THREADS).toBe('2');
  });

  it('builds a numeric-only export prefix for sandbox executors', () => {
    const prefix = testResourceShellPrefix({ logicalCpus: 10, load1: 20, freeMemoryBytes: 16 * 1024 ** 3 });
    expect(prefix).toContain('OPENSWARM_TEST_PARALLELISM=1');
    expect(prefix).toContain('PYTEST_XDIST_AUTO_NUM_WORKERS=1');
    expect(prefix).toMatch(/^export [A-Z0-9_= ]+;$/);
  });

  it('caps the actual Vitest worker count behind npm test', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'openswarm-test-budget-'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const bounded = await resourceAwareTestCommand(
      'npm test', cwd, { logicalCpus: 10, load1: 20, freeMemoryBytes: 16 * 1024 ** 3 },
    );
    expect(bounded).toBe('npm test -- --maxWorkers=1');
  });

  it('does not inject flags into an unrelated npm test script', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'openswarm-test-budget-'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    expect(await resourceAwareTestCommand('npm test', cwd)).toBe('npm test');
    expect(await resourceAwareTestCommand('node tool.js --maxWorkers=99', cwd))
      .toBe('node tool.js --maxWorkers=99');
  });

  it('preserves an explicit Vitest worker cap', async () => {
    expect(await resourceAwareTestCommand('vitest run --maxWorkers=1', '/tmp')).toBe('vitest run --maxWorkers=1');
  });

  it('clamps explicit direct and npm worker counts to the host budget', async () => {
    const pressured = { logicalCpus: 10, load1: 20, freeMemoryBytes: 16 * 1024 ** 3 };
    const cwd = await mkdtemp(path.join(tmpdir(), 'openswarm-test-budget-'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(await resourceAwareTestCommand('vitest run --maxWorkers=99', '/tmp', pressured))
      .toBe('vitest run --maxWorkers=1');
    expect(await resourceAwareTestCommand('npm test -- --maxWorkers 99', cwd, pressured))
      .toBe('npm test -- --maxWorkers 1');
    expect(await resourceAwareTestCommand('jest --maxWorkers=50%', '/tmp', pressured))
      .toBe('jest --maxWorkers=1');
  });

  it('caps the test subcommand inside a shell sequence using its changed directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openswarm-test-budget-'));
    const app = path.join(root, 'app');
    await mkdir(app);
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const pressured = { logicalCpus: 10, load1: 20, freeMemoryBytes: 16 * 1024 ** 3 };
    expect(await resourceAwareTestCommand('cd app && npm test && echo done', root, pressured))
      .toBe('cd app && npm test -- --maxWorkers=1 && echo done');
  });

  it('preserves Jest serial mode instead of adding a conflicting worker cap', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'openswarm-test-budget-'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'jest --runInBand' } }));
    expect(await resourceAwareTestCommand('npm test', cwd)).toBe('npm test');
    expect(await resourceAwareTestCommand('jest --runInBand', cwd)).toBe('jest --runInBand');
  });
});
