// The pipeline-eval harness's pure helpers (AGT-4811). The harness entrypoint
// itself drives real pipeline runs and is a coverage boundary (vitest.config.ts);
// these are the parts that decide where evidence lives and whether a run counts.
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findGraderAccess, resolveRunRoot, sealEvidence, unsealEvidence } from '../benchmarks/pipelineEval.js';

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
