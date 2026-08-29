// ============================================
// OpenSwarm - Pipeline presence on the coordination board (AGT-4013)
// ============================================
//
// Who is deployed on a run, and what they are doing. Split out of pairPipeline
// so the pipeline keeps to its own job and stays under the module size cap.

import type { PipelineContext } from './pairPipelineTypes.js';
import { assignCallSign, callSignAddress, sanitizeAgentDisplayName, type AgentRole } from '../coordination/agentNames.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { t } from '../locale/index.js';

/**
 * Roles that appear on the coordination board as deployed agents.
 *
 * Board presence used to depend on an agent choosing to call a coordination
 * tool, so a worker that simply did its job never appeared and the
 * orchestration view showed only the daemon. Publishing the stage lifecycle
 * makes deployment observable without relying on optional tool use.
 */
const BOARD_STAGES: ReadonlySet<string> = new Set(['worker', 'reviewer']);

/** Stable per-attempt id so a stage's start and result join into one exchange.
 * Capture it at stage START and reuse it for the terminal publish: the
 * iteration counter moves before fire-and-forget publishes run, so recomputing
 * at result time joined the result to the NEXT exchange (AGT-4018). */
export function stageCorrelationId(
  context: PipelineContext,
  stage: string,
  iteration: number = context.currentIteration,
): string {
  return `stage:${context.session.id}:${stage}:${iteration}`;
}

// Names the agents chose for themselves, keyed per (repository, task, role).
// The first choice sticks for the run; collisions get a numeric suffix so two
// live agents never answer to one name. Bounded so a long-lived daemon does
// not grow it forever.
interface ChosenAgentName { name: string; address: string }
const chosenAgentNames = new Map<string, ChosenAgentName>();
const CHOSEN_NAME_CAP = 500;

// The address shapes assignCallSign can produce (`worker-3f2a`, 8-hex final
// fallback). Self-chosen names must stay out of this namespace, or a codename
// could capture the mailbox of a live agent the registry cannot see.
const RESERVED_FALLBACK_ADDRESS = /^(?:worker|reviewer|orchestrator|review-agent)-[0-9a-f]{4,}$/;

function chosenNameKey(context: PipelineContext, role: AgentRole): string {
  // Session id scopes the entry to one pipeline run: a retry hours later is a
  // fresh agent and gets to introduce itself again instead of inheriting the
  // name a previous attempt chose.
  return `${context.projectPath}\0${taskEventKey(context.task)}\0${context.session.id}\0${role}`;
}

/**
 * Register the display name an agent picked for itself ("codename" in its
 * structured output). Returns the effective name, or null when the raw value
 * sanitizes to nothing. Markup and newlines are stripped so a name cannot
 * smuggle formatting into the board or Linear comments.
 */
export function registerChosenAgentName(
  context: PipelineContext,
  role: AgentRole,
  rawName: string | undefined,
): string | null {
  const cleaned = sanitizeAgentDisplayName(rawName);
  if (!cleaned) return null;
  const key = chosenNameKey(context, role);
  const existing = chosenAgentNames.get(key);
  if (existing) return existing.name;
  // The display name is free-form (any language), but the mailbox address must
  // stay routable. Two cases:
  //  - The name has a routable form: suffix the display name until its address
  //    is free. Agents that have not introduced themselves still answer at
  //    their deterministic fallback address and are invisible to this
  //    registry, so the entire `role-hex` fallback namespace is reserved — a
  //    chosen name may never claim an address of that shape.
  //  - The name normalizes to an empty address (fully non-ASCII): keep the
  //    display name and take a deterministic identity address instead,
  //    advancing assignCallSign's salt past occupied addresses so two live
  //    agents never share a mailbox.
  const takenAddresses = new Set([...chosenAgentNames.values()].map((v) => v.address));
  let candidate = cleaned;
  let address = callSignAddress(candidate);
  if (address) {
    for (let n = 2; takenAddresses.has(address) || RESERVED_FALLBACK_ADDRESS.test(address); n += 1) {
      candidate = `${cleaned} ${n}`;
      address = callSignAddress(candidate);
    }
  } else {
    address = assignCallSign({
      repository: context.projectPath,
      executionId: taskEventKey(context.task),
      role,
    }, takenAddresses).address;
  }
  if (chosenAgentNames.size >= CHOSEN_NAME_CAP) {
    const oldest = chosenAgentNames.keys().next().value;
    if (oldest !== undefined) chosenAgentNames.delete(oldest);
  }
  chosenAgentNames.set(key, { name: candidate, address });
  return candidate;
}


