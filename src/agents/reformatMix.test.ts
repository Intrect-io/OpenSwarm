// AGT-4899 review (#917): the mixed reformat hold's escape hatch, its message and
// the files it must not call reformat-only. Split from pipelineGuards.test.ts,
// which is near its size limit; same temp-repo setup.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGuards } from './pipelineGuards.js';
import type { WorkerResult } from './agentPair.js';

function mockWorker(filesChanged: string[] = []): WorkerResult {
  return { success: true, summary: '', filesChanged, commands: [], output: '' };
}

function guardIssues(results: Awaited<ReturnType<typeof runGuards>>, guard: string): string[] {
  return results.results.find(r => r.guard === guard)?.issues ?? [];
}

describe('reformatCheck — mixed reformat hold (AGT-4899 review)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-reformat-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 2;\n');
    execFileSync('git', ['add', 'base.ts', 'other.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it('lists new files separately from edited ones in the hold message', async () => {
    writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n');
    writeFileSync(join(repo, 'fresh.ts'), 'export const fresh = 1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 3;\n');
    const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
    const mixed = guardIssues(res, 'reformatScope').find(i => i.startsWith('Reformat mixed'))!;
    expect(mixed).toContain('substantive other.ts; new: fresh.ts.');
  });

  it('lifts the hold when every reformat-only file is acknowledged with REFORMAT:', async () => {
    writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 3;\n');
    const res = await runGuards({ ...mockWorker(), summary: 'Done.\nREFORMAT: ./base.ts' }, repo, { reformatCheck: true });
    const result = res.results.find(r => r.guard === 'reformatScope')!;
    expect(result.blocking).toBe(false);
    expect(result.issues.some(i => i.startsWith('Reformat mixed'))).toBe(false);
    expect(res.allPassed).toBe(true);
  });

  it('keeps holding for reformat-only files the summary did not acknowledge', async () => {
    writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n');
    writeFileSync(join(repo, 'third.ts'), '  export const third = 1;\n');
    execFileSync('git', ['add', 'third.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'third', '--', 'third.ts'], { cwd: repo });
    writeFileSync(join(repo, 'third.ts'), 'export const third = 1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 3;\n');
    const res = await runGuards({ ...mockWorker(), summary: 'REFORMAT: base.ts' }, repo, { reformatCheck: true });
    const mixed = guardIssues(res, 'reformatScope').find(i => i.startsWith('Reformat mixed'))!;
    expect(mixed).toContain('reformat-only third.ts;');
    expect(mixed).not.toContain('reformat-only base.ts');
    expect(res.allPassed).toBe(false);
  });

  it('does not treat a Python indentation fix as reformat-only', async () => {
    writeFileSync(join(repo, 'job.py'), 'def run(xs):\n    for x in xs:\n        pass\n    return 1\n');
    execFileSync('git', ['add', 'job.py'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'job', '--', 'job.py'], { cwd: repo });
    // Moving `return` into the loop changes behaviour but vanishes under -w.
    writeFileSync(join(repo, 'job.py'), 'def run(xs):\n    for x in xs:\n        pass\n        return 1\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 3;\n');
    const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
    const issues = guardIssues(res, 'reformatScope');
    expect(issues.some(i => i.includes('job.py') && i.includes('reformat-only'))).toBe(false);
    expect(res.allPassed).toBe(true);
  });

  it('counts a Python re-indent as substantive next to a real reformat', async () => {
    writeFileSync(join(repo, 'job.py'), 'if True:\n    a = 1\nb = 2\n');
    execFileSync('git', ['add', 'job.py'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'job', '--', 'job.py'], { cwd: repo });
    writeFileSync(join(repo, 'job.py'), 'if True:\n    a = 1\n    b = 2\n');
    writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n');
    const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
    const mixed = guardIssues(res, 'reformatScope').find(i => i.startsWith('Reformat mixed'))!;
    expect(mixed).toContain('reformat-only base.ts; substantive job.py');
  });

  it('never counts a whitespace-only lockfile or build output as reformat-only', async () => {
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'package-lock.json'), '{\n"a": 1\n}\n');
    writeFileSync(join(repo, 'dist', 'app.js'), 'var a=1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'gen'], { cwd: repo });
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "a": 1\n}\n');
    writeFileSync(join(repo, 'dist', 'app.js'), '  var a=1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const other = 3;\n');
    const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
    expect(guardIssues(res, 'reformatScope')).toEqual([]);
    expect(res.allPassed).toBe(true);
  });
});
