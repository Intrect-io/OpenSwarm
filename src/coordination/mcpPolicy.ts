// ============================================
// OpenSwarm - Role-scoped MCP policy
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';

export type McpAccess = 'read' | 'write' | 'destructive';

export interface RoleMcpPolicy {
  servers: string[];
  allowTools?: string[];
  writeTools?: string[];
  destructiveTools?: string[];
}

const MUTATION_WORDS = /(^|_)(create|update|save|write|edit|delete|remove|archive|close|merge|approve|submit|reply|resolve|trigger|run|execute|upload|move|share|unshare)(_|$)/i;
const DESTRUCTIVE_WORDS = /(^|_)(delete|remove|archive|merge|execute|run|trigger|unshare)(_|$)/i;

export function classifyMcpTool(toolName: string): McpAccess {
  // Everything after the server prefix, not just the next segment: a nested
  // name like `github__pulls__merge` puts the verb in the last segment, and
  // reading only `pulls` classified a merge as a harmless read.
  const segments = toolName.split('__');
  const raw = segments.length > 1 ? segments.slice(1).join('__') : toolName;
  if (DESTRUCTIVE_WORDS.test(raw)) return 'destructive';
  if (MUTATION_WORDS.test(raw)) return 'write';
  return 'read';
}

export function filterMcpToolsForRole(
  tools: ToolDefinition[],
  policy: RoleMcpPolicy | undefined,
): { tools: ToolDefinition[]; denied: Array<{ name: string; reason: string }> } {
  if (!policy) return { tools: [], denied: tools.map((tool) => ({ name: tool.function.name, reason: 'no role MCP policy' })) };
  const servers = new Set(policy.servers);
  const allow = policy.allowTools ? new Set(policy.allowTools) : undefined;
  const writes = new Set(policy.writeTools ?? []);
  const destructive = new Set(policy.destructiveTools ?? []);
  const accepted: ToolDefinition[] = [];
  const denied: Array<{ name: string; reason: string }> = [];
  for (const tool of tools) {
    const name = tool.function.name;
    const [server] = name.split('__');
    const access = classifyMcpTool(name);
    let reason: string | undefined;
    if (!servers.has(server)) reason = `server ${server} is not allowlisted`;
    else if (allow && !allow.has(name)) reason = 'tool is not on the exact allowlist';
    else if (access === 'write' && !writes.has(name)) reason = 'write capability was not granted';
    else if (access === 'destructive' && !destructive.has(name)) reason = 'destructive capability was not granted';
    if (reason) denied.push({ name, reason });
    else accepted.push(tool);
  }
  return { tools: accepted, denied };
}
