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
