import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_MODEL_ALIASES,
  buildRepoContext,
  curatedModels,
  getDefaultChatModel,
  inferProviderFromModel,
} from './chatBackend.js';

describe('curatedModels (INT-1961)', () => {
  it('includes the provider default first and dedupes', () => {
    const m = curatedModels('openrouter');
    expect(m[0]).toBe(getDefaultChatModel('openrouter'));
    expect(new Set(m).size).toBe(m.length); // no dupes
    expect(m.length).toBeGreaterThan(1); // alias-derived options present
  });

  it('always yields at least the default for every provider', () => {
    for (const p of ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'claude'] as const) {
      const m = curatedModels(p);
      expect(m).toContain(getDefaultChatModel(p));
    }
  });

  it('returns the claude adapter default (not a Codex model) for provider claude (INT-3284)', () => {
    expect(getDefaultChatModel('claude')).toBe('sonnet');
    expect(getDefaultChatModel('claude')).not.toMatch(/codex|gpt-/);
    expect(curatedModels('claude')[0]).toBe('sonnet');
  });

  it('maps Codex Responses aliases to the GPT-5.6 capability tiers', () => {
    expect(getDefaultChatModel('codex-responses')).toBe('gpt-5.6-terra');
    expect(CHAT_MODEL_ALIASES['codex-responses']).toEqual(expect.objectContaining({
      big: 'gpt-5.6-sol',
      medium: 'gpt-5.6-terra',
      small: 'gpt-5.6-luna',
    }));
  });

  it('infers codex-responses for bare GPT-5.6 tier slugs', () => {
    for (const tier of ['sol', 'terra', 'luna']) {
      expect(inferProviderFromModel(`gpt-5.6-${tier}`)).toBe('codex-responses');
    }
  });
});

describe('buildRepoContext (INT-2005)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-repoctx-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the repo name and absolute cwd path', () => {
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('## Repository context');
    expect(ctx).toContain(`(${dir})`);
    // basename of the temp dir is the repo label
    expect(ctx).toContain(`repo: ${dir.split('/').pop()}`);
  });

  it('injects AGENTS.md project rules when present', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# House rules\nAlways write English comments.');
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('## Project rules (AGENTS.md)');
    expect(ctx).toContain('Always write English comments.');
  });

  it('prefers AGENTS.md over CLAUDE.md (first match wins)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents-rules-marker');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude-rules-marker');
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('agents-rules-marker');
    expect(ctx).not.toContain('claude-rules-marker');
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude-only-marker');
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('## Project rules (CLAUDE.md)');
    expect(ctx).toContain('claude-only-marker');
  });

  it('truncates an over-long rules file', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(5000));
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('… (truncated');
    expect(ctx.length).toBeLessThan(5000);
  });

  it('includes the git branch inside a real repo', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
    git('init', '-q', '-b', 'feature-xyz');
    git('commit', '--allow-empty', '-q', '-m', 'init'); // rev-parse HEAD needs a commit
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain('branch: feature-xyz');
  });

  it('omits the branch line for a non-git directory', () => {
    const ctx = buildRepoContext(dir);
    expect(ctx).not.toContain('branch:');
  });

  it('returns empty string for a non-existent cwd', () => {
    expect(buildRepoContext(join(dir, 'does-not-exist'))).toBe('');
  });
});
