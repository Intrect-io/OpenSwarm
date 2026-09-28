// CLI smoke for `openswarm review --max --harness-only` (AGT-3619 / M0).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = join(repoRoot, 'src/cli.ts');

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-harness-cli-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'harness@example.test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Harness'], { cwd: root, stdio: 'ignore' });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('review --max --harness-only CLI smoke', () => {
  it('runs the quality harness without LLM reviewers and writes a markdown report', async () => {
    const root = await gitRepo({
      'src/ok.ts': 'export const value = 1;\n',
      'package.json': JSON.stringify({ name: 'fixture', private: true }),
    });
    const out = join(root, 'audit-report.md');
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', cliEntry, 'review', '--max', '--harness-only', '--yes', '--no-linear', '--path', root, '--out', out],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_COLOR: '1',
          OPENSWARM_DISABLE_TELEMETRY: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
    expect(stdout).toMatch(/Quality harness/i);
    expect(stdout).toMatch(/Verdict:\s*APPROVE/i);
    const report = await readFile(out, 'utf8');
    expect(report).toContain('.openswarm/quality-harness');
    expect(report).toContain('Verdict: APPROVE');
  }, 120_000);

  it('fails closed when a tracked source file cannot be fully scanned', async () => {
    const root = await gitRepo({
      'src/huge.ts': 'x'.repeat(512 * 1024 + 32),
    });
    const out = join(root, 'audit-report.md');
    let code = 0;
    let combined = '';
    try {
      combined = execFileSync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'review', '--max', '--harness-only', '--yes', '--no-linear', '--path', root, '--out', out],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            NO_COLOR: '1',
            OPENSWARM_DISABLE_TELEMETRY: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      code = failure.status ?? 1;
      combined = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    }
    expect(code).toBe(1);
    expect(combined).toMatch(/quality-truncated|Verdict:\s*REJECT/i);
    const report = await readFile(out, 'utf8');
    expect(report).toContain('openswarm/quality-truncated');
    expect(report).toContain('Verdict: REJECT');
  }, 120_000);
});
