// ============================================
// OpenSwarm - MCP-connected worker orchestrator
// ============================================
//
// The orchestrator coordinates workers through external systems (GitHub,
// Linear, Cloudflare) rather than by editing code. Read-only is not available
// to it — that mode withholds MCP entirely (INT-3189) — so containment comes
// from two things instead: an isolated scratch working directory and complete
// removal of the built-in filesystem/shell tool set. The latter is required:
// the shared path validator intentionally permits `/tmp`, and `bash` is not
// path-checked at all. This agent may hold several external-service grants at
// once, so scratch cwd alone is not a security boundary.

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter, spawnCli } from '../adapters/index.js';
import type { ToolDefinition } from '../adapters/tools.js';
import { getMcpTools } from '../mcp/mcpClient.js';
import { filterMcpToolsForRole, type RoleMcpPolicy } from './mcpPolicy.js';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import type { AdapterName } from '../adapters/types.js';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import { assignCallSign } from './agentNames.js';
import { repositoryCell } from './repositoryCell.js';

export interface OrchestratorRunOptions {
  repository: string;
  taskId: string;
  objective: string;
  policy?: RoleMcpPolicy;
  adapterName?: AdapterName;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  maxTurns?: number;
  /** Why this run started (`cron`, `coordination-event`, or a coalesced set). */
  trigger?: string;
  instructionCapsule?: InstructionCapsule;
  signal?: AbortSignal;
}

