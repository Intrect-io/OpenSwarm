// Created: 2026-11-21
// Purpose: `openswarm steward-merge` exit codes and option surface with an injected executor (AGT-4803)
// Dependencies: vitest, commander
// Test Status: passing

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { StewardMergeInput, StewardMergeResult, StewardMergeStatus } from '../automation/mergeStewardExecutor.js';
import { registerStewardMergeCommand, runStewardMergeCommand } from './stewardMergeCommand.js';

const REPO = 'acme/widgets';
const HEAD = 'c'.repeat(40);

function harness(status: StewardMergeStatus | 'throw' = 'merged') {
  const calls: StewardMergeInput[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const execute = async (input: StewardMergeInput): Promise<StewardMergeResult> => {
    calls.push(input);
    if (status === 'throw') throw new Error('boom');
    return {
      status, reason: `test ${status}`, repo: input.repo, prNumber: input.prNumber, headSha: HEAD,
      audit: `[steward audit] repo=${input.repo} pr=#${input.prNumber} head=${HEAD} ci=pass review=pass grant=pass`,
    };
  };
  return { deps: { execute, out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, calls, out, err };
}

describe('openswarm steward-merge', () => {
  it('exits 0 on a completed merge write', async () => {
    const h = harness('merged');
    expect(await runStewardMergeCommand('5', { repo: REPO }, h.deps)).toBe(0);
    expect(h.calls).toEqual([{ repo: REPO, prNumber: 5 }]);
    expect(h.out[0]).toMatch(/^\[steward merge\] PR #5 @ cccccccccccc: MERGED/);
    expect(h.out[1]).toMatch(/^\[steward audit\]/);
  });

  it('exits 3 when refused', async () => {
    const h = harness('refused');
    expect(await runStewardMergeCommand(`https://github.com/${REPO}/pull/7`, {}, h.deps)).toBe(3);
    expect(h.calls).toEqual([{ repo: REPO, prNumber: 7 }]);
    expect(h.out[0]).toContain('REFUSED');
  });

  it('exits 1 on an infrastructure failure', async () => {
    expect(await runStewardMergeCommand('5', { repo: REPO }, harness('infra').deps)).toBe(1);
    const thrown = harness('throw');
    expect(await runStewardMergeCommand('5', { repo: REPO }, thrown.deps)).toBe(1);
    expect(thrown.err.join('\n')).toMatch(/infrastructure failure/);
  });

  it('exits 2 on usage errors without calling the executor', async () => {
    const h = harness();
    expect(await runStewardMergeCommand(undefined, { repo: REPO }, h.deps)).toBe(2);
    expect(await runStewardMergeCommand('abc', { repo: REPO }, h.deps)).toBe(2);
    expect(await runStewardMergeCommand('5', {}, h.deps)).toBe(2);
    expect(await runStewardMergeCommand(`https://github.com/${REPO}/pull/5`, { repo: 'other/repo' }, h.deps)).toBe(2);
    expect(await runStewardMergeCommand('5', { repo: 'not-a-repo' }, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('registers steward-merge with no automation-account flag', () => {
    const program = new Command();
    registerStewardMergeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'steward-merge');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toEqual(['--repo']);
    expect(flags).not.toContain('--automation-account');
  });
});
