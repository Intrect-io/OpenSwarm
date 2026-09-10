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
import { safeInheritedEnv } from '../support/spawnEnv.js';
import {
  attachMcpToolPolicy,
  filterHumanSurfaceMcpTools,
  humanSurfaceMcpCallWriteReason,
  isGenericMcpTransport,
  type McpSurface,
  type McpToolAnnotations,
  type McpToolPolicyDecision,
} from './humanSurfacePolicy.js';

/** Qualified tool name separator */
const SEP = '__';

/**
 * MCP server configuration from mcp.json
 */
export interface ServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  surface?: McpSurface;
  /** If true, the server is always started (no lazy init). */
  alwaysRun?: boolean;
  /** Human-readable label for the server. */
  label?: string;
  /** Tool annotations from the server's listTools response. */
  annotations?: McpToolAnnotations;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

interface McpToolRoute {
  cfg: ServerConfig;
  toolName: string;
  policy: McpToolPolicyDecision;
  inputSchema: Record<string, unknown>;
}

interface DiscoveryResult {
  defs: ToolDefinition[];
  routing: Record<string, McpToolRoute>;
  unreachable: string[];
}

const MCP_JSON_PATH = join(homedir(), '.openswarm/mcp.json');

// ── Registry loading ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function stringRecordOrNull(value: unknown): Record<string, string> | undefined | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    record[k] = v;
  }
  return record;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isMcpSurface(value: unknown): value is McpSurface {
  return value === 'human' || value === 'internal';
}

function isJsonSchemaObject(schema: unknown, depth = 0): schema is Record<string, unknown> {
  if (depth > 5) return false;
  if (typeof schema !== 'object' || schema === null) return false;
  if (Array.isArray(schema)) return false;
  for (const [key, val] of Object.entries(schema)) {
    if (key === 'properties' || key === 'definitions' || key === '$defs') {
      if (typeof val !== 'object' || val === null) return false;
      for (const propVal of Object.values(val as Record<string, unknown>)) {
        if (!isJsonSchemaObject(propVal, depth + 1)) return false;
      }
    }
  }
  return true;
}

function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  if (isJsonSchemaObject(schema)) return schema;
  return { type: 'object', properties: {} };
}

function normalizeEntry(raw: unknown): ServerConfig | null {
  if (!isRecord(raw)) return null;
  const cfg: ServerConfig = {};
  if (typeof raw.command === 'string') cfg.command = raw.command;
  if (isStringArray(raw.args)) cfg.args = raw.args;
  if (typeof raw.url === 'string') cfg.url = raw.url;
  if (typeof raw.surface === 'string' && isMcpSurface(raw.surface)) cfg.surface = raw.surface;
  if (typeof raw.alwaysRun === 'boolean') cfg.alwaysRun = raw.alwaysRun;
  if (typeof raw.label === 'string') cfg.label = raw.label;
  const env = stringRecordOrNull(raw.env);
  if (env) cfg.env = env;
  if (!cfg.command && !cfg.url) return null;
  return cfg;
}

export function loadRegistry(path = MCP_JSON_PATH): Record<string, ServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw)) return {};
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw.servers) ? raw.servers : null;
    if (!servers) return {};
    const result: Record<string, ServerConfig> = {};
    for (const [name, entry] of Object.entries(servers)) {
      const cfg = normalizeEntry(entry);
      if (cfg) result[name] = cfg;
    }
    return result;
  } catch {
    return {};
  }
}

export function registryFromConfigServers(
  servers: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }>,
): Record<string, ServerConfig> {
  const result: Record<string, ServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const cfg: ServerConfig = {};
    if (entry.command) cfg.command = entry.command;
    if (entry.args) cfg.args = entry.args;
    if (entry.url) cfg.url = entry.url;
    if (entry.env) cfg.env = entry.env;
    if (cfg.command || cfg.url) result[name] = cfg;
  }
  return result;
}

