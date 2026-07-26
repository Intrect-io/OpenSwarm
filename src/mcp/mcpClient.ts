// ============================================
// OpenSwarm - MCP client
// ============================================
//
// Exposes any MCP server listed in ~/.openswarm/mcp.json to the agentic loop as
// tools, so chat / the pipeline can call them like native tools. Mirrors
// vega-agent pipeline/mcp_client.py: registry → transport (stdio/http/sse) →
// initMcpTools (per-server listTools, qualified name `server__tool`) →
// callMcpTool dispatch → isMcpTool. Connections are per-call (like vega's
// `async with Client`); unreachable servers degrade with a log, never crash.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '../adapters/tools.js';

/** Qualified tool name separator: `<server>__<tool>`. */
const SEP = '__';
const MCP_JSON_PATH = join(homedir(), '.openswarm', 'mcp.json');
const MCP_STDIO_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
]);
const MAX_MCP_TOOL_RESULT_CHARS = 20_000;
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_OPERATION_TIMEOUT_MS = 30_000;
const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

interface ServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Built-in MCP server presets — referenced by `{ preset: '<name>' }` in
 * config.yaml / mcp.json so common servers don't need hand-written commands.
 * `linear` gives the worker/CLI Linear access (issue read, comment, sub-issue
 * create) via the official remote MCP server. (INT-1952)
 */
export const BUILTIN_MCP_SERVERS: Record<string, ServerConfig> = {
  linear: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function stringRecordOrNull(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    out[key] = item;
  }
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isJsonSchemaObject(schema: unknown, depth = 0): schema is Record<string, unknown> {
  if (!isRecord(schema) || depth > 8) return false;
  if (schema.type !== undefined) {
    const type = schema.type;
    if (!(typeof type === 'string' || isStringArray(type))) return false;
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) return false;
    for (const value of Object.values(schema.properties)) {
      if (!isJsonSchemaObject(value, depth + 1)) return false;
    }
  }
  if (schema.required !== undefined && !isStringArray(schema.required)) return false;
  if (schema.items !== undefined) {
    const items = schema.items;
    if (Array.isArray(items)) {
      if (!items.every((item) => isJsonSchemaObject(item, depth + 1))) return false;
    } else if (!isJsonSchemaObject(items, depth + 1)) {
      return false;
    }
  }
  if (schema.additionalProperties !== undefined) {
    const additional = schema.additionalProperties;
    if (typeof additional !== 'boolean' && !isJsonSchemaObject(additional, depth + 1)) return false;
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[keyword];
    if (value !== undefined && (!Array.isArray(value) || !value.every((item) => isJsonSchemaObject(item, depth + 1)))) {
      return false;
    }
  }
  return true;
}

function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isJsonSchemaObject(schema)) return EMPTY_INPUT_SCHEMA;
  if (schema.type !== undefined && schema.type !== 'object') return EMPTY_INPUT_SCHEMA;
  return schema;
}

/** A persisted entry: `{preset}`, `{command,args,env}` (stdio) or `{url,headers,transport?}` (remote). */
function normalizeEntry(raw: unknown): ServerConfig | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.preset === 'string' && raw.preset) {
    return BUILTIN_MCP_SERVERS[raw.preset] ?? null;
  }
  if (typeof raw.command === 'string' && raw.command) {
    const args = stringArrayOrNull(raw.args);
    const env = stringRecordOrNull(raw.env);
    if (!args || env === null) return null;
    return {
      transport: 'stdio',
      command: raw.command,
      args,
      env,
    };
  }
  if (typeof raw.url === 'string' && raw.url) {
    const headers = stringRecordOrNull(raw.headers);
    if (headers === null) return null;
    const t = raw.transport === 'sse' ? 'sse' : 'http';
    return { transport: t, url: raw.url, headers };
  }
  return null;
}

/** Read ~/.openswarm/mcp.json → { serverName: ServerConfig }. */
export function loadRegistry(path = MCP_JSON_PATH): Record<string, ServerConfig> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) return {};
  const servers = parsed.mcpServers ?? {};
  const out: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = normalizeEntry(raw);
    if (cfg) out[name] = cfg;
  }
  return out;
}

/**
 * Normalize MCP servers declared in config.yaml (`mcp.servers`) into the same
 * registry shape loadRegistry produces. Invalid entries are dropped. (INT-1949)
 */
export function registryFromConfigServers(
  servers: Record<string, Record<string, unknown>> | undefined,
): Record<string, ServerConfig> {
  const out: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const cfg = normalizeEntry(raw);
    if (cfg) out[name] = cfg;
  }
  return out;
}

/**
 * The effective MCP registry = ~/.openswarm/mcp.json merged with the servers
 * declared in config.yaml. Config entries win on name collision (config.yaml is
 * the source of truth the user edits). (INT-1949)
 */
