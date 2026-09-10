// ============================================
// OpenSwarm - `openswarm mcp add|list|remove` (INT-1953)
// ============================================
//
// Manage MCP servers in ~/.openswarm/mcp.json from the CLI instead of editing
// the JSON by hand. The mutation helpers are pure (registry in → registry out)
// so routing is unit-tested; runMcpCommand is the thin read→mutate→write shell.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '../core/types.js';
import { BUILTIN_MCP_SERVERS } from '../mcp/mcpClient.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { z } from 'zod';

export const MCP_JSON_PATH = join(homedir(), '.openswarm', 'mcp.json');

export interface McpJson {
  mcpServers: Record<string, McpServerConfig>;
}

const McpServerSchema = z.union([
  z.object({ preset: z.string().min(1), command: z.undefined().optional(), url: z.undefined().optional(), args: z.undefined().optional() }).strict(),
  z.object({ url: z.string().url().refine((url) => /^https?:\/\//.test(url), 'URL must use HTTP(S)'), preset: z.undefined().optional(), command: z.undefined().optional(), args: z.undefined().optional() }).strict(),
  z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), preset: z.undefined().optional(), url: z.undefined().optional() }).strict(),
]);
const McpJsonSchema = z.object({ mcpServers: z.record(z.string().min(1), McpServerSchema) }).strict();

export function readMcpJson(path = MCP_JSON_PATH): McpJson {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    return McpJsonSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as McpJson;
  } catch (error) {
    throw new Error(`MCP registry is malformed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeMcpJson(json: McpJson, path = MCP_JSON_PATH): void {
  atomicWriteFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * Turn `add` arguments into a server spec: a `--preset`, an http(s) URL (remote),
 * or a command + args (stdio).
 */
export function parseServerSpec(target: string | undefined, args: string[], preset?: string): McpServerConfig {
  if (preset) {
    if (!BUILTIN_MCP_SERVERS[preset]) {
      const known = Object.keys(BUILTIN_MCP_SERVERS).join(', ');
      throw new Error(`mcp add: unknown preset "${preset}" (known: ${known})`);
    }
    return McpServerSchema.parse({ preset }) as McpServerConfig;
  }
  if (target && /^https?:\/\//.test(target)) {
    // Validate the URL is well-formed before it is persisted to the registry.
    const parsed = McpServerSchema.safeParse({ url: target });
    if (!parsed.success) {
      throw new Error(`mcp add: invalid server URL "${target}": ${parsed.error.issues[0]?.message ?? 'malformed'}`);
    }
    return parsed.data as McpServerConfig;
  }
  if (target) {
    const parsed = McpServerSchema.safeParse({
      command: target,
      ...(args.length ? { args } : {}),
    });
    if (!parsed.success) {
      throw new Error(`mcp add: invalid command spec: ${parsed.error.issues[0]?.message ?? 'malformed'}`);
    }
    return parsed.data as McpServerConfig;
  }
  throw new Error('mcp add: provide a --preset, a URL, or a command');
}

export function addServer(json: McpJson, name: string, spec: McpServerConfig): McpJson {
  if (!name.trim()) throw new Error('mcp add: a non-empty server name is required');
  return { mcpServers: { ...json.mcpServers, [name]: spec } };
}

export function removeServer(json: McpJson, name: string): McpJson {
  const next = { ...json.mcpServers };
  delete next[name];
  return { mcpServers: next };
}

export function formatServerList(json: McpJson): string {
  const names = Object.keys(json.mcpServers);
  if (!names.length) {
    const presets = Object.keys(BUILTIN_MCP_SERVERS).join(', ');
    return `No MCP servers configured. Add one with \`openswarm mcp add <name> --preset <${presets}>\` or a command/URL.`;
  }
  return names
    .map((n) => {
      const s = json.mcpServers[n];
      const detail = s.preset
        ? `preset:${s.preset}`
        : s.url
          ? s.url
          : `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
      return `  ${n} — ${detail}`;
    })
    .join('\n');
}

export interface McpCommandOptions {
  preset?: string;
  path?: string;
}

/** Thin I/O shell: read mcp.json → mutate → write. Returns the message to print. */
export function runMcpCommand(
  action: string,
  name: string | undefined,
  args: string[],
  opts: McpCommandOptions = {},
): string {
  const path = opts.path ?? MCP_JSON_PATH;
  const json = readMcpJson(path);

  switch (action) {
    case 'list':
      return formatServerList(json);

    case 'add': {
      if (!name) throw new Error('mcp add: a server name is required');
      const spec = parseServerSpec(args[0], args.slice(1), opts.preset);
      writeMcpJson(addServer(json, name, spec), path);
      return `Added MCP server "${name}". It is now available to the worker/CLI.`;
    }

    case 'remove': {
      if (!name) throw new Error('mcp remove: a server name is required');
      if (!json.mcpServers[name]) return `No MCP server named "${name}".`;
      writeMcpJson(removeServer(json, name), path);
      return `Removed MCP server "${name}".`;
    }

    default:
      throw new Error(`Unknown mcp action "${action}" (use add|list|remove)`);
  }
}