export function loadEffectiveRegistry(
  fileRegistry?: Record<string, ServerConfig>,
): Record<string, ServerConfig> {
  const file = fileRegistry ?? loadRegistry();
  // Config servers are merged lazily in loadConfiguredRegistry; this function
  // returns only the file-based registry for callers that don't need config.
  return file;
}

// ── Transport ─────────────────────────────────────────────────────────────

function makeTransport(cfg: ServerConfig) {
  if (cfg.url) {
    if (cfg.url.startsWith('http')) {
      return new StreamableHTTPClientTransport(new URL(cfg.url));
    }
    if (cfg.url.startsWith('sse')) {
      return new SSEClientTransport(new URL(cfg.url));
    }
  }
  return new StdioClientTransport({
    command: cfg.command ?? '',
    args: cfg.args,
    env: { ...safeInheritedEnv(), ...cfg.env },
  });
}

// ── Client lifecycle ──────────────────────────────────────────────────────

async function withClient<T>(
  cfg: ServerConfig,
  fn: (client: Client) => Promise<T>,
  deadlineMs = 15_000,
): Promise<T> {
  const transport = makeTransport(cfg);
  const client = new Client(
    { name: 'openswarm-mcp', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await withDeadline(client.connect(transport), deadlineMs);
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort close
    }
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP operation timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Tool discovery ────────────────────────────────────────────────────────

/**
 * Maximum tools per server before truncation.
 */
const MAX_TOOLS_PER_SERVER = 200;

/**
 * Maximum total tools across all servers before discovery stops.
 * Set to 1000 to bound memory and latency for large MCP registries.
 */
const MAX_TOTAL_TOOLS = 1_000;

async function discoverMcpTools(registry: Record<string, ServerConfig>): Promise<DiscoveryResult> {
  const defs: ToolDefinition[] = [];
  const routing: Record<string, McpToolRoute> = {};
  const unreachable: string[] = [];
  const entries = Object.entries(registry);
  let next = 0;
  let discoveryStopped = false;
  // Global qualified-name dedup set — prevents duplicate tool definitions
  // across servers that expose the same qualified name.
  const globalSeenQualified = new Set<string>();
  const worker = async (): Promise<void> => {
    while (next < entries.length && !discoveryStopped) {
      const [server, cfg] = entries[next++];
      if (discoveryStopped) break;
      try {
        const listed = (await withClient(cfg, (c) => c.listTools())) as { tools?: McpTool[] };
        const seenNames = new Set<string>();
        let serverToolCount = 0;
        for (const tool of listed.tools ?? []) {
          if (typeof tool.name !== 'string') continue;
          if (seenNames.has(tool.name)) continue;
          seenNames.add(tool.name);
          if (serverToolCount >= MAX_TOOLS_PER_SERVER) {
            console.warn(`[MCP] server "${server}" exceeded ${MAX_TOOLS_PER_SERVER} tools — truncating`);
            break;
          }
          if (defs.length >= MAX_TOTAL_TOOLS) {
            discoveryStopped = true;
            console.warn(`[MCP] total tools exceeded ${MAX_TOTAL_TOOLS} — stopping discovery`);
            break;
          }
          const qualified = `${server}${SEP}${tool.name}`;
          if (!isMcpTool(qualified)) {
            console.warn(`[MCP] server "${server}" returned invalid tool name "${tool.name}" — skipped`);
            continue;
          }
          // Deduplicate by qualified name across all servers
          if (globalSeenQualified.has(qualified)) continue;
          globalSeenQualified.add(qualified);
          const definition: ToolDefinition = {
            type: 'function',
            function: {
              name: qualified,
              description: (tool.description ?? '').slice(0, 1024),
              parameters: sanitizeInputSchema(tool.inputSchema),
            },
          };
          const policy = attachMcpToolPolicy(definition, {
            server,
            action: tool.name,
            description: tool.description,
            declaredSurface: cfg.surface,
            serverIdentityHints: [cfg.url ?? '', cfg.command ?? '', ...(cfg.args ?? [])].filter(Boolean),
            annotations: tool.annotations,
          });
          routing[qualified] = {
            cfg,
            toolName: tool.name,
            policy,
            inputSchema: definition.function.parameters,
          };
          defs.push(definition);
          serverToolCount++;
        }
      } catch (err) {
        unreachable.push(server);
        console.warn(`[MCP] server "${server}" unreachable — skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const MAX_TOOL_DISCOVERY_CONCURRENCY = 5;
  await Promise.all(Array.from({ length: Math.min(MAX_TOOL_DISCOVERY_CONCURRENCY, entries.length) }, () => worker()));
  return { defs, routing, unreachable };
}

export async function initMcpTools(registry = loadRegistry()): Promise<ToolDefinition[]> {
  const { defs, routing } = await discoverMcpTools(registry);
  serverByTool = routing;
  return defs;
}

// Cache the discovered tools so chat doesn't re-list every message.
let cachedTools: ToolDefinition[] | null = null;
let cachedToolsRetryAt = 0;
let inFlightDiscovery: Promise<ToolDefinition[]> | null = null;

/**
 * getMcpTools — cached, with retry for incomplete discovery.
 *
 * The cache is invalidated by resetMcpTools() (called after mcp.json changes)
 * and by a generation counter that also guards the in-flight dedup.
 *
 * Incomplete discovery (some servers unreachable) retries after a short lease
 * rather than every call. The lease is measured from when discovery finished,
 * so a slow discovery doesn't set a deadline already in the past.
 *
 * The generation counter is belt-and-suspenders (there should never be two
 * in-flight discoveries with the same generation, and the inFlightDiscovery
 * guard already prevents that), but the guard costs one comparison and the
 * alternative is a bug that only appears once reset moves into the daemon.
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
  const fileRegistry = loadRegistry();
  let configServers: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }> | undefined;
  try {
    const { loadConfig } = await import('../core/config.js');
    const config = loadConfig();
    configServers = (config as Record<string, unknown>)?.mcp as Record<string, unknown> as Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }> | undefined;
  } catch {
    // No config available — use file registry only
  }
  if (!configServers) return fileRegistry;
  return { ...fileRegistry, ...registryFromConfigServers(configServers) };
}

export async function getMcpTools(): Promise<ToolDefinition[]> {
  if (cachedTools && Date.now() < cachedToolsRetryAt) return cachedTools;
  if (inFlightDiscovery) return inFlightDiscovery;
  const generation = ++discoveryGeneration;
  inFlightDiscovery = (async () => {
    try {
      const registry = await loadConfiguredRegistry();
      const { defs, routing, unreachable } = await discoverMcpTools(registry);
      // If reset was called while we were discovering, discard the result and
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
  } catch (err) {
    console.warn('[MCP] Failed to resolve tools:', err);
    return [];
  }
}

// ── Routing ───────────────────────────────────────────────────────────────

let serverByTool: Record<string, McpToolRoute> = {};

export function isMcpTool(name: string): boolean {
  return name.includes(SEP);
}

export function getMcpToolRoute(qualified: string): McpToolRoute | undefined {
  return serverByTool[qualified];
}

// ── Call dispatch ─────────────────────────────────────────────────────────

export async function callMcpTool(
  qualified: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const entry = serverByTool[qualified];
  if (!entry) {
    return { content: `Unknown MCP tool: ${qualified}`, isError: true };
  }
  const readAllowed = filterHumanSurfaceMcpTools(entry.policy);
  const dispatchClassified = isGenericMcpTransport(entry.cfg);
  if (!readAllowed && !dispatchClassified) {
    return {
      content: `HUMAN_SURFACE_READ_ONLY: ${qualified} cannot mutate an external human-facing service. `
        + 'Only read/list/get/search/fetch MCP actions are allowed.',
      isError: true,
    };
  }
  const dynamicDenial = humanSurfaceMcpCallWriteReason(entry.policy, args, entry.inputSchema);
  if (dynamicDenial) {
    return {
      content: `HUMAN_SURFACE_READ_ONLY: ${qualified}: ${dynamicDenial}`,
      isError: true,
    };
  }
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
  return content
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    })
    .join('\n');
}