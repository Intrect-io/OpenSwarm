import { describe, it, expect, vi } from 'vitest';
import { ClaudeCliAdapter } from './claude.js';

describe('ClaudeCliAdapter.buildCommand', () => {
  it('wires the memory MCP server via --mcp-config and keeps bypass permissions', () => {
    const { command, args, stdinFile } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
    });
    expect(command).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/mcp\.json$/);
    expect(stdinFile).toBe('/tmp/prompt.txt');
  });

  it('omits the memory MCP config when memoryTools=false', () => {
    const { command, args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      memoryTools: false,
    });

    expect(command).toBe('claude');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });
});

describe('ClaudeCliAdapter.buildCommand model pinning (INT-2509)', () => {
  it('pins --model to the adapter default when the caller omits model', () => {
    // Omitting --model would run the user's PERSONAL default (can be the most
    // expensive tier) — the planner path hits this because it drops claude-* ids.
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
  });

  it('keeps an explicit model', () => {
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'opus',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(args).not.toContain('sonnet');
  });

  it('keeps model metacharacters inside one argv element', () => {
    const { args } = new ClaudeCliAdapter().buildCommand({ prompt: '/tmp/prompt.txt', cwd: '/tmp', model: 'sonnet; touch /tmp/pwned' });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet; touch /tmp/pwned');
  });
});

describe('ClaudeCliAdapter read-only mode (INT-3189)', () => {
  it('drops bypassPermissions for an allowlist of inspection tools', () => {
    // bypassPermissions is what grants Write and Bash, so a read-only run that
    // kept it would deny nothing. `-p` has no one to prompt, so anything outside
    // --allowedTools is refused outright.
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      readOnly: true,
    });

    expect(args).not.toContain('bypassPermissions');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2))
      .toEqual(['--permission-mode', 'default']);
    const start = args.indexOf('--allowedTools') + 1;
    const end = args.findIndex((arg, i) => i >= start && arg.startsWith('--'));
    const allowed = args.slice(start, end === -1 ? undefined : end);
    expect(allowed).toEqual(['Read', 'Grep', 'Glob']);
    // Task would spawn a subagent whose toolset this flag never reaches.
    expect(allowed).not.toContain('Task');
    expect(allowed.some((tool) => /Write|Edit|Bash|Web/.test(tool))).toBe(false);
  });

  it('does not register the memory MCP server in a read-only run', () => {
    // It exposes writes, and every call would be denied by the allowlist anyway.
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      readOnly: true,
    });

    expect(args).not.toContain('--mcp-config');
  });

  it('declares that it enforces read-only, so spawnCli does not refuse it', () => {
    expect(new ClaudeCliAdapter().capabilities.enforcesReadOnly).toBe(true);
  });
});

describe('ClaudeCliAdapter setting isolation', () => {
  const build = (extra: Record<string, unknown> = {}, baseEnv: NodeJS.ProcessEnv = { HOME: '/nonexistent-home' }) =>
    new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      memoryTools: false,
      baseEnv,
      ...extra,
    });
  const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('keeps the operator\'s user settings out of a worker run and forbids AskUserQuestion', () => {
    const { args } = build();
    expect(valueOf(args, '--setting-sources')).toBe('project,local');
    expect(valueOf(args, '--disallowedTools')).toBe('AskUserQuestion');
    expect(args).not.toContain('--bare');
  });

  it('loads no settings at all in a read-only run (the reviewed repo is untrusted)', () => {
    const { args } = build({ readOnly: true });
    expect(args).toContain('--setting-sources');
    expect(valueOf(args, '--setting-sources')).toBe('');
    expect(args).not.toContain('--bare');
    // The allowlist already excludes AskUserQuestion.
    expect(args).not.toContain('--disallowedTools');
  });

  it('restores the inherited behaviour when the daemon sets OPENSWARM_CLAUDE_INHERIT_USER_SETTINGS=1', () => {
    vi.stubEnv('OPENSWARM_CLAUDE_INHERIT_USER_SETTINGS', '1');
    try {
      // The child's allowlisted baseEnv does not carry the switch; the daemon's env does.
      const { args, env } = build({}, { HOME: '/nonexistent-home' });
      expect(args).not.toContain('--setting-sources');
      expect(args).toContain('--disallowedTools');
      expect(env && Object.values(env).every((v) => v === undefined)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores the switch when it appears only in the child baseEnv', () => {
    const { args } = build({}, { HOME: '/nonexistent-home', OPENSWARM_CLAUDE_INHERIT_USER_SETTINGS: '1' });
    expect(args).toContain('--setting-sources');
  });

  it('strips parent Claude Code session variables from the child env', () => {
    const { env } = build({}, {
      HOME: '/nonexistent-home',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
    });
    expect(env).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDECODE')).toBe(true);
    expect(env?.CLAUDECODE).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CODE_MESSAGING_SOCKET')).toBe(true);
    expect(env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });
});

describe('ClaudeCliAdapter diagnostics stay off stdout', () => {
  it('logs reviewer cost to stderr so `review --json` stdout stays pure JSON', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stdout = `${JSON.stringify({ type: 'result', subtype: 'success', result: '{"decision":"approve","feedback":"ok"}', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } })}\n`;
      const review = new ClaudeCliAdapter().parseReviewerOutput({ exitCode: 0, stdout, stderr: '', durationMs: 1 });
      expect(review.decision).toBe('approve');
      expect(log).not.toHaveBeenCalled();
      expect(err.mock.calls.some(([m]) => String(m).includes('[Reviewer] Cost'))).toBe(true);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe('ClaudeCliAdapter observed execution evidence (AGT-4900)', () => {
  const use = (id: string, name: string, input: object) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: string, isError: boolean) =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  const final = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', result: text });
  const parse = (stdout: string) => new ClaudeCliAdapter().parseWorkerOutput({ exitCode: 0, stdout, stderr: '', durationMs: 1 });

  it('pairs Bash tool_use with its tool_result exit status', () => {
    const parsed = parse([
      use('t1', 'Bash', { command: 'npm test' }), result('t1', 'Exit code 1\n2 failed', true),
      use('t2', 'Bash', { command: 'npm test' }), result('t2', 'Tests 3 passed', false),
      use('t3', 'Bash', { command: 'npm run lint' }), result('t3', 'Exit code 2\nerror', true),
      use('t4', 'Bash', { command: 'rm -rf /' }), result('t4', '<tool_use_error>Harness rule</tool_use_error>', true),
      use('t5', 'Bash', { command: 'npm run dev', run_in_background: true }), result('t5', 'Started in background', false),
      use('t6', 'Read', { file_path: 'a.ts' }), result('t6', 'content', false),
      use('t7', 'Bash', { command: 'npm run build' }),
      final('All tests pass.\nRan: npm test -> exit 0, 3 passed, 0 failed'),
    ].join('\n'));
    // Refused (t4) and unanswered (t7) calls never ran; t5 has no known exit.
    expect(parsed.executedCommands).toEqual(['npm test [exit 1]', 'npm test', 'npm run lint [exit 2]', 'npm run dev [exit ?]']);
  });

  it('leaves executedCommands unset for plain-text or truncated output', () => {
    expect(parse('All tests pass.').executedCommands).toBeUndefined();
    expect(parse(`[openswarm: 9 earlier characters of output were not retained]\n${final('done')}`).executedCommands).toBeUndefined();
  });
});
