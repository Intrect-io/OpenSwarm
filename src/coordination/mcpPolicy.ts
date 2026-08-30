// ============================================
// OpenSwarm - Role-scoped MCP policy
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';
import {
  describeMcpToolPolicy,
  isGenericMcpTransport,
  type McpAccess,
} from '../mcp/humanSurfacePolicy.js';

export type { McpAccess } from '../mcp/humanSurfacePolicy.js';

export interface RoleMcpPolicy {
  servers: string[];
  allowTools?: string[];
  writeTools?: string[];
  destructiveTools?: string[];
}

export function classifyMcpTool(toolName: string): McpAccess {
  return describeMcpToolPolicy(toolName).access;
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
    const decision = describeMcpToolPolicy(tool);
    const { server, access } = decision;
    let reason: string | undefined;
    const dispatchClassified = isGenericMcpTransport(decision, tool.function.parameters);
    if (decision.surface === 'human' && !decision.humanSurfaceReadAllowed && !dispatchClassified) {
      reason = 'external human surface is read-only; only read/list/get/search/fetch actions are allowed';
    } else if (!servers.has(server)) reason = `server ${server} is not allowlisted`;
    else if (allow && !allow.has(name)) reason = 'tool is not on the exact allowlist';
    else if (access === 'write' && !writes.has(name)) reason = 'write capability was not granted';
    else if (access === 'destructive' && !destructive.has(name)) reason = 'destructive capability was not granted';
    if (reason) denied.push({ name, reason });
    else accepted.push(tool);
  }
  return { tools: accepted, denied };
}
