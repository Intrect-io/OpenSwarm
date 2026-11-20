import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../adapters/types.js';

// AGT-4809 review: one detector for a worker's shell reaching for the network,
// read from the agentic bash tool and from every CLI adapter's event stream,
// recorded only under the loopback-only worker network policy.

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { spawnCli } from '../adapters/base.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { noteSandboxDenial, resetWorkerNetworkPolicyForTests, setWorkerNetworkPolicy } from './osSandbox.js';
import { CliCommandOutputReader, createCliNetworkScanner, noteNetworkDenial } from './sandboxNetworkSignal.js';

let root: string;
let dbPath: string;
let repo: string;
const savedSessionLog = process.env.OPENSWARM_SESSION_LOG;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openswarm-netsignal-'));
  dbPath = join(root, 'automation.db');
  repo = join(root, 'repo');
  mkdirSync(repo);
  vi.stubEnv('OPENSWARM_AUTOMATION_DB', dbPath); // vitest.setup.ts points it at a shared per-worker file
  setWorkerNetworkPolicy('loopback');
  process.env.OPENSWARM_SESSION_LOG = '0';
  spawnMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetWorkerNetworkPolicyForTests();
  if (savedSessionLog === undefined) delete process.env.OPENSWARM_SESSION_LOG;
  else process.env.OPENSWARM_SESSION_LOG = savedSessionLog;
  rmSync(root, { recursive: true, force: true });
});

type Row = { project_path: string; detail: string };

function readRows(): Row[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automation_factory_signals'").get();
    return table ? db.prepare("SELECT project_path, detail FROM automation_factory_signals WHERE kind = 'sandbox_network'").all() as Row[] : [];
  } finally {
    db.close();
  }
}

/** The recorded rows once the fire-and-forget writes have had time to land. */
async function recorded(expected: number): Promise<Row[]> {
  for (let i = 0; i < 50 && readRows().length < expected; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100)); // and anything that would land after
  return readRows();
}

const codexEvent = (command: string, output: string, exitCode: number) => JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_1', type: 'command_execution', command: `/bin/zsh -lc '${command}'`, aggregated_output: output, exit_code: exitCode, status: exitCode ? 'failed' : 'completed' },
});

describe('CliCommandOutputReader', () => {
  it('reads codex command_execution events, failed ones only', () => {
    const reader = new CliCommandOutputReader();
    expect(reader.read(codexEvent('curl https://github.com', 'curl: (6) Could not resolve host: github.com', 6))).toEqual({
      command: "/bin/zsh -lc 'curl https://github.com'", output: 'curl: (6) Could not resolve host: github.com',
    });
    expect(reader.read(codexEvent('grep -r resolve .', 'tests: Could not resolve host: github.com', 0))).toBeUndefined();
  });

  it('pairs a claude Bash tool_use with the failed tool_result that answers it, and ignores other tools', () => {
    const reader = new CliCommandOutputReader();
    const use = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, content: string, isError: boolean) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
    expect(reader.read(use('t1', 'Bash', { command: 'npm install left-pad' }))).toBeUndefined();
    expect(reader.read(result('t1', 'Exit code 1\nnpm error getaddrinfo ENOTFOUND registry.npmjs.org', true))).toEqual({
      command: 'npm install left-pad', output: 'Exit code 1\nnpm error getaddrinfo ENOTFOUND registry.npmjs.org',
    });
    reader.read(use('t2', 'Read', { file_path: 'x' }));
    expect(reader.read(result('t2', 'Could not resolve host: github.com', true))).toBeUndefined();
    reader.read(use('t3', 'Bash', { command: 'cat notes.txt' }));
    expect(reader.read(result('t3', 'Could not resolve host: github.com', false))).toBeUndefined();
  });

  it('reads a cursor shellToolCall that failed', () => {
    const reader = new CliCommandOutputReader();
    const event = (result: object) => JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'git fetch' }, result } } });
    expect(reader.read(event({ success: { exitCode: 128, stdout: '', stderr: 'fatal: Could not resolve host: github.com' } }))).toMatchObject({ command: 'git fetch', output: expect.stringContaining('github.com') });
    expect(reader.read(event({ success: { exitCode: 0, stdout: 'Could not resolve host: x.com', stderr: '' } }))).toBeUndefined();
  });
});

describe('recording', () => {
  it('records the hostname of a refused lookup from the bash tool path under the loopback policy', async () => {
    expect(noteSandboxDenial('curl: (6) Could not resolve host: github.com', 'curl https://github.com', repo)).toBe(false);
    expect(await recorded(1)).toEqual([{ project_path: normalizeProjectPath(repo), detail: 'github.com\ncurl https://github.com' }]);
  });

  it('records nothing when the worker network policy is open (the write fence alone is no network fence)', async () => {
    setWorkerNetworkPolicy('open');
    noteSandboxDenial('Error: connect EPERM 140.82.112.3:443', 'node fetch.js', repo);
    expect(noteNetworkDenial('curl: (6) Could not resolve host: github.com', 'curl', repo)).toBeUndefined();
    expect(await recorded(0)).toEqual([]);
  });

  it('records nothing in a process that never declared a worker network policy (chat, ad-hoc runs)', async () => {
    resetWorkerNetworkPolicyForTests();
    expect(noteNetworkDenial('curl: (6) Could not resolve host: github.com', 'curl', repo)).toBeUndefined();
    expect(await recorded(0)).toEqual([]);
  });

  it('the CLI scanner reads events split across chunks and records one denial per run', async () => {
    const scanner = createCliNetworkScanner(repo);
    const line = `${codexEvent('curl https://github.com', 'curl: (6) Could not resolve host: github.com', 6)}\n`;
    scanner.push(line.slice(0, 40));
    scanner.push(line.slice(40) + codexEvent('curl https://example.com', 'curl: (6) Could not resolve host: example.com', 6));
    scanner.flush();
    expect((await recorded(1)).map((r) => r.detail.split('\n')[0])).toEqual(['github.com']);
  });

  it('spawnCli scans a CLI adapter worker run (the codex path) and skips a read-only review', async () => {
    const adapter: CliAdapter = {
      name: 'codex',
      capabilities: { supportsStreaming: false, supportsJsonOutput: true, supportsModelSelection: false, managedGit: true, supportedSkills: [], enforcesReadOnly: true },
      isAvailable: async () => true,
      getDefaultModel: async () => 'm',
      buildCommand: () => ({ command: 'codex', args: [] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };
    const run = async (readOnly: boolean, host: string) => {
      const proc = Object.assign(new EventEmitter(), {
        pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
      });
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          proc.stdout.end(`${codexEvent(`curl https://${host}`, `curl: (6) Could not resolve host: ${host}`, 6)}\n`);
          proc.emit('close', 0);
        });
        return proc;
      });
      await spawnCli(adapter, { prompt: 'p', cwd: repo, readOnly });
    };
    await run(true, 'review.example.com');
    await run(false, 'worker.example.com');
    expect((await recorded(1)).map((r) => r.detail.split('\n')[0])).toEqual(['worker.example.com']);
  });
});
