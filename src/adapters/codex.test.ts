import { describe, it, expect, vi } from 'vitest';
import { CodexCliAdapter, coerceCodexModel } from './codex.js';

describe('CodexCliAdapter', () => {
  const adapter = new CodexCliAdapter(async () => []);

  it('builds a codex exec command with sandbox json mode', async () => {
    const { command, args, stdinFile } = await adapter.buildCommand({
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
    const memoryName = args
      .find((arg) => /^mcp_servers\.openswarm_memory_[a-f0-9]{32}\.command=/.test(arg))
      ?.match(/^mcp_servers\.(openswarm_memory_[a-f0-9]{32})\.command=/)?.[1];
    expect(memoryName).toBeDefined();
    expect(args.some((arg) => arg.startsWith(`mcp_servers.${memoryName}.args=[`))).toBe(true);
    expect(args).toContain(`mcp_servers.${memoryName}.enabled=true`);
    expect(stdinFile).toBe('/tmp/prompt.txt');
  });

  it('omits the memory MCP flags when memoryTools=false', async () => {
    const { args } = await adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
      memoryTools: false,
    });

    expect(args).toContain('exec');
    expect(args.join(' ')).not.toContain('openswarm_memory');
  });

  it('switches off inherited MCP servers before adding its own server (AGT-3990)', async () => {
    const isolated = new CodexCliAdapter(async (_env, cwd) => {
      expect(cwd).toBe('/tmp/project');
      return ['-c', 'mcp_servers.linear.enabled=false'];
    });
    const { args } = await isolated.buildCommand({ prompt: '/tmp/prompt.txt', cwd: '/tmp/project' });
    expect(args.join(' ')).toContain('mcp_servers.linear.enabled=false');
    // OpenSwarm's own server is still registered — isolation, not a blanket ban.
    expect(args.join(' ')).toContain('openswarm_memory_');
  });

  it('substitutes a claude model with the codex default and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { args } = await adapter.buildCommand({
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
  const adapter = new CodexCliAdapter(async () => []);

  it('drops to the read-only sandbox policy and unregisters memory', async () => {
    const { args } = await adapter.buildCommand({
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


describe('CodexCliAdapter reviewer verdict loss (INT-3914)', () => {
  const adapter = new CodexCliAdapter(async () => []);

  // Event shapes below are verbatim from a live `codex exec --json --sandbox
  // read-only` run of the real reviewer prompt (codex-cli 0.148.0).
  const NARRATION =
    '{"type":"item.completed","item":{"type":"agent_message","text":'
    + '"실제 저장소의 diff와 관련 파일을 확인한 뒤 결론을 내리겠습니다."}}';
  const TODO_LIST =
    '{"type":"item.completed","item":{"id":"item_1","type":"todo_list","items":'
    + '[{"text":"diff 확인","completed":true},{"text":"판정 제공","completed":true}]}}';
  const VERDICT =
    '{"type":"item.completed","item":{"type":"agent_message","text":'
    + '"{\\"decision\\":\\"approve\\",\\"feedback\\":\\"Coherent and well-tested.\\"}"}}';

  const stream = (...lines: string[]) => ({
    exitCode: 0,
    stdout: ['{"type":"thread.started","thread_id":"1"}', '{"type":"turn.started"}', ...lines,
      '{"type":"turn.completed"}'].join('\n'),
    stderr: '',
    durationMs: 1,
  });

  it('throws when the turn ends without a verdict message, instead of quoting the narration', () => {
    // The turn ended on a todo_list, so the last agent_message is still the
    // reviewer's opening line. That line used to become `Decision: REVISE` with
    // the narration as its feedback — nine consecutive times on PRs whose real
    // conclusion was approve.
    expect(() => adapter.parseReviewerOutput(stream(NARRATION, TODO_LIST)))
      .toThrow(/carried no verdict/);
  });

  it('does not treat a trailing todo_list as a conclusion on its own', () => {
    expect(() => adapter.parseReviewerOutput(stream(TODO_LIST))).toThrow(/Reviewer output was empty/);
  });

  it('still parses the verdict when the reviewer narrates first and concludes after', () => {
    // The normal shape, measured in the same probe: narration, tool calls, then
    // the JSON verdict as the final message. Must stay unaffected.
    const result = adapter.parseReviewerOutput(stream(NARRATION, TODO_LIST, VERDICT));
    expect(result.decision).toBe('approve');
    expect(result.feedback).toBe('Coherent and well-tested.');
  });

  it('finds the verdict even when the reviewer signs off after delivering it', () => {
    // Refusing to invent a verdict means a trailing pleasantry would otherwise
    // discard a conclusion the reviewer actually reached. Scan backwards.
    const SIGN_OFF =
      '{"type":"item.completed","item":{"type":"agent_message","text":'
      + '"Let me know if you want me to dig into the test coverage further."}}';
    const result = adapter.parseReviewerOutput(stream(NARRATION, VERDICT, SIGN_OFF));
    expect(result.decision).toBe('approve');
    expect(result.feedback).toBe('Coherent and well-tested.');
  });

  it('reports the LAST message\'s failure, not an earlier one', () => {
    // The two messages fail for different reasons, so the message proves which
    // one was reported: the final narration yields "carried no verdict", while
    // the earlier one is rejected by the stricter JSON-only bar.
    const DECLARED_NO_FINDINGS =
      '{"type":"item.completed","item":{"type":"agent_message","text":"Decision: revise"}}';
    const CLOSING =
      '{"type":"item.completed","item":{"type":"agent_message","text":"계속 확인하겠습니다."}}';
    expect(() => adapter.parseReviewerOutput(stream(DECLARED_NO_FINDINGS, CLOSING)))
      .toThrow(/carried no verdict/);
  });

  it('does not accept a verdict-shaped sentence from a non-final message', () => {
    // A truncated turn can leave mid-stream prose that matches the verdict
    // regex. Honouring it would ship a silent APPROVE through a merge gate —
    // strictly worse than the noisy REVISE this change removes.
    const THINKING_ALOUD =
      '{"type":"item.completed","item":{"type":"agent_message","text":'
      + '"My decision: approve, pending one final check of the test suite."}}';
    const CLOSING =
      '{"type":"item.completed","item":{"type":"agent_message","text":"이어서 확인하겠습니다."}}';
    expect(() => adapter.parseReviewerOutput(stream(THINKING_ALOUD, CLOSING)))
      .toThrow(/carried no verdict/);
  });

  it('still accepts a JSON verdict from a non-final message', () => {
    // JSON is the shape a reviewer only emits when reporting a result, so the
    // sign-off case keeps working.
    const CLOSING =
      '{"type":"item.completed","item":{"type":"agent_message","text":"Happy to dig further if useful."}}';
    const result = adapter.parseReviewerOutput(stream(NARRATION, VERDICT, CLOSING));
    expect(result.decision).toBe('approve');
  });
});
