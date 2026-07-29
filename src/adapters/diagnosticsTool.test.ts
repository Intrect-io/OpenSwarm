import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDiagnosticsTool } from './diagnosticsTool.js';
import { runAgenticLoop } from './agenticLoop.js';

async function tsProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'osw-diag-'));
  await writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

describe('runDiagnosticsTool (INT-3105)', () => {
  it('requires paths so output stays proportional to the edit', async () => {
    const text = await runDiagnosticsTool([], '/tmp');
    expect(text).toContain('pass the files you changed');
  });

  it('reports clean explicitly — silence would read as a broken tool', async () => {
    const dir = await tsProject({ 'src/a.ts': 'export const a: number = 1;\n' });
    try {
      const text = await runDiagnosticsTool(['src/a.ts'], dir);
      expect(text).toContain('[tsc] clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('surfaces a broken cross-file contract with the caller file and line', async () => {
    // The scenario the tool exists for: an edit changed a signature and a
    // caller elsewhere no longer compiles.
    const dir = await tsProject({
      'src/lib.ts': 'export function greet(name: string, times: number): string { return name.repeat(times); }\n',
      'src/caller.ts': "import { greet } from './lib.js';\nexport const x = greet('hi');\n",
    });
    try {
      const text = await runDiagnosticsTool(['src/caller.ts'], dir);
      expect(text).toContain('src/caller.ts');
      expect(text).toMatch(/TS\d+/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('summarizes errors outside the requested paths WITH their filenames', async () => {
    // A missed caller elsewhere is exactly what the tool exists to reveal —
    // its filename must survive summarization (full lines stay omitted).
    const dir = await tsProject({
      'src/edited.ts': 'export const ok: number = 1;\n',
      'src/other.ts': 'export const broken: number = "not a number";\n',
    });
    try {
      const text = await runDiagnosticsTool(['src/edited.ts'], dir);
      expect(text).toContain('src/other.ts: 1 error(s)');
      expect(text).toContain('missed callers');
      expect(text).not.toContain('src/other.ts(');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('accepts absolute paths under the root (the loop cwd note allows them)', async () => {
    const dir = await tsProject({
      'src/caller.ts': "export const x: number = 'nope';\n",
    });
    try {
      const text = await runDiagnosticsTool([path.join(dir, 'src/caller.ts')], dir);
      expect(text).toContain('src/caller.ts(');
      expect(text).not.toContain('missed callers');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('finds a nested workspace tsconfig when the root has none', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'osw-diag-mono-'));
    try {
      await mkdir(path.join(dir, 'packages/app/src'), { recursive: true });
      await writeFile(
        path.join(dir, 'packages/app/tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
        'utf8',
      );
      await writeFile(path.join(dir, 'packages/app/src/a.ts'), "export const n: number = 'bad';\n", 'utf8');
      const text = await runDiagnosticsTool(['packages/app/src/a.ts'], dir);
      expect(text).toContain('error TS');
      expect(text).not.toContain('SKIPPED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('points non-TS/Python projects at the bash tool', async () => {
    const text = await runDiagnosticsTool(['src/main.rs'], '/tmp');
    expect(text).toContain('bash tool');
  });
});

describe('agenticLoop diagnostics exposure (INT-3105)', () => {
  it('is opt-in: hidden by default, exposed with diagnosticsTool: true', async () => {
    const seen: string[][] = [];
    const callApi = async (_messages: unknown, tools: Array<{ function: { name: string } }>) => {
      seen.push(tools.map((t) => t.function.name));
      return { content: 'done', toolCalls: [], finishReason: 'stop' as const };
    };
    await runAgenticLoop({ prompt: 'p', cwd: '/tmp', model: 'm', callApi: callApi as never, maxTurns: 1, webTools: false, memoryTools: false });
    await runAgenticLoop({ prompt: 'p', cwd: '/tmp', model: 'm', callApi: callApi as never, maxTurns: 1, webTools: false, memoryTools: false, diagnosticsTool: true });
    expect(seen[0]).not.toContain('diagnostics');
    expect(seen[1]).toContain('diagnostics');
  });
});