export function loadEffectiveRegistry(
  configServers?: Record<string, Record<string, unknown>>,
  path = MCP_JSON_PATH,
): Record<string, ServerConfig> {
  return { ...loadRegistry(path), ...registryFromConfigServers(configServers) };
}

function makeTransport(cfg: ServerConfig) {
  if (cfg.transport === 'stdio') {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      env: { ...safeInheritedEnv(), ...cfg.env },
    });
  }
  const url = new URL(cfg.url!);
  const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
  return cfg.transport === 'sse' ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
}

function safeInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withClient<T>(cfg: ServerConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'openswarm', version: '0.7.0' }, { capabilities: {} });
  try {
    await withDeadline(client.connect(makeTransport(cfg)), MCP_CONNECT_TIMEOUT_MS, 'MCP connect');
    return await withDeadline(fn(client), MCP_OPERATION_TIMEOUT_MS, 'MCP operation');
  } finally {
    await client.close().catch(() => {});
  }
}

/** A qualified MCP tool name carries the `__` separator. */
export function isMcpTool(name: string): boolean {
  const parts = name.split(SEP);
  return parts.length === 2 && parts.every(isValidToolNameSegment) && isValidToolName(name);
}

function isValidToolNameSegment(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function isValidToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

// Resolved at initMcpTools(); callMcpTool() looks the server up here.
let serverByTool: Record<string, { cfg: ServerConfig; toolName: string }> = {};

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Connect to every registered server, list its tools, and return them as
 * agentic-loop ToolDefinitions named `server__tool`. Unreachable servers are
 * skipped (logged). Call once before running the loop.
 */
interface DiscoveryResult {
  defs: ToolDefinition[];
  routing: Record<string, { cfg: ServerConfig; toolName: string }>;
  /** Servers skipped because they could not be reached. Empty when complete. */
  unreachable: string[];
}

/**
 * Probe every configured server and build the tool set.
 *
 * Everything it produces is local to the call. Recording failures on a module
 * variable meant two overlapping discoveries shared one list, and each one
 * cleared it on entry — so one run could erase the other's record and a partial
 * result would be cached as if it were complete, which is precisely the
 * process-lifetime tool loss this module is meant to avoid.
 *
 * The routing map is likewise built locally and published by the caller only
 * once the run finishes. Clearing the live map on entry made every in-flight
 * agent see "MCP tool not registered" for tools that were working a moment
 * earlier, for as long as rediscovery took.
 */
async function discoverMcpTools(registry: Record<string, ServerConfig>): Promise<DiscoveryResult> {
  const defs: ToolDefinition[] = [];
  const routing: Record<string, { cfg: ServerConfig; toolName: string }> = {};
  const unreachable: string[] = [];
  const entries = Object.entries(registry);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const [server, cfg] = entries[next++];
      try {
        const listed = (await withClient(cfg, (c) => c.listTools())) as { tools?: McpTool[] };
        for (const tool of listed.tools ?? []) {
          if (typeof tool.name !== 'string') continue;
          const qualified = `${server}${SEP}${tool.name}`;
          if (!isMcpTool(qualified)) {
            console.warn(`[MCP] server "${server}" returned invalid tool name "${tool.name}" — skipped`);
            continue;
          }
          routing[qualified] = { cfg, toolName: tool.name };
          defs.push({
            type: 'function',
            function: {
              name: qualified,
              description: (tool.description ?? '').slice(0, 1024),
              parameters: sanitizeInputSchema(tool.inputSchema),
            },
          });
        }
      } catch (err) {
        unreachable.push(server);
        console.warn(`[MCP] server "${server}" unreachable — skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
  return { defs, routing, unreachable };
}

export async function initMcpTools(registry = loadRegistry()): Promise<ToolDefinition[]> {
  const { defs, routing } = await discoverMcpTools(registry);
  serverByTool = routing;
  return defs;
}

// Cache the discovered tools so chat doesn't re-list every message.
let cachedTools: ToolDefinition[] | null = null;
/** When >0, the cached result was incomplete and may be re-attempted at this time. */
let cachedToolsRetryAt = 0;
/** The discovery currently running, shared by every concurrent caller. */
let inFlightDiscovery: Promise<ToolDefinition[]> | null = null;
/**
 * Bumped by resetMcpTools. A discovery that started before a reset must not
 * publish its result afterwards — it would silently reinstate the state the
 * reset just cleared. Unreachable today (the only reset call site is a
 * short-lived CLI process with no discovery in flight), but the guard costs
 * one comparison and the alternative is a bug that only appears once reset
 * moves into the daemon.
 */
let discoveryGeneration = 0;
/** How long an incomplete discovery is reused before another attempt. */
const INCOMPLETE_DISCOVERY_RETRY_MS = 60_000;

/**
 * The effective registry for auto-discovery: mcp.json merged with the servers
 * declared in config.yaml (`mcp.servers`, INT-1949). config is loaded lazily so
 * mcpClient stays free of a static dependency on core/config. (INT-1951)
 */
async function loadConfiguredRegistry(): Promise<Record<string, ServerConfig>> {
  let configServers: Record<string, Record<string, unknown>> | undefined;
  try {
    const { loadConfig } = await import('../core/config.js');
    configServers = loadConfig().mcp?.servers as Record<string, Record<string, unknown>> | undefined;
  } catch {
    // No/invalid config → fall back to mcp.json only.
  }
  return loadEffectiveRegistry(configServers);
}

/**
 * Discovered MCP tools (cached). Sources from mcp.json + config.yaml mcp.servers.
 * Empty when nothing is configured / no reachable servers. (INT-1951)
 */
export async function getMcpTools(): Promise<ToolDefinition[]> {
  // A complete discovery is cached until resetMcpTools(). An incomplete one —
  // some server was unreachable — is cached only briefly, so a server that was
  // down for a moment comes back on its own. Caching it for the process
  // lifetime meant a single blip removed those tools from every later call
  // until someone noticed and ran resetMcpTools() by hand.
  if (cachedTools && (!cachedToolsRetryAt || Date.now() < cachedToolsRetryAt)) return cachedTools;
  // One discovery at a time. Without this, concurrent callers each start their
  // own run; they race to publish the routing map and the cache, so a slower
  // stale run can undo a newer successful one — and every unreachable server
  // gets hit once per caller.
  inFlightDiscovery ??= (async () => {
    const generation = discoveryGeneration;
    try {
      const { defs, routing, unreachable } = await discoverMcpTools(await loadConfiguredRegistry());
      // A reset landed while this ran: return the result to whoever asked, but
      // do not write it back over the cleared state.
      if (generation !== discoveryGeneration) return defs;
      serverByTool = routing;
      cachedTools = defs;
      // Measured from when discovery finished, not when it started. Unreachable
      // servers are precisely the ones that take a long time to fail, so a
      // discovery that ran longer than the lease would set a deadline already
      // in the past and the next call would rediscover immediately — the lease
      // would apply least often in exactly the case it exists for.
      cachedToolsRetryAt = unreachable.length > 0 ? Date.now() + INCOMPLETE_DISCOVERY_RETRY_MS : 0;
      return defs;
    } finally {
      if (generation === discoveryGeneration) inFlightDiscovery = null;
    }
  })();
  return inFlightDiscovery;
}

/** Drop the cache (after editing mcp.json). */
export function resetMcpTools(): void {
  discoveryGeneration++;
  cachedTools = null;
  cachedToolsRetryAt = 0;
  inFlightDiscovery = null;
}

/**
 * Resolve the MCP tools for an adapter run: use the caller-provided set if any,
 * otherwise self-source from the registry. A failing source degrades to no
 * tools (never blocks the run). `source` is injectable for tests. (INT-1951)
 */
export async function resolveMcpTools(
  provided?: ToolDefinition[],
  source: () => Promise<ToolDefinition[]> = getMcpTools,
): Promise<ToolDefinition[]> {
  if (provided) return provided;
  try {
    return await source();
  } catch {
    return [];
  }
}

/** Execute a `server__tool` call against its MCP server. Returns text content. */
export interface McpCallResult {
  content: string;
  isError: boolean;
}

export async function callMcpTool(qualified: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const entry = serverByTool[qualified];
  if (!entry) return { content: `MCP tool not registered: ${qualified}`, isError: true };
  try {
    const result = (await withClient(entry.cfg, (c) =>
      c.callTool({ name: entry.toolName, arguments: args }),
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    const content = Array.isArray(result.content) ? result.content : [];
    const text = renderMcpToolContent(content);
    if (result.isError) return { content: `MCP error calling ${qualified}: ${text || '(empty error result)'}`, isError: true };
    return { content: text || '(empty result)', isError: false };
  } catch (err) {
    return { content: `MCP error calling ${qualified}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function renderMcpToolContent(content: Array<{ type?: string; text?: string }>): string {
  let out = '';
  let truncated = false;
  for (const block of content) {
    const piece = block.type === 'text' && typeof block.text === 'string'
      ? block.text
      : JSON.stringify(block);
    const prefix = out ? '\n' : '';
    const remaining = MAX_MCP_TOOL_RESULT_CHARS - out.length - prefix.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    out += prefix + piece.slice(0, remaining);
    if (piece.length > remaining) {
      truncated = true;
      break;
    }
  }
  if (!truncated) return out;
  const marker = `\n[truncated MCP tool result at ${MAX_MCP_TOOL_RESULT_CHARS} chars]`;
  return `${out.slice(0, MAX_MCP_TOOL_RESULT_CHARS - marker.length)}${marker}`;
}
