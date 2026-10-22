// Created: 2026-10-22
// Purpose: every stage that runs the agentic loop forwards the fences the worker's shell runs under
// Dependencies: ../adapters/index.js (spawnCli mocked; nothing here shells out)
// Test Status: Complete
//
// Only the worker stage used to pass `sandbox` and `forbidPublication` to spawnCli. The tester's LLM
// fallback, the documenter, the auditor and the skill documenter get the same `bash` tool, and the
// credential-free env (AGT-4783) alone does not stop a repo script from writing outside the worktree,
// reaching the network (AGT-4798) or committing and pushing (AGT-4418). A probe with the old option
// shape ran `git commit` and wrote outside the worktree; the worker's shape refused both.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerResult } from './agentPair.js';

const spawnCli = vi.fn();

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({}),
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runTester } = await import('./tester.js');
const { runDocumenter } = await import('./documenter.js');
const { runAuditor } = await import('./auditor.js');
const { runSkillDocumenter } = await import('./skillDocumenter.js');

const workerResult: WorkerResult = {
  success: true, summary: 'did it', filesChanged: ['src/a.ts'], commands: ['npm test'], output: 'done',
};
const base = { taskTitle: 'T', taskDescription: 'D', workerResult, projectPath: '/repo' };

type StageRun = (sandbox: 'on' | 'off' | undefined) => Promise<unknown>;
const stages: Array<[string, StageRun]> = [
  ['tester', (sandbox) => runTester({ ...base, sandbox })],
  ['documenter', (sandbox) => runDocumenter({ ...base, sandbox })],
  ['auditor', (sandbox) => runAuditor({ ...base, sandbox })],
  ['skill documenter', (sandbox) => runSkillDocumenter({ ...base, sandbox })],
];

describe('stage fences', () => {
  beforeEach(() => {
    spawnCli.mockReset();
    spawnCli.mockResolvedValue({ stdout: '' });
  });

  it.each(stages)('the %s forwards the worker sandbox setting and forbids publication to its shell', async (_name, run) => {
    await run('on');
    expect(spawnCli).toHaveBeenCalledTimes(1);
    expect(spawnCli.mock.calls[0][1]).toMatchObject({ sandbox: 'on', forbidPublication: true });
  });

  it.each(stages)('the %s forwards an explicit off, and leaves it unset when the caller set none', async (_name, run) => {
    await run('off');
    expect(spawnCli.mock.calls[0][1]).toMatchObject({ sandbox: 'off', forbidPublication: true });
    spawnCli.mockClear();
    await run(undefined);
    expect((spawnCli.mock.calls[0][1] as { sandbox?: string }).sandbox).toBeUndefined();
  });
});