export interface OrchestratorRunResult {
  /** The orchestrator's call sign for this repository. */
  callSign: string;
  output: string;
  toolsGranted: string[];
  toolsDenied: Array<{ name: string; reason: string }>;
  adapter: AdapterName;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  skippedReason?: 'mcp-discovery-failed' | 'no-approved-mcp-tools';
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
  options.signal?.throwIfAborted();
  const store = getCoordinationStore();
  const cell = repositoryCell(options.repository);
  const callSign = assignCallSign({ repository: cell.repoKey, executionId: options.taskId, role: 'orchestrator' });
  const adapter = getAdapter(options.adapterName);
  const routeCorrelationId = `orchestrator-route:${randomUUID()}`;
  if (!adapter.run) {
    // Do not invoke delegated adapter discovery here. Some implementations
    // consult a live account/model catalog, which is unnecessary provider work
    // for a route that must be rejected before any delegated CLI activity.
    const model = options.model ?? 'adapter-default';
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'adapter-route',
      status: 'failed',
      correlationId: routeCorrelationId,
      summary: `Orchestrator adapter '${adapter.name}' delegates its tool loop and cannot enforce MCP-only supervision`,
      metadata: { adapter: adapter.name, model },
    });
    throw new Error(
      `Orchestrator adapter '${adapter.name}' delegates to its own CLI tool loop and cannot use MCP with shell access withheld. `
      + 'Use codex-responses, cc-router, gpt, openrouter, atlascloud, lmstudio, or local.',
    );
  }

  const model = options.model ?? await adapter.getDefaultModel();
  options.signal?.throwIfAborted();
  await store.publish({
    repository: options.repository,
    taskId: options.taskId,
    actor: callSign.address,
    actorName: callSign.name,
    actorRole: 'orchestrator',
    kind: 'adapter-route',
    status: 'completed',
    correlationId: routeCorrelationId,
    summary: `Orchestrator routed to ${adapter.name}/${model}`,
    metadata: {
      adapter: adapter.name,
      model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.trigger ? { trigger: options.trigger } : {}),
    },
  });

  let discovered: ToolDefinition[] = [];
  const wantsExternalMcp = (options.policy?.servers.length ?? 0) > 0;
  if (wantsExternalMcp) {
    try {
      discovered = await getMcpTools();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.publish({
        repository: options.repository,
        taskId: options.taskId,
        actor: callSign.address,
        actorName: callSign.name,
        actorRole: 'orchestrator',
        kind: 'mcp-audit',
        status: 'failed',
        summary: `External MCP discovery failed; continuing with internal coordination tools (${message.slice(0, 240)})`,
        metadata: { adapter: adapter.name, model },
      });
    }
  }
  options.signal?.throwIfAborted();
  const { tools, denied } = filterMcpToolsForRole(discovered, options.policy);
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

  if (tools.length === 0) {
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'mcp-audit',
      status: 'completed',
      summary: 'No external MCP tools granted; continuing with internal coordination tools',
      metadata: { adapter: adapter.name, model, deniedCount: denied.length, internalCoordination: true },
    });
  }

  const runCorrelationId = `orchestrator-run:${randomUUID()}`;
  await store.publish({
    repository: options.repository,
    taskId: options.taskId,
    actor: callSign.address,
    actorName: callSign.name,
    actorRole: 'orchestrator',
    kind: 'mcp-audit',
    status: 'running',
    correlationId: runCorrelationId,
    summary: `Orchestrator supervision started via ${options.trigger ?? 'manual'}`,
    metadata: { adapter: adapter.name, model, grantedCount: tools.length, deniedCount: denied.length },
  });
  const scratch = await mkdtemp(join(tmpdir(), 'openswarm-orchestrator-'));
  try {
    const raw = await spawnCli(adapter, {
      prompt: [
        '# Worker orchestrator',
        '',
        `You are **${callSign.name}**, the orchestrator for this repository. Address workers by their call signs.`,
        '',
        'Coordinate the autonomous workers using the internal coordination tools and approved MCP tools only.',
        'You have no access to the repository working tree: your file tools are confined to a scratch directory.',
        'Never attempt a write or destructive MCP operation that was not granted; report it as a blocker instead.',
        'Use coordination_peers and the durable coordination_thread_* tools to consult active workers/reviewers.',
        'For a contested priority, ownership, or integration decision, create or join a repository thread, ask the relevant peer by coordination_publish, and incorporate a useful response before deciding. If no response arrives within this run, leave the thread open and report the uncertainty.',
        '',
        `Repository: ${options.repository}`,
        `Objective: ${options.objective}`,
      ].join('\n'),
      cwd: scratch,
      model,
      reasoningEffort: options.reasoningEffort,
      maxTurns: options.maxTurns ?? 10,
      timeoutMs: options.timeoutMs ?? 300_000,
      systemPrompt: options.instructionCapsule?.text,
      mcpTools: tools,
      coordinationContext: {
        repository: cell.repositoryPath,
        repoKey: cell.repoKey,
        taskId: options.taskId,
        taskLabel: 'Project supervisor',
        actor: callSign.address,
        actorName: callSign.name,
        actorRole: 'orchestrator',
      },
      webTools: false,
      memoryTools: false,
      // Coordination and approved MCP remain available, but no local file or
      // shell tool is exposed. Hidden-name execution is denied in tools.ts too.
      shellTools: false,
      filesystemTools: false,
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
      correlationId: runCorrelationId,
      summary: `Orchestrator run used internal coordination and granted ${tools.length} external MCP tool(s), denied ${denied.length}`,
      metadata: {
        adapter: adapter.name,
        model,
        grantedCount: tools.length,
        deniedCount: denied.length,
        internalCoordination: true,
        durationMs: raw.durationMs,
        ...(raw.costInfo?.inputTokens !== undefined ? { inputTokens: raw.costInfo.inputTokens } : {}),
        ...(raw.costInfo?.outputTokens !== undefined ? { outputTokens: raw.costInfo.outputTokens } : {}),
        ...(raw.costInfo?.costUsd !== undefined ? { costUsd: raw.costInfo.costUsd } : {}),
      },
    });
    return {
      callSign: callSign.name,
      output: raw.stdout,
      toolsGranted: tools.map((tool) => tool.function.name),
      toolsDenied: denied,
      adapter: adapter.name as AdapterName,
      model,
      reasoningEffort: options.reasoningEffort,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'mcp-audit',
      status: 'failed',
      correlationId: runCorrelationId,
      summary: `Orchestrator supervision failed: ${message.slice(0, 300)}`,
      metadata: { adapter: adapter.name, model },
    });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
