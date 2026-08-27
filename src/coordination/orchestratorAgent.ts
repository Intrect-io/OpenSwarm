// ============================================
// OpenSwarm - MCP-connected worker orchestrator
// ============================================
//
// The orchestrator coordinates workers through external systems (GitHub,
// Linear, Cloudflare) rather than by editing code. Read-only is not available
// to it — that mode withholds MCP entirely (INT-3189) — so containment comes
// from two things instead: an isolated scratch working directory, which the
// file tools validate every path against, and `shellTools: false`. Both are
// required, because `bash` is not path-checked: a scratch `cwd` on its own
// leaves `cd /repo && …` open to the one agent in the system holding GitHub,
// Linear, and Cloudflare credentials at once.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { getMcpTools } from '../mcp/mcpClient.js';
import { filterMcpToolsForRole, type RoleMcpPolicy } from './mcpPolicy.js';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import type { AdapterName } from '../adapters/types.js';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import { assignCallSign } from './agentNames.js';

export interface OrchestratorRunOptions {
  repository: string;
  taskId: string;
  objective: string;
  policy?: RoleMcpPolicy;
  adapterName?: AdapterName;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  instructionCapsule?: InstructionCapsule;
  signal?: AbortSignal;
}

export interface OrchestratorRunResult {
  /** The orchestrator's call sign for this repository. */
  callSign: string;
  output: string;
  toolsGranted: string[];
  toolsDenied: Array<{ name: string; reason: string }>;
}

/**
 * Turn a repository's open board items into the orchestrator's objective.
 *
 * Returns null when nothing actionable is pending: a sweep that finds nothing
 * to do still spends a provider call, and unblocking existing work is the only
 * reason this agent runs. Questions waiting on the operator are excluded — only
 * a human can settle those, so handing them to the orchestrator buys a call
 * that can only conclude "still waiting". Everything else is addressed by call
 * sign so the orchestrator can answer the agent that raised it.
 */
export function buildOrchestratorObjective(pending: readonly CoordinationEvent[]): string | null {
  const actionable = pending.filter((event) => event.kind !== 'human-question');
  if (actionable.length === 0) return null;
  return [
    'Unblock the following open coordination items. Address each agent by its call sign.',
    ...actionable.map((event) =>
      `- [${event.kind}/${event.status}] ${event.actorName ?? event.actor}`
      + ` → ${event.recipientName ?? event.recipient ?? 'all'}: ${event.summary}`),
  ].join('\n');
}

export async function runOrchestrator(options: OrchestratorRunOptions): Promise<OrchestratorRunResult> {
  const discovered = await getMcpTools().catch(() => []);
  const { tools, denied } = filterMcpToolsForRole(discovered, options.policy);
  const store = getCoordinationStore();
  const callSign = assignCallSign({ repository: options.repository, executionId: options.taskId, role: 'orchestrator' });
  for (const entry of denied) {
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'mcp-audit',
      status: 'completed',
      summary: `Denied MCP tool ${entry.name}: ${entry.reason}`,
    });
  }

  const scratch = await mkdtemp(join(tmpdir(), 'openswarm-orchestrator-'));
  try {
    const raw = await spawnCli(getAdapter(options.adapterName), {
      prompt: [
        '# Worker orchestrator',
        '',
        `You are **${callSign.name}**, the orchestrator for this repository. Address workers by their call signs.`,
        '',
        'Coordinate the autonomous workers for this repository using the connected MCP tools only.',
        'You have no access to the repository working tree: your file tools are confined to a scratch directory.',
        'Never attempt a write or destructive MCP operation that was not granted; report it as a blocker instead.',
        '',
        `Repository: ${options.repository}`,
        `Objective: ${options.objective}`,
      ].join('\n'),
      cwd: scratch,
      model: options.model,
      maxTurns: options.maxTurns ?? 10,
      timeoutMs: options.timeoutMs ?? 300_000,
      systemPrompt: options.instructionCapsule?.text,
      mcpTools: tools,
      webTools: false,
      memoryTools: false,
      // The scratch cwd confines the file tools, but bash is not path-checked:
      // a shell would walk straight out of it. The orchestrator coordinates
      // through MCP and has no reason to run commands at all.
      shellTools: false,
      signal: options.signal,
    });
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'mcp-audit',
      status: 'completed',
      summary: `Orchestrator run granted ${tools.length} MCP tool(s), denied ${denied.length}`,
      metadata: { grantedCount: tools.length, deniedCount: denied.length },
    });
    return {
      callSign: callSign.name,
      output: raw.stdout,
      toolsGranted: tools.map((tool) => tool.function.name),
      toolsDenied: denied,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
