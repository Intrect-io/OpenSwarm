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
    let adapter;
    try {
      adapter = getAdapter(name);
    } catch {
      return; // adapter not registered in this build
    }
    const result = adapter.parseWorkerOutput(raw(['node --test test/a.test.mjs']));
    expect(result.executedCommands).toEqual(['node --test test/a.test.mjs']);
    expect(result.commands).toContain('node --test test/a.test.mjs');
    // An observed-but-empty run is evidence of no execution, not "unknown".
    expect(adapter.parseWorkerOutput(raw([])).executedCommands).toEqual([]);
    expect(adapter.parseWorkerOutput(raw()).executedCommands).toBeUndefined();
  });
});

describe('observedCommandFor', () => {
  it('records successful bash and diagnostics calls, nothing else', async () => {
    const { observedCommandFor } = await import('./agenticLoop.js');
    const { missingWorkerValidationIssues } = await import('../agents/workerValidationEvidence.js');
    const call = (name: string, args: unknown) => ({ function: { name, arguments: JSON.stringify(args) } });
    expect(observedCommandFor(call('bash', { command: 'npm test' }), { is_error: false })).toBe('npm test');
    expect(observedCommandFor(call('bash', { command: 'npm test' }), { is_error: true })).toBeUndefined();
    expect(observedCommandFor(call('read_file', { path: 'a' }), { is_error: false })).toBeUndefined();
    expect(observedCommandFor({ function: { name: 'bash', arguments: '{' } }, { is_error: false })).toBeUndefined();
    const diagnostics = observedCommandFor(call('diagnostics', { paths: ['a.ts'] }), { is_error: false });
    // A diagnostics run is validation the gate accepts.
    expect(missingWorkerValidationIssues({
      success: true, summary: '', filesChanged: ['src/a.ts'], commands: [], output: '', executedCommands: [diagnostics!],
    })).toEqual([]);
  });
});
