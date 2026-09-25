import { describe, expect, it } from 'vitest';
import { getAdapter } from './index.js';
import type { CliRunResult } from './types.js';

// Every adapter that runs OpenSwarm's own agentic loop observes the shell
// commands it executes. That observation must reach the WorkerResult, or the
// validation gate falls back to the model's self-report (AGT-4534).
const NATIVE_LOOP_ADAPTERS = ['local', 'lmstudio', 'openrouter', 'atlascloud', 'gpt', 'codex-responses', 'ollama-cloud'];

const raw = (executedCommands?: string[]): CliRunResult => ({
  exitCode: 0,
  stdout: '```json\n{"success":true,"summary":"done","filesChanged":[],"commands":[]}\n```',
  stderr: '',
  durationMs: 1,
  ...(executedCommands ? { executedCommands } : {}),
});

describe('native-loop adapters carry observed execution into the worker result', () => {
  it.each(NATIVE_LOOP_ADAPTERS)('%s', (name) => {
    // A missing or renamed adapter must fail here, not pass silently.
    const adapter = getAdapter(name);
    const result = adapter.parseWorkerOutput(raw(['node --test test/a.test.mjs']));
    expect(result.executedCommands).toEqual(['node --test test/a.test.mjs']);
    expect(result.commands).toContain('node --test test/a.test.mjs');
    // An observed-but-empty run is evidence of no execution, not "unknown".
    expect(adapter.parseWorkerOutput(raw([])).executedCommands).toEqual([]);
    expect(adapter.parseWorkerOutput(raw()).executedCommands).toBeUndefined();
  });
});

describe('observedCommandFor', () => {
  it('records what the tool says it executed, and nothing for calls that ran nothing', async () => {
    const { observedCommandFor } = await import('./agenticLoop.js');
    const call = (name: string) => ({ function: { name, arguments: '{}' } });
    expect(observedCommandFor(call('bash'), { is_error: false, executed: 'npm test' })).toBe('npm test');
    // A failing run is still a run: it is evidence that validation happened.
    expect(observedCommandFor(call('bash'), { is_error: true, executed: 'npm test [exit 1]' })).toBe('npm test [exit 1]');
    expect(observedCommandFor(call('bash'), { is_error: true })).toBeUndefined();
    expect(observedCommandFor(call('read_file'), { is_error: false })).toBeUndefined();
    expect(observedCommandFor(call('diagnostics'), { is_error: false, executed: 'diagnostics: tsc' })).toBe('diagnostics: tsc');
  });
});

describe('recordObservedCommand', () => {
  it('keeps the most recent commands, so a final test run survives a long exploration', async () => {
    const { recordObservedCommand } = await import('./agenticLoop.js');
    const list: string[] = [];
    for (let i = 0; i < 30; i += 1) recordObservedCommand(list, `cat file-${i}`);
    recordObservedCommand(list, 'npm test');
    expect(list).toHaveLength(20);
    expect(list.at(-1)).toBe('npm test');
    recordObservedCommand(list, 'npm test');
    expect(list.filter((c) => c === 'npm test')).toHaveLength(1);
  });
});

describe('claimed vs observed commands', () => {
  it('treats a claim as observed when an executed command contains it', async () => {
    const { claimedButNotObserved } = await import('../agents/workerValidationEvidence.js');
    expect(claimedButNotObserved(['npm test', 'npm  run build'], ['cd pkg && npm test 2>&1 | tail', 'npm run build'])).toEqual([]);
    expect(claimedButNotObserved(['npm test'], ['git status'])).toEqual(['npm test']);
  });
});
