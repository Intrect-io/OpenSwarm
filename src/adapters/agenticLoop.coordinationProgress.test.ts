import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgenticLoop } from './agenticLoop.js';
import { getCoordinationStore, resetCoordinationStoreForTests } from '../coordination/coordinationStore.js';
import { resetTraceDbForTests } from '../coordination/coordinationTrace.js';
import { repositoryCell } from '../coordination/repositoryCell.js';

const originalBoard = process.env.OPENSWARM_COORDINATION_FILE;
const originalDb = process.env.OPENSWARM_AUTOMATION_DB;
let fixture: string;
afterEach(() => {
  resetCoordinationStoreForTests();
  resetTraceDbForTests();
  process.env.OPENSWARM_COORDINATION_FILE = originalBoard;
  process.env.OPENSWARM_AUTOMATION_DB = originalDb;
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe('Native mixed inbox progress', () => {
  it.each(['coordination_read', 'coordination_wait'])('still stops repeated withheld %s calls mixed with an unchanged file read', async (inboxTool) => {
    fixture = mkdtempSync(join(tmpdir(), 'native-denied-inbox-'));
    writeFileSync(join(fixture, 'state.txt'), 'Unchanged artifact\n');
    let calls = 0;
    const result = await runAgenticLoop({ prompt: 'Read state', cwd: fixture, model: 'fixture', maxTurns: 12,
      webTools: false, memoryTools: false, shellTools: false, readOnly: true,
      callApi: async (_messages, tools) => {
        if (!tools.length || calls === 8) return { choices: [{ message: { role: 'assistant', content: 'Finished' }, finish_reason: 'stop' }] };
        calls++;
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: `file-${calls}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"state.txt"}' } },
          { id: `inbox-${calls}`, type: 'function', function: { name: inboxTool, arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] };
      } });
    expect(result.terminationCause).toBe('no_progress');
    expect(calls).toBeLessThan(8);
  });

  it.each(['coordination_read', 'coordination_wait'])('delivers every new peer response alongside a repeated file read: %s', async (inboxTool) => {
    fixture = mkdtempSync(join(tmpdir(), 'native-inbox-progress-'));
    const repo = join(fixture, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'state.txt'), 'Unchanged artifact\n');
    process.env.OPENSWARM_COORDINATION_FILE = join(fixture, 'board.json');
    process.env.OPENSWARM_AUTOMATION_DB = join(fixture, 'automation.db');
    resetCoordinationStoreForTests();
    resetTraceDbForTests();
    const store = getCoordinationStore();
    const repoKey = repositoryCell(repo).repoKey;
    const received = new Set<string>();
    let calls = 0;
    const result = await runAgenticLoop({
      prompt: 'Read each peer response and compare with state.txt.', cwd: repo, model: 'fixture', maxTurns: 12,
      webTools: false, memoryTools: false, shellTools: false,
      coordinationContext: { repository: repo, repoKey, taskId: 'task', actor: 'worker', actorRole: 'worker' },
      callApi: async (messages, tools) => {
        for (const message of messages) {
          if (message.role !== 'tool' || !message.content.startsWith('[')) continue;
          for (const event of JSON.parse(message.content) as Array<{ summary: string }>) {
            if (event.summary?.startsWith('New evidence')) received.add(event.summary);
          }
        }
        if (!tools.length || calls === 8) return { choices: [{ message: { role: 'assistant', content: 'Finished eight responses' }, finish_reason: 'stop' }] };
        calls++;
        await store.publish({ repository: repo, repoKey, taskId: 'peer-task', targetTaskId: 'task', actor: 'peer', actorRole: 'reviewer',
          recipient: 'worker', kind: 'thread-update', status: 'open', correlationId: `evidence-${calls}`, summary: `New evidence ${calls}` });
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: `file-${calls}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"state.txt"}' } },
          { id: `inbox-${calls}`, type: 'function', function: { name: inboxTool, arguments: '{"timeout_ms":1}' } },
        ] }, finish_reason: 'tool_calls' }] };
      },
    });
    expect(result.terminationCause).toBeUndefined();
    expect(calls).toBe(8);
    expect([...received].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `New evidence ${i + 1}`));
  });
});
