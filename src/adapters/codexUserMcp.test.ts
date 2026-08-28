import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  configuredCodexMcpServerNames,
  codexUserMcpDisableArgs,
  runCodexMcpListJson,
  type CodexMcpListRunner,
} from './codexUserMcp.js';
import { codexMcpConfigArgs } from './memoryMcp.js';

describe('codex inherited MCP isolation (AGT-3990)', () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });
  const listing = (...names: string[]): CodexMcpListRunner => vi.fn(async () => JSON.stringify(
    names.map((name) => ({ name, enabled: true, transport: { type: 'stdio', command: 'fixture' } })),
  ));

  it('uses the effective Codex list and returns deterministic unique names', async () => {
    const run = listing(' project-server ', 'home-server', ' project-server ');
    await expect(configuredCodexMcpServerNames('/repo', env(), run)).resolves
      .toEqual([' project-server ', 'home-server']);
    expect(run).toHaveBeenCalledWith('/repo', env(), undefined);
  });

  it('disables servers regardless of the TOML form and disables the plugin feature', async () => {
    // `codex mcp list --json` has already merged table headers, dotted keys,
    // inline tables, and project layers. The sibling feature flag disables the
    // separate plugin surface so plugin-provided MCP cannot bypass this list.
    await expect(codexUserMcpDisableArgs(env(), '/repo', listing('inline_server'))).resolves.toEqual([
      '--disable',
      'plugins',
      '-c',
      'mcp_servers={inline_server={enabled=false}}',
    ]);
  });

  it('quotes non-bare TOML server names', async () => {
    await expect(codexUserMcpDisableArgs(env(), '/repo', listing('my.server'))).resolves.toEqual([
      '--disable',
      'plugins',
      '-c',
      'mcp_servers={"my.server"={enabled=false}}',
    ]);
  });

  it('returns no overrides when no inherited servers exist', async () => {
    await expect(codexUserMcpDisableArgs(env(), '/repo', listing())).resolves
      .toEqual(['--disable', 'plugins']);
  });

  it('fails closed when effective configuration cannot be enumerated', async () => {
    const run: CodexMcpListRunner = async () => {
      throw new Error('unknown subcommand mcp');
    };
    await expect(codexUserMcpDisableArgs(env(), '/repo', run)).rejects.toThrow(
      /Unable to enumerate inherited Codex MCP servers.*unknown subcommand mcp/,
    );
  });

  it('preserves the enclosing adapter timeout instead of relabeling it as an MCP failure', async () => {
    const controller = new AbortController();
    const timeout = new Error('codex timeout after 25ms');
    const pending = configuredCodexMcpServerNames('/repo', env(), (_cwd, _env, signal) => (
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      })
    ), controller.signal);

    controller.abort(timeout);

    await expect(pending).rejects.toBe(timeout);
  });

  it('fails closed when Codex returns malformed JSON', async () => {
    await expect(codexUserMcpDisableArgs(env(), '/repo', async () => 'not json')).rejects.toThrow(
      /Unable to enumerate inherited Codex MCP servers/,
    );
  });

  it('rejects a valid JSON value that is not a server list', async () => {
    await expect(codexUserMcpDisableArgs(env(), '/repo', async () => '{}')).rejects.toThrow(/non-array result/);
  });

  it('fails closed when a list entry has no exact string identifier', async () => {
    await expect(codexUserMcpDisableArgs(env(), '/repo', async () => '[{"enabled":true}]')).rejects.toThrow(
      /server entry has no string name/,
    );
  });

  it('inherits servers only when the escape hatch is explicitly set', async () => {
    const run = listing('linear');
    await expect(codexUserMcpDisableArgs(
      env({ OPENSWARM_CODEX_INHERIT_MCP: '1' }),
      '/repo',
      run,
    )).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('force-kills an MCP listing process that ignores SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-mcp-timeout-'));
    const bin = join(root, 'bin');
    const executable = join(bin, 'codex');
    const pidFile = join(root, 'pid');
    try {
      mkdirSync(bin);
      writeFileSync(executable, [
        '#!/bin/sh',
        '[ -n "$MCP_WARMUP" ] && exit 0',
        'trap "" TERM',
        'echo $$ > "$MCP_PID_FILE"',
        'while :; do sleep 1; done',
        '',
      ].join('\n'));
      chmodSync(executable, 0o755);
      // macOS scans a freshly written executable on its first exec (measured
      // 200-400ms), longer than the timeout under test — the fixture would be
      // killed before it even starts. One throwaway exec warms that cache.
      execFileSync(executable, { env: { ...process.env, MCP_WARMUP: '1' } });
      const childEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        MCP_PID_FILE: pidFile,
      };

      await expect(runCodexMcpListJson(root, childEnv, undefined, 500)).rejects.toThrow(
        'codex mcp list timed out after 500ms',
      );
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number.parseInt(readFileSync(pidFile, 'utf-8'), 10);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const codexAvailable = (() => {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(codexAvailable)('Codex plugin-disable CLI contract', () => {
  it('removes installed plugins from the effective list', () => {
    const output = execFileSync('codex', ['--disable', 'plugins', 'plugin', 'list', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output) as { installed?: unknown[] };
    expect(parsed.installed).toEqual([]);
  });

  it('disables exact MCP names and re-enables OpenSwarm memory after a collision', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'openswarm-codex-contract-'));
    try {
      writeFileSync(
        join(codexHome, 'config.toml'),
        'mcp_servers = { plain = { command = "false" }, "my.server" = { command = "false" }, " " = { command = "false" }, " padded " = { command = "false" }, openswarm_memory = { command = "false" } }\n',
        'utf-8',
      );
      const childEnv = { ...process.env, CODEX_HOME: codexHome };
      const args = [...await codexUserMcpDisableArgs(childEnv, process.cwd()), ...codexMcpConfigArgs()];
      const output = execFileSync('codex', [...args, 'mcp', 'list', '--json'], {
        cwd: process.cwd(),
        env: childEnv,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const servers = JSON.parse(output) as Array<{
        name: string;
        enabled: boolean;
        transport?: { command?: string };
      }>;
      expect(servers
        .map(({ name, enabled }) => ({ name, enabled }))
        .sort((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: ' ', enabled: false },
        { name: ' padded ', enabled: false },
        { name: 'my.server', enabled: false },
        { name: 'openswarm_memory', enabled: true },
        { name: 'plain', enabled: false },
      ]);
      expect(servers.find((server) => server.name === 'openswarm_memory')?.transport?.command)
        .toBe(process.execPath);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
