import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runQualityHarness,
  scanStaticQuality,
  selectQualitySourceFiles,
  type QualityCommandResult,
} from './qualityHarness.js';

const roots: string[] = [];

async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-quality-harness-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('selectQualitySourceFiles', () => {
  it('keeps tracked source and drops junk / non-source paths', () => {
    expect(selectQualitySourceFiles([
      'src/a.ts',
      'src/a.ts',
      'README.md',
      'node_modules/x.js',
      'dist/out.js',
      'pkg/main.py',
    ])).toEqual(['pkg/main.py', 'src/a.ts']);
  });
});

describe('scanStaticQuality', () => {
  it('scans every listed file and surfaces critical BS as error findings', async () => {
    const root = await fixture({
      'src/clean.ts': 'export const ok = 1;\n',
      'src/bad.ts': 'try { doWork(); } catch {\n}\n',
    });
    const { findings, filesScanned } = await scanStaticQuality(root, ['src/clean.ts', 'src/bad.ts']);
    expect(filesScanned).toBe(2);
    expect(findings.some((f) => f.ruleId === 'openswarm/quality-bs/exception_hiding' && f.filePath === 'src/bad.ts')).toBe(true);
  });

  it('fails closed on oversize (truncation) rather than skipping the file', async () => {
    const root = await fixture({
      'src/huge.ts': Buffer.alloc(512 * 1024 + 8, 0x61),
    });
    const { findings, filesScanned } = await scanStaticQuality(root, ['src/huge.ts']);
    expect(filesScanned).toBe(0);
    expect(findings).toEqual([expect.objectContaining({
      ruleId: 'openswarm/quality-truncated',
      level: 'error',
      filePath: 'src/huge.ts',
    })]);
  });

  it('fails closed on scope escape and unreadable paths', async () => {
    const root = await fixture({ 'src/ok.ts': 'export {};\n' });
    const escaped = await scanStaticQuality(root, ['../outside.ts']);
    expect(escaped.findings.some((f) => f.ruleId === 'openswarm/quality-scope')).toBe(true);

    const missing = await scanStaticQuality(root, ['src/missing.ts']);
    expect(missing.findings.some((f) => f.ruleId === 'openswarm/quality-read' && f.filePath === 'src/missing.ts')).toBe(true);
  });

  it('refuses symlinked source as a non-regular read failure', async () => {
    const root = await fixture({ 'src/real.ts': 'export {};\n' });
    await symlink(join(root, 'src/real.ts'), join(root, 'src/link.ts'));
    const { findings } = await scanStaticQuality(root, ['src/link.ts']);
    expect(findings.some((f) => f.ruleId === 'openswarm/quality-read' && f.filePath === 'src/link.ts')).toBe(true);
  });
});

describe('runQualityHarness', () => {
  it('combines static findings with isolated command results', async () => {
    const root = await fixture({
      'src/a.ts': 'export const x = 1;\n',
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    });
    const executeCommands = async (): Promise<QualityCommandResult[]> => ([
      { name: 'typecheck', kind: 'typecheck', status: 'fail', detail: 'error TS2304' },
      { name: 'test', kind: 'test', status: 'pass', detail: 'ok' },
    ]);
    const result = await runQualityHarness(root, {
      sourceFiles: ['src/a.ts'],
      staticOnly: false,
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
      executeCommands,
    });
    expect(result.filesScanned).toBe(1);
    expect(result.commands).toHaveLength(2);
    expect(result.findings.some((f) => f.ruleId === 'openswarm/quality-command/typecheck')).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('passes when static scan is clean and commands pass', async () => {
    const root = await fixture({ 'src/a.ts': 'export const x = 1;\n' });
    const result = await runQualityHarness(root, {
      sourceFiles: ['src/a.ts'],
      staticOnly: true,
    });
    expect(result).toMatchObject({
      status: 'passed',
      filesListed: 1,
      filesScanned: 1,
      findings: [],
      commands: [],
    });
  });

  it('records verify-plan failures as explicit harness errors', async () => {
    const root = await fixture({
      'src/a.ts': 'export {};\n',
      '.openswarm/verify.yaml': 'version: 1\ncommands: []\n',
    });
    const result = await runQualityHarness(root, {
      sourceFiles: ['src/a.ts'],
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
    });
    expect(result.status).toBe('failed');
    expect(result.findings.some((f) => f.ruleId === 'openswarm/quality-commands')).toBe(true);
  });
});