/** The board identity an agent publishes under, shared with its MCP tools. */
export function coordinationContextFor(context: PipelineContext, role: AgentRole) {
  const taskId = taskEventKey(context.task);
  const chosen = chosenAgentNames.get(chosenNameKey(context, role));
  const callSign = chosen ?? assignCallSign({ repository: context.projectPath, executionId: taskId, role });
  return {
    repository: context.projectPath,
    taskId,
    taskLabel: context.task.issueIdentifier,
    actor: callSign.address,
    actorName: callSign.name,
    actorRole: role,
  };
}

/**
 * Terminal board event for a stage that threw instead of returning a failed
 * result. Without it the agent's delegation-request never gets its
 * delegation-result and the orchestration view shows it running forever —
 * classified infrastructure failures included.
 */
export function publishStageFailureToBoard(
  context: PipelineContext,
  stage: string,
  durationMs: number,
  error: unknown,
  correlationId?: string,
): void {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  void publishStageToBoard(context, stage, 'failed', `Failed in ${(durationMs / 1000).toFixed(1)}s: ${detail}`, { correlationId });
}

// Call sites publish fire-and-forget, and each publish awaits a dynamic import
// before persisting — so two publishes for the same exchange can land out of
// program order, persisting the terminal event BEFORE its start. A consumer
// deriving current state from the newest event would then show a finished
// stage as running forever. Chain publishes per correlation id instead.
const exchangeQueues = new Map<string, Promise<void>>();

/**
 * Record a stage on the coordination board so the orchestration view shows
 * which agents are deployed and what they are doing.
 *
 * Best-effort by design: the board is an observation surface, and a failure to
 * record must never fail the stage it describes.
 */
/**
 * A summary that carries no actual report, normalized to undefined so the
 * caller's timing fallback fires. Two things reach here that are not words:
 *
 * - The placeholder an adapter substitutes for a missing summary
 *   (`src/adapters/resultParsing.ts`, `codex.ts`, `claude.ts`,
 *   `agents/documenter.ts`, `agents/auditor.ts`, `agents/skillDocumenter.ts`).
 *   It is truthy, so `said || fallback` took it and the board showed the
 *   placeholder where a duration would at least have been true. Compared
 *   through `t()` rather than a hardcoded string: the adapters emit the ACTIVE
 *   locale's value, so an English-only check would still publish `(요약 없음)`
 *   on a Korean deployment — this repo's own default. `worker.ts` already
 *   compares against `t('common.fallback.noSummary')` for the same reason.
 *   (Caught by the fresh PR review, not self-caught.)
 * - A summary that is only the agent's `Codename:` self-introduction
 *   (AGT-4019). `worker.ts` strips that line, but restores the original when
 *   stripping empties the string, so a codename-only summary arrived intact
 *   and read as if the agent had reported its own name as its work.
 *   `src/linear/format.ts` already strips it without restoring for the Linear
 *   comment path; this is the same rule for the board. (AGT-4060)
 */
function boardWords(summary: string | undefined): string | undefined {
  const stripped = summary?.replace(/^\s*Codename:.*$/gim, '').trim();
  if (!stripped || stripped === t('common.fallback.noSummary')) return undefined;
  return stripped;
}

/**
 * Publish a finished stage as the agent's own words, addressed to its
 * counterpart. Registers the codename the agent introduced itself with
 * (first introduction wins), then speaks its summary/feedback instead of a
 * timing stub — timing stays as the fallback when the agent said nothing.
 */
