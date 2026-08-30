// Purpose: WorkerOptions.mcpTools is forwarded to the adapter spawnCli call (INT-1950)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';
import { initLocale } from '../locale/index.js';

const spawnCli = vi.fn(async () => 'raw');
const parseWorkerOutput = vi.fn(() => ({
  success: true,
  summary: 's',
  filesChanged: [],
  commands: [],
  output: 'o',
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ parseWorkerOutput }),
  getDefaultAdapterName: () => 'gpt',
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runWorker } = await import('./worker.js');

describe('runWorker mcpTools pass-through (INT-1950)', () => {
  beforeEach(() => {
    spawnCli.mockClear();
    initLocale('en');
  });

  it('forwards mcpTools to the adapter spawnCli options', async () => {
    const mcpTools: ToolDefinition[] = [
      { type: 'function', function: { name: 'linear__list_issues', description: '', parameters: { type: 'object', properties: {} } } },
    ];
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt', mcpTools });
    expect(spawnCli).toHaveBeenCalled();
    const opts = spawnCli.mock.calls[0][1] as { mcpTools?: ToolDefinition[] };
    expect(opts.mcpTools).toBe(mcpTools);
  });

  it('leaves mcpTools undefined when not provided', async () => {
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt' });
    const opts = spawnCli.mock.calls[0][1] as { mcpTools?: ToolDefinition[] };
    expect(opts.mcpTools).toBeUndefined();
  });

  it('teaches coordination-enabled workers the bounded durable consultation path', async () => {
    await runWorker({
      taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt',
      coordinationContext: {
        repository: '/p', repoKey: 'git:p', taskId: 'task-a', actor: 'worker-a', actorRole: 'worker',
      },
    });
    const opts = spawnCli.mock.calls[0][1] as { systemPrompt?: string };
    expect(opts.systemPrompt).toContain('## Bounded peer consultation');
    expect(opts.systemPrompt).toContain('coordination_peers');
    expect(opts.systemPrompt).toContain('scope="related"');
    expect(opts.systemPrompt).toContain('one targeted');
    expect(opts.systemPrompt).toContain('send nothing and continue');
    expect(opts.systemPrompt).toContain('acknowledges_correlation_id');
  });
});
