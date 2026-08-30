// ============================================
// OpenSwarm - Agent tools for priority councils
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';
import { getCoordinationStore } from './coordinationStore.js';
import { postCoordinationThreadMessage, getCoordinationThread } from './coordinationThreads.js';
import { repositoryKey } from './repositoryCell.js';
import {
  castPriorityCouncilBallot,
  consumePriorityCouncilRanking,
  createPriorityCouncil,
  finalizePriorityCouncil,
  getPriorityCouncil,
  listPriorityCouncils,
  submitPriorityCouncilEvidence,
  type PriorityCouncil,
  type PriorityCouncilEvidence,
  type PriorityCouncilOption,
  type PriorityCouncilReason,
  type PriorityCouncilStatus,
} from './priorityCouncil.js';

export interface PriorityCouncilToolContext {
  repository: string;
  repoKey?: string;
  taskId: string;
  taskLabel?: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  /** Internal trusted surface; never populated from model tool arguments. */
  trustedSurface?: 'operator-http';
}

const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 8 } as const;

export const PRIORITY_COUNCIL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'coordination_council_open',
      description: 'For the trusted orchestrator role only: open a bounded advisory priority council on an existing cross-task thread. Use only for a real deterministic tie, conflict cohort, or explicit high-impact ordering decision. Options must follow the cached tracker/dependency baseline and cite tracker-cache evidence; this tool performs no Linear request.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          reason: { type: 'string', enum: ['tie', 'conflict-cohort', 'high-impact'] },
          subject: { type: 'string' },
          options: {
            type: 'array', minItems: 2, maxItems: 8,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, label: { type: 'string' }, task_id: { type: 'string' },
                evidence_ids: stringArray,
                scheduling_facts: {
                  type: 'object',
                  properties: {
                    priority: { type: 'number' }, topo_rank: { type: 'number' }, due_date: { type: 'number' },
                    downstream_count: { type: 'number' }, blocked_by: stringArray, linear_state: { type: 'string' },
                  },
                  required: ['priority', 'downstream_count', 'blocked_by'],
                },
              },
              required: ['id', 'label', 'task_id', 'evidence_ids'],
            },
          },
          snapshot_version: { type: 'string', description: 'Version of the already-cached tracker/dependency snapshot. Use "auto" when every option includes scheduling_facts so the scheduler can independently reject stale state.' },
          snapshot_captured_at: { type: 'number', description: 'Epoch milliseconds when that cached snapshot was captured.' },
          snapshot_evidence: {
            type: 'array', minItems: 2, maxItems: 32,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string', enum: ['tracker-cache', 'coordination-thread', 'repository', 'test', 'operator'] },
                summary: { type: 'string' }, ref: { type: 'string' },
              },
              required: ['id', 'source', 'summary'],
            },
          },
          required_quorum: { type: 'number', description: 'Equal-weight ballot quorum, 2-7. Cross-task and cross-role quorum also apply.' },
          expires_in_ms: { type: 'number', description: 'Voting window, 60000-86400000ms.' },
          idempotency_key: { type: 'string' },
        },
        required: ['thread_id', 'reason', 'subject', 'options', 'snapshot_version', 'snapshot_captured_at', 'snapshot_evidence', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_list',
      description: 'List bounded durable councils in this repository cell, optionally restricted to a thread or status.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' }, status: { type: 'string', enum: ['open', 'finalized', 'expired'] },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_get',
      description: 'Read one durable council, eligible active-peer snapshot, evidence, ballots, tally, and consumption audit.',
      parameters: { type: 'object', properties: { council_id: { type: 'string' } }, required: ['council_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_evidence',
      description: 'Submit one durable evidence record for an option. Candidate-task workers use this instead of voting for their own task.',
      parameters: {
        type: 'object',
        properties: {
          council_id: { type: 'string' }, option_id: { type: 'string' }, summary: { type: 'string' },
          refs: stringArray, idempotency_key: { type: 'string' },
        },
        required: ['council_id', 'option_id', 'summary', 'refs', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_vote',
      description: 'Cast the current actor+task identity\'s single equal-weight ranked ballot. Eligibility is frozen from active independent peers at council creation; candidate-task self-votes, duplicates, stale snapshots, partial rankings, and unsupported evidence are rejected.',
      parameters: {
        type: 'object',
        properties: {
          council_id: { type: 'string' }, ranking: stringArray,
          confidence: { type: 'number' }, evidence_ids: stringArray,
          snapshot_version: { type: 'string' }, idempotency_key: { type: 'string' },
        },
        required: ['council_id', 'ranking', 'confidence', 'evidence_ids', 'snapshot_version', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_finalize',
      description: 'Finalize a council with the version you read. Quorum selects by equal-weight Borda score; an exact tie uses canonical taskId then optionId order, never caller array order. Missing quorum is recorded only at expiry. This grants no merge, destructive, tracker, dependency, or lease authority.',
      parameters: {
        type: 'object',
        properties: {
          council_id: { type: 'string' }, expected_version: { type: 'number' }, idempotency_key: { type: 'string' },
        },
        required: ['council_id', 'expected_version', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_council_consume',
      description: 'For an orchestrator only: CAS-consume one finalized advisory ranking against the current cached snapshot. The returned authority contract can only reorder the existing cohort slots and cannot start work or widen any permission.',
      parameters: {
        type: 'object',
        properties: {
          council_id: { type: 'string' }, expected_council_version: { type: 'number' },
          current_snapshot_version: { type: 'string' },
        },
        required: ['council_id', 'expected_council_version', 'current_snapshot_version'],
      },
    },
  },
];

export const PRIORITY_COUNCIL_TOOL_NAMES: ReadonlySet<string> = new Set(
  PRIORITY_COUNCIL_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

export const PRIORITY_COUNCIL_GUIDANCE_PROMPT = `

## Priority councils

Deterministic cached tracker/dependency order remains the default. Open a
priority council only from the trusted orchestrator role, for a real tie,
conflict cohort, or explicit high-impact ordering question, and attach it to an
existing cross-task thread. Candidate workers submit evidence; only the
snapshotted active independent peers vote.
For automatic scheduler consumption, copy the cached priority/topology/due/
dependency fields into every option's scheduling_facts and use snapshot_version
"auto"; the scheduler recomputes that version from its current task snapshot.
Ballots are equal-weight and must cite evidence. The result is advisory ranking
only: it never starts work, bypasses dependencies or file leases, merges code,
uses destructive tools, or mutates Linear/the tracker.
`;

function councilRepository(context: PriorityCouncilToolContext): string {
  return repositoryKey(context.repoKey, context.repository);
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function requiredStrings(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value as string[];
}

function parseOptions(value: unknown): PriorityCouncilOption[] {
  if (!Array.isArray(value)) throw new Error('options must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each option must be an object');
    const option = entry as Record<string, unknown>;
    const scheduling = option.scheduling_facts;
    if (scheduling !== undefined && (!scheduling || typeof scheduling !== 'object' || Array.isArray(scheduling))) {
      throw new Error('scheduling_facts must be an object');
    }
    const facts = scheduling as Record<string, unknown> | undefined;
    return {
      id: requiredString(option, 'id'), label: requiredString(option, 'label'),
      taskId: requiredString(option, 'task_id'), evidenceIds: requiredStrings(option, 'evidence_ids'),
      ...(facts === undefined ? {} : {
        schedulingFacts: {
          priority: number(facts, 'priority')!,
          downstreamCount: number(facts, 'downstream_count')!,
          blockedBy: requiredStrings(facts, 'blocked_by'),
          ...(number(facts, 'topo_rank') === undefined ? {} : { topoRank: number(facts, 'topo_rank')! }),
          ...(number(facts, 'due_date') === undefined ? {} : { dueDate: number(facts, 'due_date')! }),
          ...(optionalString(facts, 'linear_state') === undefined ? {} : { linearState: optionalString(facts, 'linear_state')! }),
        },
      }),
    };
  });
}

function parseEvidence(value: unknown): PriorityCouncilEvidence[] {
  if (!Array.isArray(value)) throw new Error('snapshot_evidence must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each evidence record must be an object');
    const evidence = entry as Record<string, unknown>;
    return {
      id: requiredString(evidence, 'id'),
      source: requiredString(evidence, 'source') as PriorityCouncilEvidence['source'],
      summary: requiredString(evidence, 'summary'),
      ...(optionalString(evidence, 'ref') === undefined ? {} : { ref: optionalString(evidence, 'ref')! }),
    };
  });
}

function number(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

export type CouncilMutationAction = 'opened' | 'evidence' | 'ballot' | 'finalized' | 'expired' | 'consumed';

async function recordCouncilMutation(
  context: PriorityCouncilToolContext,
  council: PriorityCouncil,
  action: CouncilMutationAction,
  mutationId: string,
  body: string,
): Promise<{ delivered: number; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    postCoordinationThreadMessage({
      repository: council.repository,
      threadId: council.threadId,
      actor: context.actor,
      actorName: context.actorName,
      actorRole: context.actorRole,
      taskId: context.taskId,
      taskLabel: context.taskLabel,
      body,
      idempotencyKey: `council:${mutationId}`,
    });
  } catch (error) {
    warnings.push(`thread audit: ${error instanceof Error ? error.message : String(error)}`);
  }
  let participants: ReturnType<typeof getCoordinationThread>['participants'] = [];
  try {
    participants = getCoordinationThread({
      repository: council.repository, threadId: council.threadId, messageLimit: 1,
    }).participants.filter((participant) => participant.actor !== context.actor || participant.taskId !== context.taskId);
  } catch (error) {
    warnings.push(`thread participants: ${error instanceof Error ? error.message : String(error)}`);
  }
  const targets = participants.length > 0 ? participants : [undefined];
  let delivered = 0;
  for (const participant of targets) {
    try {
      await getCoordinationStore().publish({
        repository: context.repository,
        repoKey: council.repository,
        taskId: context.taskId,
        taskLabel: context.taskLabel,
        sourceTaskId: context.taskId,
        sourceTaskLabel: context.taskLabel,
        targetTaskId: participant?.taskId ?? context.taskId,
        targetTaskLabel: participant?.taskLabel ?? context.taskLabel,
        actor: context.actor,
        actorName: context.actorName,
        actorRole: context.actorRole,
        recipient: participant?.actor,
        recipientName: participant?.actorName,
        recipientRole: participant?.actorRole,
        kind: 'council-update',
        status: action === 'opened' ? 'open' : action === 'expired' ? 'expired' : 'completed',
        correlationId: `council:${council.id}`,
        summary: `Priority council ${action}: ${council.subject}`,
        detail: body,
        metadata: { councilId: council.id, threadId: council.threadId, action, mutationId },
      });
      delivered += 1;
    } catch (error) {
      warnings.push(`board notification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { delivered, warnings };
}

/** Execute council tools with actor/task/role taken only from the trusted run context. */
export async function executePriorityCouncilTool(
  name: string,
  args: Record<string, unknown>,
  context: PriorityCouncilToolContext,
): Promise<{ content: string; isError: boolean }> {
  try {
    const repository = councilRepository(context);
    if (name === 'coordination_council_open') {
      if (context.actorRole !== 'orchestrator' && context.trustedSurface !== 'operator-http') {
        throw new Error('Only an orchestrator may open a priority council through agent tools');
      }
      const reason = requiredString(args, 'reason') as PriorityCouncilReason;
      const council = createPriorityCouncil({
        repository,
        threadId: requiredString(args, 'thread_id'),
        reason,
        subject: requiredString(args, 'subject'),
        options: parseOptions(args.options),
        snapshotVersion: requiredString(args, 'snapshot_version'),
        snapshotCapturedAt: number(args, 'snapshot_captured_at')!,
        snapshotEvidence: parseEvidence(args.snapshot_evidence),
        eligiblePeers: getCoordinationStore().peers({
          repoKey: repository, repository: context.repository, limit: 50,
        }),
        requiredQuorum: number(args, 'required_quorum'),
        expiresInMs: number(args, 'expires_in_ms'),
        actor: context.actor,
        actorName: context.actorName,
        actorRole: context.actorRole,
        taskId: context.taskId,
        taskLabel: context.taskLabel,
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      const audit = await recordCouncilMutation(
        context, council, 'opened', `open:${council.id}`,
        `[Priority council ${council.id}] Opened from cached snapshot ${council.snapshotVersion}. `
          + `Options: ${council.options.map((option) => `${option.id}=${option.taskId}`).join(', ')}. `
          + `Quorum ${council.requiredQuorum}, cross-task ${council.requiredTaskQuorum}, cross-role ${council.requiredRoleQuorum}. `
          + 'Authority: advisory cohort ranking only.',
      );
      return { content: JSON.stringify({ accepted: true, council, audit }), isError: false };
    }

    if (name === 'coordination_council_list') {
      const status = optionalString(args, 'status') as PriorityCouncilStatus | undefined;
      const councils = listPriorityCouncils({
        repository, threadId: optionalString(args, 'thread_id'), status,
        limit: number(args, 'limit'),
      });
      return { content: JSON.stringify({ items: councils }), isError: false };
    }

    if (name === 'coordination_council_get') {
      return {
        content: JSON.stringify(getPriorityCouncil({ repository, councilId: requiredString(args, 'council_id') })),
        isError: false,
      };
    }

    if (name === 'coordination_council_evidence') {
      const evidence = submitPriorityCouncilEvidence({
        repository, councilId: requiredString(args, 'council_id'), optionId: requiredString(args, 'option_id'),
        actor: context.actor, actorName: context.actorName, actorRole: context.actorRole,
        taskId: context.taskId, taskLabel: context.taskLabel,
        summary: requiredString(args, 'summary'), refs: requiredStrings(args, 'refs'),
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      const council = getPriorityCouncil({ repository, councilId: evidence.councilId }).council;
      const audit = await recordCouncilMutation(
        context, council, 'evidence', `evidence:${evidence.id}`,
        `[Priority council ${council.id}] Evidence for ${evidence.optionId}: ${evidence.summary} `
          + `(refs: ${evidence.refs.join(', ')})`,
      );
      return { content: JSON.stringify({ accepted: true, evidence, council, audit }), isError: false };
    }

    if (name === 'coordination_council_vote') {
      const ballot = castPriorityCouncilBallot({
        repository, councilId: requiredString(args, 'council_id'), actor: context.actor,
        actorName: context.actorName, actorRole: context.actorRole, taskId: context.taskId,
        taskLabel: context.taskLabel, ranking: requiredStrings(args, 'ranking'),
        confidence: number(args, 'confidence')!, evidenceIds: requiredStrings(args, 'evidence_ids'),
        snapshotVersion: requiredString(args, 'snapshot_version'),
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      const council = getPriorityCouncil({ repository, councilId: ballot.councilId }).council;
      const audit = await recordCouncilMutation(
        context, council, 'ballot', `ballot:${ballot.id}`,
        `[Priority council ${council.id}] Equal-weight ballot recorded by ${context.actor} (${context.actorRole ?? 'unknown'}): `
          + `${ballot.ranking.join(' > ')}; confidence ${ballot.confidence}; evidence ${ballot.evidenceIds.join(', ')}.`,
      );
      return { content: JSON.stringify({ accepted: true, ballot, council, audit }), isError: false };
    }

    if (name === 'coordination_council_finalize') {
      const council = finalizePriorityCouncil({
        repository, councilId: requiredString(args, 'council_id'),
        expectedVersion: number(args, 'expected_version')!, actor: context.actor, taskId: context.taskId,
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      const action = council.status === 'expired' ? 'expired' : 'finalized';
      const audit = await recordCouncilMutation(
        context, council, action, `finalize:${council.id}:${council.version}`,
        `[Priority council ${council.id}] ${council.outcome}. `
          + (council.selectedOptionId ? `Selected ${council.selectedOptionId}; ranking ${council.rankedOptionIds.join(' > ')}. ` : '')
          + `Tally ${JSON.stringify(council.tally)}. Missing quorum: ${council.noQuorumReasons.join(', ') || 'none'}. `
          + 'Authority remains advisory cohort ranking only.',
      );
      return { content: JSON.stringify({ accepted: true, council, audit }), isError: false };
    }

    if (name === 'coordination_council_consume') {
      if (context.actorRole !== 'orchestrator') throw new Error('Only an orchestrator may consume a council ranking tool signal');
      const consumed = consumePriorityCouncilRanking({
        repository, councilId: requiredString(args, 'council_id'),
        expectedCouncilVersion: number(args, 'expected_council_version')!,
        currentSnapshotVersion: requiredString(args, 'current_snapshot_version'),
        consumer: context.actor, consumerTaskId: context.taskId, consumerRole: 'orchestrator',
      });
      const council = getPriorityCouncil({ repository, councilId: consumed.signal.councilId }).council;
      const audit = await recordCouncilMutation(
        context, council, 'consumed', `consume:${consumed.consumption.id}`,
        `[Priority council ${council.id}] Advisory ranking consumed by orchestrator ${context.actor}; `
          + `snapshot ${consumed.signal.snapshotVersion}, council version ${consumed.signal.councilVersion}.`,
      );
      return { content: JSON.stringify({ ...consumed, audit }), isError: false };
    }

    return { content: `Unknown priority council tool: ${name}`, isError: true };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
