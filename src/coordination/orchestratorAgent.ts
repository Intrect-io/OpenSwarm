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
import { adapterCanRunUnderHumanSurfaceBoundary, getAdapter, spawnCli } from '../adapters/index.js';
import type { ToolDefinition } from '../adapters/tools.js';
import { getMcpTools } from '../mcp/mcpClient.js';
import { filterMcpToolsForRole, type RoleMcpPolicy } from './mcpPolicy.js';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import type { AdapterName } from '../adapters/types.js';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import { assignCallSign } from './agentNames.js';
import { repositoryCell } from './repositoryCell.js';
import { getPrompts, t } from '../locale/index.js';
import {
  ORCHESTRATOR_HOST_TOOL_DEFINITIONS,
  ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS,
  type OrchestratorTrackerBridge,
} from './orchestratorTrackerTools.js';

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
  /** Native cache-first tracker operations; no external MCP credential is required. */
  tracker?: OrchestratorTrackerBridge;
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
 * reason this agent runs. Operator questions remain in scope: the supervisor
 * first tries cached tracker facts, durable coordination history, and peers,
 * and leaves only genuinely authority-bound decisions for the human.
 */
export function buildOrchestratorObjective(pending: readonly CoordinationEvent[]): string | null {
  if (pending.length === 0) return null;
  return [
    'Unblock the following open coordination items. Address each agent by its call sign.',
    'For a worker question, investigate cached tracker facts and durable peer evidence before escalating. Answer it only when the evidence is decisive; never manufacture business authority or credentials.',
    ...pending.map((event) =>
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
  if (!adapter.run || !adapterCanRunUnderHumanSurfaceBoundary(adapter)) {
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
      summary: t('coordination.orchestrator.adapterRejected', { adapter: adapter.name }),
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
    summary: t('coordination.orchestrator.routed', { adapter: adapter.name, model }),
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
        summary: t('coordination.orchestrator.discoveryFailed', { error: message.slice(0, 240) }),
        metadata: { adapter: adapter.name, model },
      });
    }
  }
  options.signal?.throwIfAborted();
  const { tools, denied } = filterMcpToolsForRole(discovered, options.policy);
  const nativeTrackerTools = options.tracker
    ? ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS
    : ORCHESTRATOR_HOST_TOOL_DEFINITIONS;
  const grantedTools = [...tools, ...nativeTrackerTools];
  for (const entry of denied) {
    await store.publish({
      repository: options.repository,
      taskId: options.taskId,
      actor: callSign.address,
      actorName: callSign.name,
      actorRole: 'orchestrator',
      kind: 'mcp-audit',
      status: 'completed',
      summary: t('coordination.mcpDenied', { name: entry.name, reason: entry.reason }),
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
      summary: t('coordination.orchestrator.mcpUnavailable'),
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
    summary: t('coordination.orchestrator.started', { trigger: options.trigger ?? 'manual' }),
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
        'Coordinate the autonomous workers using the internal coordination tools, cache-first tracker tools, approved MCP tools, host_read_file/host_search_files, and web_search.',
        'Generic file tools and bash stay confined to an empty scratch directory — they cannot see the repository. Read the development-host checkout with host_read_file / host_search_files (warehouse under /warehouse when present). Search the web with web_search; SearXNG is used when OPENSWARM_SEARXNG_URL is set.',
        'Use tracker_cached_issue before tracker_save_comment. Tracker comments must cite verified evidence and use a stable idempotency key.',
        'Use coordination_answer_question only after the blocker is actually resolved; leave decisions requiring new business authority pending.',
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
      // The repository capsule governs the work; the locale prompt governs
      // only language on agent/operator-visible coordination surfaces. Hidden
      // reasoning remains provider-owned and is never requested or exposed.
      systemPrompt: getPrompts().coordinationConsultationPrompt
        + (options.instructionCapsule?.text ? `\n${options.instructionCapsule.text}` : ''),
      mcpTools: grantedTools,
      coordinationContext: {
        repository: cell.repositoryPath,
        repoKey: cell.repoKey,
        taskId: options.taskId,
        taskLabel: 'Project supervisor',
        actor: callSign.address,
        actorName: callSign.name,
        actorRole: 'orchestrator',
        tracker: options.tracker,
      },
      webTools: true,
      memoryTools: false,
      // Coordination and approved MCP remain available, but no local file or
      // shell tool is exposed. Hidden-name execution is denied in tools.ts too.
      // Development-host reads go through host_read_file / host_search_files.
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
      summary: t('coordination.orchestrator.completed', { granted: tools.length, denied: denied.length }),
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
      toolsGranted: grantedTools.map((tool) => tool.function.name),
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
      summary: t('coordination.orchestrator.failed', { error: message.slice(0, 300) }),
      metadata: { adapter: adapter.name, model },
    });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
