// ============================================
// OpenSwarm — Memory MCP wiring for CLI-delegated adapters
// ============================================
//
// Builds the launch spec + per-CLI config that points `codex exec` and
// `claude -p` at the OpenSwarm memory MCP server (src/mcp/memoryServer.ts), so
// those adapters get an on-demand `search_memory` tool. The native agentic loop
// has the tool in-process and does not use this.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** MCP server name both CLIs register the memory server under. */
export const MEMORY_MCP_NAME = 'openswarm_memory';

/** Absolute path to the built MCP memory server entry (dist/mcp/memoryServer.js). */
export function memoryServerPath(): string {
  // this file at runtime: dist/adapters/memoryMcp.js → ../mcp/memoryServer.js
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'memoryServer.js');
}

/** How to launch the memory server: the current Node binary running the entry. */
export function memoryServerLaunch(): { command: string; args: string[] } {
  return { command: process.execPath, args: [memoryServerPath()] };
}

/**
 * Write a temporary MCP config JSON for `claude -p --mcp-config`. Returns the
 * file path. `claude` is already invoked with `--permission-mode
 * bypassPermissions`, so the MCP tool is auto-allowed.
 */
export function writeClaudeMcpConfig(): string {
  const { command, args } = memoryServerLaunch();
  const cfg = { mcpServers: { [MEMORY_MCP_NAME]: { command, args } } };
  const dir = mkdtempSync(join(tmpdir(), 'osw-mcp-'));
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify(cfg), 'utf-8');
  return file;
}

/**
 * Shell-ready `-c` config overrides registering the memory server for
 * `codex exec` (TOML dotted paths; values are TOML literals — JSON quoting works).
 */
export function codexMcpConfigFlags(): string {
  const args = codexMcpConfigArgs();
  const flags: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    flags.push(`-c '${args[i + 1].replaceAll("'", "'\\''")}'`);
  }
  return flags.join(' ');
}

/** Argv-safe config overrides for codex exec. */
export function codexMcpConfigArgs(serverName: string = MEMORY_MCP_NAME): string[] {
  const { command, args } = memoryServerLaunch();
  const argsToml = '[' + args.map((a) => JSON.stringify(a)).join(', ') + ']';
  const overrides = [
    `mcp_servers.${serverName}.command=${JSON.stringify(command)}`,
    `mcp_servers.${serverName}.args=${argsToml}`,
    // The inherited-server isolation pass may have disabled a colliding
    // `openswarm_memory` entry. Re-enable the server OpenSwarm defines here.
    `mcp_servers.${serverName}.enabled=true`,
  ];
  return overrides.flatMap((override) => ['-c', override]);
}
