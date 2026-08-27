import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../adapters/types.js';

const getAdapter = vi.hoisted(() => vi.fn());

vi.mock('../adapters/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/index.js')>();
  return { ...actual, getAdapter };
});

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
    let promptPath = '';
    getAdapter.mockReturnValue(cliAdapter((options) => {
      promptPath = options.prompt;
      return { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
    }));
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runChatCompletion({
      prompt: 'cancel me',
      provider: 'codex',
      timeoutMs: 5000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(dirname(promptPath))).toBe(false);
  });
});
