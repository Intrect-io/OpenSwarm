import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../adapters/types.js';

const getAdapter = vi.hoisted(() => vi.fn());
const resolveMcpTools = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../adapters/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/index.js')>();
  return { ...actual, getAdapter };
});

vi.mock('../mcp/mcpClient.js', () => ({ resolveMcpTools }));

import { runChatCompletion } from './chatBackend.js';

function cliAdapter(buildCommand: CliAdapter['buildCommand'], name: CliAdapter['name'] = 'codex'): CliAdapter {
  return {
    name,
    capabilities: {
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportsModelSelection: true,
      managedGit: false,
      supportedSkills: [],
    },
    isAvailable: async () => true,
    getDefaultModel: async () => 'gpt-5-codex',
    buildCommand,
    parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
    parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
  };
}

afterEach(() => vi.clearAllMocks());

describe('runChatCompletion CLI fallback', () => {
  it('stores prompts in an unpredictable owner-only temp path and removes it', async () => {
    let promptPath = '';
    getAdapter.mockReturnValue(cliAdapter((options) => {
      promptPath = options.prompt;
      const script = [
        "const fs = require('node:fs')",
        'const p = process.argv[1]',
        'const payload = JSON.stringify({ path: p, mode: fs.statSync(p).mode & 0o777, content: fs.readFileSync(p, \'utf8\') })',
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }))",
      ].join(';');
      return { command: process.execPath, args: ['-e', script, options.prompt] };
    }));

    const result = await runChatCompletion({
      prompt: 'sensitive prompt',
      provider: 'codex',
      timeoutMs: 5000,
    });
    const payload = JSON.parse(result.response) as { path: string; mode: number; content: string };

    expect(payload.path).toBe(promptPath);
    expect(payload.mode).toBe(0o600);
    expect(payload.content).toBe('sensitive prompt');
    expect(promptPath).toMatch(/openswarm-chat-[^/]+\/prompt\.txt$/);
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(dirname(promptPath))).toBe(false);
  });

  it('feeds a stdin-driven CLI its prompt and parses its own event shape', async () => {
    // cursor-agent takes the prompt on stdin and streams its own stream-json
    // events; running it through the Codex path fed it nothing and parsed
    // nothing back, so every chat turn came back empty.
    getAdapter.mockReturnValue(cliAdapter((options) => {
      const script = [
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: 'partial' } }))",
        "  console.log(JSON.stringify({ type: 'result', result: 'answered: ' + input.trim() }))",
        '})',
      ].join(';');
      return { command: process.execPath, args: ['-e', script], stdinFile: options.prompt };
    }, 'cursor'));

    const streamed: string[] = [];
    const result = await runChatCompletion({
      prompt: 'what changed?',
      provider: 'cursor',
      timeoutMs: 5000,
      onText: (text) => { if (text) streamed.push(text); },
    });

    expect(result.response).toBe('answered: what changed?');
    // Live output, not just the final answer once the process exits.
    expect(streamed).toContain('partial');
  });

  it('terminates the spawned CLI process when the caller aborts', async () => {
    const controller = new AbortController();
    let promptPath = '';
    let runSignal: AbortSignal | undefined;
    getAdapter.mockReturnValue(cliAdapter((options) => {
      promptPath = options.prompt;
      runSignal = options.signal;
      expect(runSignal).not.toBe(controller.signal);
      expect(runSignal?.aborted).toBe(false);
      return { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
    }));
    const startedAt = Date.now();
    const pending = runChatCompletion({
      prompt: 'cancel me',
      provider: 'codex',
      timeoutMs: 5000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(runSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(dirname(promptPath))).toBe(false);
  });

  it('hard-times-out chat command construction that ignores AbortSignal and handles its late rejection', async () => {
    let promptPath = '';
    getAdapter.mockReturnValue(cliAdapter((options) => {
      promptPath = options.prompt;
      return new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late chat command failure')), 300);
      });
    }));

    const startedAt = Date.now();
    await expect(runChatCompletion({
      prompt: 'time out while enumerating MCP',
      provider: 'codex',
      timeoutMs: 25,
    })).rejects.toThrow('Chat response timeout');
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(dirname(promptPath))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 325));
  });

  it('hard-times-out a run adapter that ignores AbortSignal', async () => {
    getAdapter.mockReturnValue({
      ...cliAdapter(() => ({ command: 'unused', args: [] })),
      run: () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late chat run failure')), 300);
      }),
    });

    const startedAt = Date.now();
    await expect(runChatCompletion({
      prompt: 'time out an uncooperative run adapter',
      provider: 'codex',
      timeoutMs: 25,
    })).rejects.toThrow('Chat response timeout');
    expect(Date.now() - startedAt).toBeLessThan(150);
    await new Promise((resolve) => setTimeout(resolve, 325));
  });

  it('sources the globally filtered MCP set for native chat runs', async () => {
    const safeTool = {
      type: 'function' as const,
      function: { name: 'slack__list_channels', description: '', parameters: { type: 'object' } },
    };
    resolveMcpTools.mockResolvedValueOnce([safeTool]);
    let seenTools: unknown;
    getAdapter.mockReturnValue({
      ...cliAdapter(() => ({ command: 'unused', args: [] })),
      run: async (options: { mcpTools?: unknown }) => {
        seenTools = options.mcpTools;
        return { exitCode: 0, stdout: 'done', stderr: '', durationMs: 1 };
      },
    });

    await expect(runChatCompletion({ prompt: 'inspect', provider: 'codex', timeoutMs: 5000 }))
      .resolves.toMatchObject({ response: 'done' });
    expect(resolveMcpTools).toHaveBeenCalledOnce();
    expect(seenTools).toEqual([safeTool]);
  });

  it.skipIf(process.platform === 'win32')('terminates descendant processes when the caller aborts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-chat-tree-'));
    const pidFile = join(root, 'child.pid');
    const controller = new AbortController();
    let descendantPid = 0;
    try {
      getAdapter.mockReturnValue(cliAdapter(() => ({
        command: process.execPath,
        args: [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            "const { writeFileSync } = require('node:fs')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'writeFileSync(process.argv[1], String(child.pid))',
            'setInterval(() => {}, 1000)',
          ].join(';'),
          pidFile,
        ],
      })));

      const pending = runChatCompletion({
        prompt: 'cancel the process tree',
        provider: 'codex',
        timeoutMs: 5000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      descendantPid = Number.parseInt(readFileSync(pidFile, 'utf-8'), 10);

      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow(), { timeout: 1_000 });
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Expected: the process group termination already removed it.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('terminates a detached-stdio descendant after a successful wrapper exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-chat-exit-tree-'));
    const pidFile = join(root, 'child.pid');
    let descendantPid = 0;
    try {
      getAdapter.mockReturnValue(cliAdapter(() => ({
        command: process.execPath,
        args: [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            "const { writeFileSync } = require('node:fs')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'writeFileSync(process.argv[1], String(child.pid))',
            'child.unref()',
            "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }))",
          ].join(';'),
          pidFile,
        ],
      })));

      await expect(runChatCompletion({
        prompt: 'finish and reap the process tree',
        provider: 'codex',
        timeoutMs: 5000,
      })).resolves.toMatchObject({ response: 'done' });
      descendantPid = Number.parseInt(readFileSync(pidFile, 'utf-8'), 10);
      await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow(), { timeout: 1_000 });
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Expected: normal close cleanup already removed the descendant.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
