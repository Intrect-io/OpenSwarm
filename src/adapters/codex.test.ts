import { describe, it, expect, vi } from 'vitest';
import { CodexCliAdapter, coerceCodexModel } from './codex.js';

describe('CodexCliAdapter', () => {
  const adapter = new CodexCliAdapter();

  it('builds a codex exec command with sandbox json mode', () => {
    const { command, args, stdinFile } = adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
    });

    expect(command).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    // --full-auto was deprecated in codex 0.137 → --sandbox workspace-write (INT-1699)
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('--full-auto');
    expect(args).toContain('--skip-git-repo-check');
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5-codex']);
    // Memory MCP server is registered so codex can call search_memory (INT-1855)
    expect(args.some((arg) => arg.startsWith('mcp_servers.openswarm_memory.command='))).toBe(true);
    expect(args.some((arg) => arg.startsWith('mcp_servers.openswarm_memory.args=['))).toBe(true);
    expect(stdinFile).toBe('/tmp/prompt.txt');
  });

  it('omits the memory MCP flags when memoryTools=false', () => {
    const { args } = adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
      memoryTools: false,
    });

    expect(args).toContain('exec');
    expect(args.join(' ')).not.toContain('openswarm_memory');
  });

  it('substitutes a claude model with the codex default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { args } = adapter.buildCommand({
        prompt: '/tmp/prompt.txt',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-20250514',
      });
      // Should not pass the claude model through to the codex CLI.
      expect(args).not.toContain('claude-sonnet-4-20250514');
      expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5-codex']);
      // Warning emitted at least once for this model name.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('claude-sonnet-4-20250514'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('coerceCodexModel passes OpenAI model names through unchanged', () => {
    expect(coerceCodexModel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(coerceCodexModel('o3')).toBe('o3');
    expect(coerceCodexModel('gpt-4o')).toBe('gpt-4o');
  });

  it('coerceCodexModel rewrites every claude-* variant', () => {
    expect(coerceCodexModel('claude-opus-4-6')).toBe('gpt-5-codex');
    expect(coerceCodexModel('claude-haiku-4-5-20251001')).toBe('gpt-5-codex');
    expect(coerceCodexModel('Claude-Sonnet-4')).toBe('gpt-5-codex');
  });

  it('parses worker output from codex json events', () => {
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"success\\":true,\\"summary\\":\\"Done\\",\\"filesChanged\\":[\\"src/a.ts\\"],\\"commands\\":[\\"npm test\\"]}\\n```"}}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    const result = adapter.parseWorkerOutput(raw);
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Done');
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(result.commands).toEqual(['npm test']);
  });

  it('captures actually-executed commands even when the model self-reports none', () => {
    // The common failure mode: worker edits code and runs checks, but its JSON
    // report has commands:[] — the validation gate then bounces it and reviewers
    // reject on "report the verification command". Ground-truth command_execution
    // events must backfill commands. (unwraps codex's /bin/zsh -lc '<cmd>' wrapper)
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc \'pytest tests/test_x.py\'"}}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc \'pytest tests/test_x.py\'","exit_code":0,"status":"completed"}}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc \'ruff check .\'","exit_code":0,"status":"completed"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"success\\":true,\\"summary\\":\\"Fixed\\",\\"filesChanged\\":[\\"db/x.py\\"],\\"commands\\":[]}\\n```"}}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    const result = adapter.parseWorkerOutput(raw);
    expect(result.success).toBe(true);
    // Deduped, unwrapped, from the real executions — not the empty self-report.
    expect(result.commands).toEqual(['pytest tests/test_x.py', 'ruff check .']);
  });

  it('parses reviewer output from codex json events', () => {
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"decision\\":\\"revise\\",\\"feedback\\":\\"Fix tests\\",\\"issues\\":[\\"Missing test\\"],\\"suggestions\\":[\\"Add unit test\\"]}\\n```"}}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    const result = adapter.parseReviewerOutput(raw);
    expect(result.decision).toBe('revise');
    expect(result.feedback).toBe('Fix tests');
    expect(result.issues).toEqual(['Missing test']);
    expect(result.suggestions).toEqual(['Add unit test']);
  });

  it('rejects reasoning-only reviewer output instead of fabricating REVISE', () => {
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"Summarizing findings"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    expect(() => adapter.parseReviewerOutput(raw)).toThrow('Reviewer output was empty');
  });

  it('streams agent messages into live log lines', () => {
    const logs: string[] = [];
    const remainder = adapter.parseStreamingChunk?.([
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"Checking repository state"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"## Plan\\n- first step\\n\\nDone"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n'), (line) => logs.push(line));

    expect(remainder).toBe('');
    expect(logs).toEqual([
      '───',
      'Codex turn started',
      '▸ Checking repository state',
      '',
      '■ Plan',
      '  - first step',
      '',
      'Done',
      'Codex turn completed',
    ]);
  });

  it('preserves partial codex json chunks until complete', () => {
    const logs: string[] = [];
    const chunk1 = '{"type":"item.completed","item":{"type":"agent_message","text":"Hello';
    const chunk2 = ' world"}}\n';

    const remainder1 = adapter.parseStreamingChunk?.(chunk1, (line) => logs.push(line));
    const remainder2 = adapter.parseStreamingChunk?.(chunk2, (line) => logs.push(line), remainder1);

    expect(remainder1).toBe(chunk1);
    expect(remainder2).toBe('');
    expect(logs).toEqual(['Hello world']);
  });
});

describe('CodexCliAdapter read-only mode (INT-3189)', () => {
  const adapter = new CodexCliAdapter();

  it('drops to the read-only sandbox policy and unregisters memory', () => {
    const { args } = adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
      readOnly: true,
    });

    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2))
      .toEqual(['--sandbox', 'read-only']);
    expect(args).not.toContain('workspace-write');
    expect(args.join(' ')).not.toContain('openswarm_memory');
  });

  it('declares that it enforces read-only, so spawnCli does not refuse it', () => {
    expect(adapter.capabilities.enforcesReadOnly).toBe(true);
  });
});
