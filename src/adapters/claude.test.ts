import { describe, it, expect } from 'vitest';
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
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2))
      .toEqual(['--permission-mode', 'default']);
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--model'));
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
