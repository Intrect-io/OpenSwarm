import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseServerSpec,
  addServer,
  removeServer,
  formatServerList,
  runMcpCommand,
  readMcpJson,
  type McpJson,
} from './mcpCommand.js';

describe('parseServerSpec (INT-1953)', () => {
  it('maps --preset to a preset spec', () => {
    expect(parseServerSpec(undefined, [], 'linear')).toEqual({ preset: 'linear' });
  });
  it('maps an http(s) target to a url spec', () => {
    expect(parseServerSpec('https://x/mcp', [])).toEqual({ url: 'https://x/mcp' });
  });
  it('maps a command + args to a stdio spec', () => {
    expect(parseServerSpec('npx', ['-y', 'srv'])).toEqual({ command: 'npx', args: ['-y', 'srv'] });
  });
  it('omits empty args', () => {
    expect(parseServerSpec('mybin', [])).toEqual({ command: 'mybin' });
  });
  it('throws when nothing usable is given', () => {
    expect(() => parseServerSpec(undefined, [])).toThrow();
  });
  it('rejects an unknown preset name before persistence (AGT-3442)', () => {
    expect(() => parseServerSpec(undefined, [], 'not-a-real-preset')).toThrow(/unknown preset/);
  });
  it('rejects a malformed http(s) URL before persistence (AGT-3442)', () => {
    expect(() => parseServerSpec('https://exa mple.com/mcp', [])).toThrow(/invalid server URL/);
  });
  it('does not write the registry when add validation fails (AGT-3442)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcmd-'));
    const path = join(dir, 'mcp.json');
    try {
      expect(() =>
        runMcpCommand('add', 'bad', ['https://exa mple.com/mcp'], { path }),
      ).toThrow(/invalid server URL/);
      expect(existsSync(path)).toBe(false);
      expect(() =>
        runMcpCommand('add', 'bad', [], { preset: 'not-a-real-preset', path }),
      ).toThrow(/unknown preset/);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('addServer / removeServer / formatServerList', () => {
  const base: McpJson = { mcpServers: { a: { command: 'x' } } };

  it('adds and removes without mutating the input', () => {
    const added = addServer(base, 'b', { preset: 'linear' });
    expect(Object.keys(added.mcpServers)).toEqual(['a', 'b']);
    expect(Object.keys(base.mcpServers)).toEqual(['a']); // pure

    const removed = removeServer(added, 'a');
    expect(Object.keys(removed.mcpServers)).toEqual(['b']);
  });

  it('formats presets, urls, and commands distinctly', () => {
    const out = formatServerList({
      mcpServers: { p: { preset: 'linear' }, r: { url: 'https://u/mcp' }, c: { command: 'npx', args: ['-y', 's'] } },
    });
    expect(out).toContain('p — preset:linear');
    expect(out).toContain('r — https://u/mcp');
    expect(out).toContain('c — npx -y s');
  });

  it('lists nothing helpfully when empty', () => {
    expect(formatServerList({ mcpServers: {} })).toMatch(/No MCP servers configured/);
  });
});

describe('runMcpCommand round-trip (INT-1953)', () => {
  it('add → list → remove against a temp mcp.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcmd-'));
    const path = join(dir, 'mcp.json');
    try {
      expect(runMcpCommand('add', 'linear', [], { preset: 'linear', path })).toMatch(/Added MCP server "linear"/);
      expect(readMcpJson(path).mcpServers.linear).toEqual({ preset: 'linear' });

      expect(runMcpCommand('list', undefined, [], { path })).toContain('linear — preset:linear');

      expect(runMcpCommand('remove', 'linear', [], { path })).toMatch(/Removed MCP server "linear"/);
      expect(readMcpJson(path).mcpServers.linear).toBeUndefined();
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('mcpServers');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the registry is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcmd-'));
    const path = join(dir, 'mcp.json');
    try {
      writeFileSync(path, '{broken');
      expect(() => readMcpJson(path)).toThrow(/MCP registry is malformed/);
      expect(() => runMcpCommand('add', 'linear', [], { preset: 'linear', path })).toThrow(/malformed/);
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove of an unknown server is a no-op message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcmd-'));
    try {
      expect(runMcpCommand('remove', 'ghost', [], { path: join(dir, 'mcp.json') })).toMatch(/No MCP server named/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown action', () => {
    expect(() => runMcpCommand('frobnicate', undefined, [], { path: join(tmpdir(), 'nope.json') })).toThrow(/Unknown mcp action/);
  });
});
