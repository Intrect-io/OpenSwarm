// The eval harness's pure helpers (AGT-4811). The harness entrypoint
// itself drives real pipeline runs and is a coverage boundary (vitest.config.ts);
// these are the parts that decide where evidence lives and whether a run counts.
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyChanges, cleanupRun, findGraderAccess, parseArgs, phantomExists, resolveRunRoot, sealEvidence, unsealEvidence,
} from '../benchmarks/pipelineEval.js';

describe('resolveRunRoot', () => {
  it('places a run under the checkout, never in a shared temporary directory', () => {
    expect(resolveRunRoot('/repo', 'run-1', ['/tmp'])).toBe('/repo/worktree/claude-eval-runs/run-1');
    expect(() => resolveRunRoot('/tmp/repo', 'run-1', ['/tmp/'])).toThrow(/inside the shared temporary directory/);
  });

  it('refuses run ids that could escape the run root', () => {
    for (const bad of ['../x', '.hidden', 'a/b', '']) expect(() => resolveRunRoot('/repo', bad, [])).toThrow(/invalid run id/);
  });
});

describe('findGraderAccess', () => {
  it('names grader locations and other runs the agents touched, not its own run', () => {
    const transcripts = 'cat ../../benchmarks/pipelineEval.ts; ls claude-eval-runs/run-2 claude-eval-runs/run-1';
    expect(findGraderAccess(transcripts, 'run-1')).toEqual(['pipelineEval', 'claude-eval-runs/run-2']);
    expect(findGraderAccess('npm test', 'run-1')).toEqual([]);
  });
});

describe('sealEvidence / unsealEvidence', () => {
  let dir = '';
  afterEach(() => { if (dir) { unsealEvidence(dir); rmSync(dir, { recursive: true, force: true }); dir = ''; } });

  it('makes the evidence tree read-only and restores it', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-evidence-'));
    mkdirSync(join(dir, 'case'));
    writeFileSync(join(dir, 'case', 'record.json'), '{}');
    sealEvidence(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, 'case')).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, 'case', 'record.json')).mode & 0o777).toBe(0o444);
    unsealEvidence(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'case', 'record.json')).mode & 0o777).toBe(0o644);
  });
});

describe('parseArgs', () => {
  it('accepts positive numbers for the numeric options', () => {
    expect(parseArgs(['--max-iterations', '2', '--checks-wait-min', '0.5', '--repeat', '3']))
      .toMatchObject({ maxIterations: 2, checksWaitMin: 0.5, repeat: 3 });
  });

  it.each([
    ['--max-iterations', 'abc'], ['--max-iterations', '0'], ['--max-iterations', '-1'], ['--max-iterations', '1.5'],
    ['--max-iterations', 'Infinity'], ['--checks-wait-min', 'abc'], ['--checks-wait-min', '0'],
    ['--checks-wait-min', '-3'], ['--checks-wait-min', 'Infinity'], ['--repeat', '0'],
  ])('rejects %s %s', (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow(new RegExp(`${flag} must be a positive`));
  });

  it('parses --cleanup with its run id', () => {
    expect(parseArgs(['--cleanup', 'run-1']).cleanup).toBe('run-1');
    expect(() => parseArgs(['--cleanup'])).toThrow(/needs a value/);
  });
});

describe('phantomExists', () => {
  const url = 'https://github.com/o/r/pull/1';

  it('reports true when the PR exists', async () => {
    expect(await phantomExists(url, async () => ({ stdout: '' }))).toEqual({ exists: true });
  });

  it('reports false only on a 404', async () => {
    const notFound = Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Not Found (HTTP 404)' });
    expect(await phantomExists(url, async () => { throw notFound; })).toEqual({ exists: false });
  });

  it('reports unknown, with the error, when gh fails for another reason', async () => {
    const noAuth = Object.assign(new Error('Command failed: gh api'), { stderr: 'gh auth login required' });
    const found = await phantomExists(url, async () => { throw noAuth; });
    expect(found.exists).toBe('unknown');
    expect(found.error).toContain('gh auth login required');
  });
});

describe('classifyChanges', () => {
  it('flags edits to the fixture tests and files outside the fixture', () => {
    expect(classifyChanges(['tools/textkit/src/a.mjs'])).toEqual({ testsTampered: false, outOfScopeFiles: [] });
    expect(classifyChanges(['tools/textkit/test/a.test.mjs', 'src/cli.ts', 'tools/textkitx/a.mjs']))
      .toEqual({ testsTampered: true, outOfScopeFiles: ['src/cli.ts', 'tools/textkitx/a.mjs'] });
  });
});

describe('cleanupRun', () => {
  let checkout = '';
  afterEach(() => { if (checkout) { rmSync(checkout, { recursive: true, force: true }); checkout = ''; } });

  it('unseals and removes only the named run root', () => {
    checkout = mkdtempSync(join(tmpdir(), 'eval-checkout-'));
    const runs = join(checkout, 'worktree', 'claude-eval-runs');
    const root = join(runs, 'run-1');
    mkdirSync(join(root, 'evidence', 'TK-1'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'TK-1', 'record.json'), '{}');
    mkdirSync(join(runs, 'run-2'));
    sealEvidence(join(root, 'evidence'));

    expect(cleanupRun(checkout, 'run-1', [])).toBe(root);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(runs, 'run-2'))).toBe(true);
  });

  it('refuses a missing run root, a symlinked one, and a run id that escapes', () => {
    checkout = mkdtempSync(join(tmpdir(), 'eval-checkout-'));
    const runs = join(checkout, 'worktree', 'claude-eval-runs');
    mkdirSync(runs, { recursive: true });
    const outside = join(checkout, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(runs, 'linked'));
    expect(() => cleanupRun(checkout, 'missing', [])).toThrow(/no run root/);
    expect(() => cleanupRun(checkout, 'linked', [])).toThrow(/not a plain directory/);
    expect(existsSync(outside)).toBe(true);
    expect(() => cleanupRun(checkout, '../outside', [])).toThrow(/invalid run id/);
  });
});
