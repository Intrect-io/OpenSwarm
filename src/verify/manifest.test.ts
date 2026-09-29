import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVerifyManifest } from './manifest.js';

const roots: string[] = [];

async function projectWithManifest(source?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-manifest-'));
  roots.push(root);
  if (source !== undefined) {
    await mkdir(join(root, '.openswarm'), { recursive: true });
    await writeFile(join(root, '.openswarm', 'verify.yaml'), source, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loadVerifyManifest', () => {
  it('loads a valid manifest and applies the default timeout', async () => {
    const project = await projectWithManifest(`
version: 1
commands:
  - name: typecheck
    run: npm run typecheck
    kind: typecheck
`);

    await expect(loadVerifyManifest(project)).resolves.toEqual({
      manifest: {
        version: 1,
        commands: [{ name: 'typecheck', run: 'npm run typecheck', kind: 'typecheck', timeoutMs: 300_000 }],
      },
    });
  });

  it('preserves an explicit timeout and relative cwd', async () => {
    const project = await projectWithManifest(`
version: 1
commands:
  - name: unit tests
    run: pytest -q
    kind: test
    timeoutMs: 600000
    cwd: backend
`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest?.commands[0]).toMatchObject({ timeoutMs: 600_000, cwd: 'backend' });
  });

  it('treats a missing manifest as a normal absence', async () => {
    const project = await projectWithManifest();
    await expect(loadVerifyManifest(project)).resolves.toEqual({ manifest: null });
  });

  it('reports malformed YAML instead of swallowing it', async () => {
    const project = await projectWithManifest('version: 1\ncommands: [\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Failed to parse .openswarm/verify.yaml');
  });

  it('rejects an oversized manifest before YAML parsing', async () => {
    const project = await projectWithManifest(`version: 1\ncommands:\n${' '.repeat(70 * 1024)}`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('manifest exceeds 65536 bytes');
  });

  it('rejects a symlinked manifest instead of following special or external files', async () => {
    const project = await projectWithManifest();
    const outside = join(project, 'outside.yaml');
    await writeFile(outside, 'version: 1\ncommands: []\n');
    await mkdir(join(project, '.openswarm'), { recursive: true });
    await symlink(outside, join(project, '.openswarm', 'verify.yaml'));
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Failed to read');
  });

  it('reports an unsupported command kind', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: deploy\n    run: ./deploy\n    kind: deploy\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('commands.0.kind');
  });

  it('rejects an empty commands list', async () => {
    const project = await projectWithManifest('version: 1\ncommands: []\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('At least one verify command is required');
  });

  it('rejects a timeout above 15 minutes', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: build\n    run: npm run build\n    kind: build\n    timeoutMs: 900001\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('commands.0.timeoutMs');
  });

  it('rejects multiline shell commands', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: |\n      npm test\n      npm run lint\n    kind: test\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Command must be a single line');
  });

  it('rejects NUL bytes before passing a command to spawn', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: "npm test\\0"\n    kind: test\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('must not contain NUL bytes');
  });

  it('rejects a cwd that escapes the repository', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: npm test\n    kind: test\n    cwd: ../outside\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('cwd must stay within the repository');
  });

  it('rejects NUL bytes in cwd before filesystem calls', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: npm test\n    kind: test\n    cwd: "subdir\\0"\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('cwd must not contain NUL bytes');
  });

  it('rejects a manifest with more commands than the cap', async () => {
    // 64 KiB of YAML holds several hundred commands. Each is cheap to write and
    // one more subprocess to run, so the count needs its own ceiling.
    const commands = Array.from({ length: 21 }, (_, index) => [
      `  - name: step-${index}`, `    run: npm run step-${index}`, '    kind: test', '    timeoutMs: 1000',
    ].join('\n'));
    const project = await projectWithManifest(`version: 1\ncommands:\n${commands.join('\n')}\n`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('At most 20 verify commands are allowed');
  });

  it('accepts a manifest exactly at the command cap', async () => {
    // The cap must not be off by one: 20 short commands are a legitimate plan.
    const commands = Array.from({ length: 20 }, (_, index) => [
      `  - name: step-${index}`, `    run: npm run step-${index}`, '    kind: test', '    timeoutMs: 1000',
    ].join('\n'));
    const project = await projectWithManifest(`version: 1\ncommands:\n${commands.join('\n')}\n`);
    const result = await loadVerifyManifest(project);
    expect(result.error).toBeUndefined();
    expect(result.manifest?.commands).toHaveLength(20);
  });

  it('rejects a manifest whose commands add up past the aggregate runtime budget', async () => {
    // Nine 15-minute commands are each legal alone and 2¼ hours together. An
    // aggregate ceiling is what actually bounds the run: runVerify also runs
    // every failure at the merge base, so the real cost is double.
    const commands = Array.from({ length: 9 }, (_, index) => [
      `  - name: step-${index}`, `    run: npm test -- --shard=${index}`, '    kind: test', '    timeoutMs: 900000',
    ].join('\n'));
    const project = await projectWithManifest(`version: 1\ncommands:\n${commands.join('\n')}\n`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Total command timeout must not exceed 7200000 ms');
  });

  it('accepts an aggregate that lands exactly on the budget', async () => {
    const commands = Array.from({ length: 8 }, (_, index) => [
      `  - name: step-${index}`, `    run: npm test -- --shard=${index}`, '    kind: test', '    timeoutMs: 900000',
    ].join('\n'));
    const project = await projectWithManifest(`version: 1\ncommands:\n${commands.join('\n')}\n`);
    const result = await loadVerifyManifest(project);
    expect(result.error).toBeUndefined();
    expect(result.manifest?.commands).toHaveLength(8);
  });
});
