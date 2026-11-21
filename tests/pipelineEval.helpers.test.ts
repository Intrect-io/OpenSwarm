// The eval harness's pure helpers (AGT-4811). The harness entrypoint
// itself drives real pipeline runs and is a coverage boundary (vitest.config.ts);
// these are the parts that decide where evidence lives and whether a run counts.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyChanges, cleanupRun, countWorkflowRuns, dispatchGuardScript, findGraderAccess, parseArgs, phantomExists,
  resolveRunRoot, sealEvidence, unsealEvidence,
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

describe('classifyChanges with an allowed scope', () => {
  it('allows exactly the listed files and directories', () => {
    expect(classifyChanges(['tools/textkit/src/a.mjs', 'tools/textkit/src/a.mjsx', 'tools/textkit/lib/b.mjs', 'tools/textkit/c.mjs'], ['src/a.mjs', 'lib/']))
      .toEqual({ testsTampered: false, outOfScopeFiles: ['tools/textkit/src/a.mjsx', 'tools/textkit/c.mjs'] });
  });
});

// The gh every eval pipeline runs with (AGT-4811): workflow dispatches are
// refused and logged (as a run when a token came with them), everything else
// reaches the real gh.
describe('dispatchGuardScript', () => {
  let dir = '';
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; } });
  const setup = (log: string) => {
    const realGh = join(dir, 'real gh');
    writeFileSync(realGh, '#!/bin/sh\necho "real $*"\n', { mode: 0o755 });
    const guard = join(dir, 'gh');
    writeFileSync(guard, dispatchGuardScript(realGh, log, 'n0nce'), { mode: 0o755 });
    return guard;
  };
  const noToken = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '' };

  it('refuses and logs every workflow dispatch, and passes other commands to the real gh', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-guard-'));
    const log = join(dir, 'dispatch.log');
    const guard = setup(log);
    for (const args of [['workflow', 'run', 'x.yml', '--ref', 'main'], ['workflow', 'dispatch', 'x.yml'], ['api', '-X', 'POST', 'repos/o/r/actions/workflows/1/dispatches']]) {
      const res = spawnSync(guard, args, { encoding: 'utf8', env: noToken });
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('n0ncea');
    }
    const withToken = spawnSync(guard, ['workflow', 'run', 'x.yml'], { encoding: 'utf8', env: { ...noToken, GH_TOKEN: 't' } });
    expect(withToken.status).toBe(1);
    expect(withToken.stderr).toContain('n0ncer');
    const logged = readFileSync(log, 'utf8');
    expect(countWorkflowRuns(logged, '', 'n0nce')).toEqual({ runs: 1, attempts: 3 });
    expect(execFileSync(guard, ['pr', 'view', '1', '--json', 'url'], { encoding: 'utf8' })).toBe('real pr view 1 --json url\n');
    expect(execFileSync(guard, ['run', 'list'], { encoding: 'utf8' })).toBe('real run list\n');
  });

  it('still refuses, silently about its log, when the log cannot be written', () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-guard-'));
    const log = join(dir, 'missing-dir', 'dispatch.log');
    const res = spawnSync(setup(log), ['workflow', 'run', 'x.yml'], { encoding: 'utf8', env: noToken });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('n0ncea');
    expect(res.stderr).not.toContain('dispatch.log');
    expect(existsSync(log)).toBe(false);
  });
});

describe('countWorkflowRuns', () => {
  it('counts logged dispatches, or transcript lines with the marker when the log could not be written', () => {
    expect(countWorkflowRuns('', '{"output":"ok"}', 'n0nce')).toEqual({ runs: 0, attempts: 0 });
    expect(countWorkflowRuns('run workflow run a.yml\nattempt workflow run b.yml\n', '', 'n0nce')).toEqual({ runs: 1, attempts: 1 });
    expect(countWorkflowRuns('', '{"output":"HTTP 403 (request n0ncea)"}\n{"output":"(request n0ncer)"}\n{"output":"ok"}', 'n0nce'))
      .toEqual({ runs: 1, attempts: 1 });
  });
});
