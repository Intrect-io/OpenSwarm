import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (path === '/usr/bin/sandbox-exec') return false;
      return actual.existsSync(path);
    },
  };
});

describe('macOS sandbox-exec fail-closed (AGT-3447)', () => {
  let root: string;
  let repo: string;
  let platformSpy: { mockRestore: () => void } | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-darwin-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    await writeFile(join(repo, 'README.md'), 'base\n', 'utf8');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'pipe' });
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  });

  afterEach(async () => {
    platformSpy?.mockRestore();
    await rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it('refuses verification when sandbox-exec is missing on darwin', async () => {
    const { runVerify } = await import('./runner.js');
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ name: 'fixture', run: 'printf should-not-run', kind: 'test', timeoutMs: 2_000 }],
      baseRef: 'HEAD',
    });
    expect(evidence.headStatus).toBe('fail');
    expect(evidence.rawOutputTail).toContain(
      'macOS sandbox-exec is not available on this host; refusing to run verification unsandboxed',
    );
    expect(evidence.rawOutputTail).not.toContain('should-not-run');
  });
});
