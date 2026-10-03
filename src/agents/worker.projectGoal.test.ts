// Purpose: the project goal reaches the worker's system prompt, ahead of the repo rules (AGT-4662)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLocale } from '../locale/index.js';

const spawnCli = vi.fn(async () => 'raw');
vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({
    parseWorkerOutput: () => ({ success: true, summary: 's', filesChanged: [], commands: [], output: 'o' }),
  }),
  getDefaultAdapterName: () => 'gpt',
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runWorker } = await import('./worker.js');
const systemPromptOf = () => (spawnCli.mock.calls[0][1] as { systemPrompt?: string }).systemPrompt ?? '';

describe('runWorker project goal (AGT-4662)', () => {
  beforeEach(() => {
    spawnCli.mockClear();
    initLocale('en');
  });

  it('puts the goal in the system prompt, before the repository instructions', async () => {
    const capsule = { text: '\n\n## CAPSULE-MARKER\n', digest: 'd', sources: [], errors: [], repositoryRoot: '/p' };
    await runWorker({
      taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt',
      projectGoal: 'Reconcile ledgers in dependency order, to a usable level.',
      instructionCapsule: capsule,
    });
    const prompt = systemPromptOf();
    expect(prompt).toContain('## Standing project goal');
    expect(prompt).toContain('Reconcile ledgers in dependency order, to a usable level.');
    expect(prompt.indexOf('Standing project goal')).toBeLessThan(prompt.indexOf('CAPSULE-MARKER'));
  });

  it('leaves the system prompt without a goal section when none is set', async () => {
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt' });
    expect(systemPromptOf()).not.toContain('Standing project goal');
  });
});
