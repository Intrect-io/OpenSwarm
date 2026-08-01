import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { spawnCli } from './base.js';

describe('argv-safe adapter spawning', () => {
  it('passes metacharacters as one argv value with shell disabled', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    const injected = 'model; touch /tmp/openswarm-should-not-exist';
    const adapter: CliAdapter = {
      name: 'fixture',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsModelSelection: true,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: ['--model', injected] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };

    await expect(spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith(
      'fixture-cli',
      ['--model', injected],
      expect.objectContaining({ shell: false }),
    );
  });

  it('removes adapter-owned temporary paths after the child settles', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 124,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    const temporaryDir = mkdtempSync(join(tmpdir(), 'openswarm-adapter-cleanup-'));
    writeFileSync(join(temporaryDir, 'mcp.json'), '{}');
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: [], cleanupPaths: [temporaryDir] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } satisfies CliAdapter;

    await spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() });

    expect(existsSync(temporaryDir)).toBe(false);
  });
});

describe('read-only fail-closed guard (INT-3189)', () => {
  const stub = (enforcesReadOnly?: boolean): CliAdapter => ({
    name: 'fixture',
    capabilities: {
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsModelSelection: false,
      managedGit: false,
      supportedSkills: [],
      ...(enforcesReadOnly === undefined ? {} : { enforcesReadOnly }),
    },
    isAvailable: async () => true,
    getDefaultModel: async () => 'fixture',
    buildCommand: () => ({ command: 'fixture-cli', args: [] }),
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
    parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
  });

  it('refuses a read-only run on an adapter that cannot enforce it', async () => {
    // The alternative is running with full tool access while the caller believes
    // writes and shell are denied — the failure mode the flag exists to prevent.
    await expect(
      spawnCli(stub(), { prompt: 'p', cwd: process.cwd(), readOnly: true }),
    ).rejects.toThrow(/cannot enforce read-only/);
  });

  it('lets the same adapter run when read-only was never asked for', async () => {
    await expect(spawnCli(stub(), { prompt: 'p', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
  });

  it('runs read-only on an adapter that declares enforcement', async () => {
    await expect(
      spawnCli(stub(true), { prompt: 'p', cwd: process.cwd(), readOnly: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});
