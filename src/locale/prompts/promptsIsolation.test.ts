import { describe, expect, it, vi } from 'vitest';

// Several suites (scheduler, prProcessor) partially mock child_process. If any
// module the prompts import touches it at module scope — `promisify(execFile)`
// did — those suites stop loading entirely with "No 'execFile' export is
// defined on the child_process mock", and the failure names the innocent suite
// rather than the prompt module that caused it. This reproduces that shape.
vi.mock('node:child_process', () => ({}));
vi.mock('child_process', () => ({}));

describe('prompt templates', () => {
  it('load without child_process, so a suite that mocks it can still import them', async () => {
    const { enPrompts } = await import('./en.js');
    const { koPrompts } = await import('./ko.js');
    const context = { siblingWork: [{ identifier: 'AX-1', files: ['a.ts'] }] };

    expect(enPrompts.buildWorkerPrompt({ taskTitle: 't', taskDescription: 'd', context }))
      .toContain('Concurrent work in this repository');
    expect(koPrompts.buildWorkerPrompt({ taskTitle: 't', taskDescription: 'd', context }))
      .toContain('동시 작업 중');
  });
});
