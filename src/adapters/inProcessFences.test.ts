// ============================================
// OpenSwarm - In-process worker fences (AGT-4444)
// The delegated CLI adapters cannot enforce protectedFiles or
// forbidPublication; the in-process agentic loop must. This drives the loop
// with a scripted model and proves both fences refuse before touching disk
// or running the command.
// ============================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';

const toolCallResp = (id: string, name: string, args: object) => ({
  choices: [{
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: 'tool_calls',
  }],
});
const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

describe('in-process loop fences (AGT-4444)', () => {
  let dir: string;
  const savedSessionLog = process.env.OPENSWARM_SESSION_LOG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-fences-'));
    process.env.OPENSWARM_SESSION_LOG = '0';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedSessionLog === undefined) delete process.env.OPENSWARM_SESSION_LOG;
    else process.env.OPENSWARM_SESSION_LOG = savedSessionLog;
  });

  it('refuses a protectedFiles edit and a publication command under forbidPublication', async () => {
    const guard = join(dir, 'run_tests.sh');
    writeFileSync(guard, '#!/bin/sh\nexit 1\n');
    const marker = join(dir, 'published');
    const script = [
      toolCallResp('c1', 'write_file', { path: 'run_tests.sh', content: '#!/bin/sh\nexit 0\n' }),
      toolCallResp('c2', 'bash', { command: `touch ${marker} && git push origin HEAD` }),
      finalResp('done'),
    ];
    const seen: ChatMessage[][] = [];
    const callApi = async (messages: ChatMessage[]) => {
      seen.push(messages.map((m) => ({ ...m })));
      return script[Math.min(seen.length - 1, script.length - 1)] as never;
    };

    await runAgenticLoop({
      prompt: 'make the tests pass', cwd: dir, model: 'test', callApi,
      maxTurns: 5, webTools: false, nudgeMaxOnNoEdit: 0,
      protectedFiles: [guard], forbidPublication: true,
    });

    const toolReplies = seen.at(-1)!.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolReplies.some((c) => c.startsWith('PROTECTED: run_tests.sh'))).toBe(true);
    expect(toolReplies.some((c) => c.startsWith('PUBLICATION_FENCED:'))).toBe(true);
    // Neither refusal let anything through: the harness is untouched and the
    // fenced command never ran (the touch before the push would have landed).
    expect(readFileSync(guard, 'utf8')).toBe('#!/bin/sh\nexit 1\n');
    expect(() => readFileSync(marker)).toThrow();
  }, 30_000);
});