export function publishStageOutcomeToBoard(
  context: PipelineContext,
  stage: string,
  outcome: { success: boolean; durationMs: number; result: unknown },
  exchangeId: string,
): void {
  const spoken = outcome.result as {
    codename?: string; summary?: string; feedback?: string; decision?: string;
    costInfo?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
  };
  if ((stage === 'worker' || stage === 'reviewer') && spoken?.codename) {
    registerChosenAgentName(context, stage, spoken.codename);
  }
  const said = stage === 'reviewer'
    ? [spoken?.decision ? `[${spoken.decision}]` : undefined, spoken?.feedback?.trim()].filter(Boolean).join(' ')
    : boardWords(spoken?.summary);
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  void publishStageToBoard(
    context,
    stage,
    outcome.success ? 'completed' : 'failed',
    said || (outcome.success ? `Finished in ${seconds}s` : `Did not pass in ${seconds}s`),
    {
      correlationId: exchangeId,
      durationMs: outcome.durationMs,
      detail: said && said.length > 300 ? said : undefined,
      recipientRole: stage === 'reviewer' ? 'worker' : (stage === 'worker' ? 'reviewer' : undefined),
      model: spoken?.costInfo?.model,
      usage: spoken?.costInfo,
    },
  );
}

export interface StagePublishOptions {
  model?: string;
  /** Token/cost usage of the utterance, surfaced as board metadata chips. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** Full text of what the agent said (feedback, summary) when longer than the summary line. */
  detail?: string;
  /** Who the agent is talking to — worker results address the reviewer and vice versa. */
  recipientRole?: AgentRole;
  /** Exchange id captured at stage start; recomputing after the iteration counter moved joins the wrong exchange (AGT-4018). */
  correlationId?: string;
  durationMs?: number;
}

export function publishStageToBoard(
  context: PipelineContext,
  stage: string,
  status: 'running' | 'completed' | 'failed',
  summary: string,
  options: StagePublishOptions = {},
): Promise<void> {
  if (!BOARD_STAGES.has(stage)) return Promise.resolve();
  const key = options.correlationId ?? stageCorrelationId(context, stage);
  const chained = (exchangeQueues.get(key) ?? Promise.resolve())
    .then(() => publishStageEvent(context, stage, status, summary, key, options));
  exchangeQueues.set(key, chained);
  void chained.finally(() => {
    if (exchangeQueues.get(key) === chained) exchangeQueues.delete(key);
  });
  return chained;
}

async function publishStageEvent(
  context: PipelineContext,
  stage: string,
  status: 'running' | 'completed' | 'failed',
  summary: string,
  correlationId: string,
  options: StagePublishOptions,
): Promise<void> {
  try {
    const actor = coordinationContextFor(context, stage as AgentRole);
    const recipient = options.recipientRole
      ? coordinationContextFor(context, options.recipientRole)
      : undefined;
    const { publishCoordination } = await import('../coordination/runCoordination.js');
    await publishCoordination({
      ...actor,
      ...(recipient ? {
        recipient: recipient.actor,
        recipientName: recipient.actorName,
        recipientRole: recipient.actorRole,
      } : {}),
      // The daemon delegates the stage and the agent reports back, which is
      // exactly what these two kinds mean elsewhere on the board.
      kind: status === 'running' ? 'delegation-request' : 'delegation-result',
      status,
      correlationId,
      // The agent's own words are the summary; role/name fields carry the
      // speaker, so no `worker:` prefix is prepended any more.
      summary: summary.slice(0, 300),
      detail: options.detail?.slice(0, 4_000),
      metadata: {
        iteration: context.currentIteration,
        ...(options.model ? { model: options.model } : {}),
        ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
        ...(options.usage?.inputTokens !== undefined ? { inputTokens: options.usage.inputTokens } : {}),
        ...(options.usage?.outputTokens !== undefined ? { outputTokens: options.usage.outputTokens } : {}),
        ...(options.usage?.costUsd !== undefined ? { costUsd: options.usage.costUsd } : {}),
      },
    });
  } catch {
    // Observation only — never let it break the run.
  }
}
