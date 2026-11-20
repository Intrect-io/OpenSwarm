// Created: 2026-11-15
// Purpose: Definition of Ready — a Todo issue needs acceptance criteria, an out-of-scope note and a
//          verify command before the daemon claims it (AGT-4805). Extends the readiness gate (AGT-4784).
// Dependencies: readinessGate (state/label/verdict rules), projectGoal (owning project lookup)
// Test Status: definitionOfReady.test.ts

import { partitionByReadiness, type ReadinessOptions, type ReadinessPartition, type ReadinessTask } from './readinessGate.js';
import { resolveOwningProject } from '../support/projectGoal.js';

// On 2026-10-20 multi-defect issues ("15 defects") got +5-line drafts (AGT-4786): nothing told the
// worker or the reviewer what "done" meant. The gate does not judge the quality of the sections, only
// that each one exists and has content, so a person can always satisfy it in a minute.

export type DefinitionOfReadySection = 'acceptance_criteria' | 'out_of_scope' | 'verification';

const SECTION_LABELS: Record<DefinitionOfReadySection, RegExp> = {
  acceptance_criteria:
    /^(?:acceptance(?:\s+criteria)?|definition\s+of\s+done|done\s+when|dod|완료\s*조건|완료\s*기준|수용\s*기준|성공\s*기준|인수\s*조건)$/i,
  out_of_scope:
    /^(?:out[\s-]+of[\s-]+scope|non[\s-]?goals?|not\s+in\s+scope|범위\s*(?:밖|제외|외)|제외\s*범위|하지\s*않을\s*것)$/i,
  verification:
    /^(?:verif(?:y|ication)(?:\s+commands?)?|how\s+to\s+verify|test(?:s|ing)?(?:\s+(?:plan|targets?|commands?))?|검증(?:\s*방법|\s*명령)?|테스트(?:\s*대상|\s*계획)?)$/i,
};

const ALL_SECTIONS = Object.keys(SECTION_LABELS) as DefinitionOfReadySection[];

/** Strip markdown decoration from a candidate label line: `## Acceptance criteria:` → `Acceptance criteria`. */
function normaliseLabel(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .replace(/[*_]{1,3}\s*:?\s*$/, '')
    .replace(/\s*[:：]\s*$/, '')
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .trim();
}

/**
 * Which of the three sections the issue body lacks. A section counts when a line that is only its
 * label (a markdown heading, a bold label, or `Label:`) is followed by non-empty content before the
 * next heading, or when the label is inline with content (`**Out of scope:** billing`).
 */
export function missingDefinitionOfReadySections(description: string | undefined): DefinitionOfReadySection[] {
  const lines = (description ?? '').split(/\r?\n/);
  const found = new Set<DefinitionOfReadySection>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const inline = /^(?:#{1,6}\s+)?(?:[*_]{1,3})?([^*_:：\n]{2,60}?)(?:[*_]{1,3})?\s*[:：]\s*(?:[*_]{1,3})?\s*(\S.*)$/.exec(line);
    for (const key of ALL_SECTIONS) {
      if (found.has(key)) continue;
      if (inline && SECTION_LABELS[key].test(inline[1].trim()) && inline[2].replace(/[*_]/g, '').trim()) {
        found.add(key);
        continue;
      }
      const isLabelLine = /^#{1,6}\s+/.test(line) || /^[*_]{1,3}.+[*_]{1,3}\s*:?$/.test(line) || /[:：]$/.test(line);
      if (!isLabelLine || !SECTION_LABELS[key].test(normaliseLabel(line))) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (/^#{1,6}\s+/.test(next)) break;
        found.add(key);
        break;
      }
    }
  }
  return ALL_SECTIONS.filter(key => !found.has(key));
}

const SECTION_PROMPTS: Record<DefinitionOfReadySection, string> = {
  acceptance_criteria: '`## Acceptance criteria` — the observable result that makes this issue done.',
  out_of_scope: '`## Out of scope` — what this issue must not change (write "none" if nothing is excluded).',
  verification: '`## Verification` — at least one command or test target that proves it (e.g. `npx vitest run src/x.test.ts`).',
};

/** The one comment the drafter posts. It proposes sections; it never edits the issue body. */
export function definitionOfReadyProposal(missing: readonly DefinitionOfReadySection[]): string {
  return [
    '[OpenSwarm] This issue is not ready for dispatch (Definition of Ready, AGT-4805).',
    '',
    'OpenSwarm will not claim it until the issue body has these sections:',
    ...missing.map(key => `- ${SECTION_PROMPTS[key]}`),
    '',
    'Add them to the description and the next heartbeat picks the issue up. OpenSwarm does not edit the description itself.',
    '',
    // The sign-off isDaemonComment recognises, so this comment never changes the issue's input fingerprint.
    '_via OpenSwarm · Definition of Ready_',
  ].join('\n');
}

/** Idempotency marker: one proposal per issue, ever. */
export function definitionOfReadyMarker(issueId: string): string {
  return `definition-of-ready:${issueId}`;
}

export type DefinitionOfReadyTask = ReadinessTask & {
  issueId?: string;
  description?: string;
  projectPath?: string;
  linearProject?: { id: string };
};

// Bodies the daemon writes itself (decomposition children, reviewer follow-ups) do not carry the
// three sections; gating them would park the daemon's own split of work it already accepted.
const DAEMON_AUTHORED = [/_Split out from ".*" during planning\._/, /^Follow-up (?:from|recommended by) (?:the )?reviewer\./];

/** The daemon wrote this issue body (planner split or reviewer follow-up): not gated. */
export function isDaemonAuthoredBody(description: string | undefined): boolean {
  const body = description ?? '';
  return DAEMON_AUTHORED.some(pattern => pattern.test(body));
}

export interface DefinitionOfReadyHooks<T extends DefinitionOfReadyTask> {
  /** Whether the gate applies to this task's project. Absent setting = on. Asked only for a task that would be held. */
  enabled: (task: T) => boolean | Promise<boolean>;
  /** Post the proposal comment. Omitted (e.g. a local task source) = hold silently. */
  comment?: (issueId: string, body: string, marker: string) => Promise<void>;
}

// Linear dedupes by comment id, but each repeat still costs a failed create and a lookup on every
// heartbeat. Remember what this process already posted.
const proposed = new Set<string>();

/** Test hook. */
export function resetDefinitionOfReadyMemo(): void {
  proposed.clear();
}

/**
 * `partitionByReadiness`, then hold every Todo issue that lacks a Definition of Ready and post one
 * proposal comment on it. Only Todo is gated: In Progress and In Review are the daemon resuming its
 * own runs, and an explicit dispatch is the operator's decision.
 */
export async function partitionByDefinitionOfReady<T extends DefinitionOfReadyTask>(
  tasks: readonly T[],
  options: ReadinessOptions & { definitionOfReady?: DefinitionOfReadyHooks<T> },
): Promise<ReadinessPartition<T>> {
  const base = partitionByReadiness(tasks, options);
  const hooks = options.definitionOfReady;
  if (!hooks) return base;
  const ready: T[] = [];
  for (const task of base.ready) {
    if (task.explicitDispatch || task.linearState !== 'Todo' || isDaemonAuthoredBody(task.description)) {
      ready.push(task);
      continue;
    }
    const missing = missingDefinitionOfReadySections(task.description);
    if (missing.length === 0 || !(await hooks.enabled(task))) {
      ready.push(task);
      continue;
    }
    const reason = `definition_of_ready:${missing.join(',')}`;
    const keys = base.held.get(reason) ?? [];
    keys.push(task.issueIdentifier ?? task.id ?? '?');
    base.held.set(reason, keys);
    if (task.issueId && hooks.comment) {
      const marker = definitionOfReadyMarker(task.issueId);
      if (proposed.has(marker)) continue;
      try {
        await hooks.comment(task.issueId, definitionOfReadyProposal(missing), marker);
        proposed.add(marker);
      } catch (error) {
        console.warn('[readiness] Definition of Ready comment failed:', error instanceof Error ? error.message : error);
      }
    }
  }
  return { ready, held: base.held };
}

type ProjectAgentLike = { projectPath: string; linearProjectId?: string; requireDefinitionOfReady?: boolean };

/**
 * Hooks for the heartbeat: per-project opt-out via `projectAgents[].requireDefinitionOfReady: false`.
 * A fetched Linear task carries no `projectPath`, so the owning project is found by the configured
 * `linearProjectId` first and then by the runner's own path resolution (`resolveProjectPath`).
 * Only a Linear source is gated: a local task has no tracker body to fix and nowhere to comment.
 */
export function definitionOfReadyHooks<T extends DefinitionOfReadyTask>(
  projectAgents: ReadonlyArray<ProjectAgentLike> | undefined,
  source: { kind: string; addComment(issueId: string, body: string, idempotencyKey?: string): Promise<void> } | null | undefined,
  resolveProjectPath?: (task: T) => Promise<string | null | undefined>,
): DefinitionOfReadyHooks<T> {
  return {
    enabled: async task => {
      if (source?.kind !== 'linear') return false;
      const byLinearId = task.linearProject?.id
        ? projectAgents?.find(agent => agent.linearProjectId === task.linearProject?.id)
        : undefined;
      if (byLinearId) return byLinearId.requireDefinitionOfReady !== false;
      const path = task.projectPath ?? (await resolveProjectPath?.(task).catch(() => null)) ?? '';
      return resolveOwningProject(projectAgents, path)?.requireDefinitionOfReady !== false;
    },
    comment: source?.kind === 'linear' ? (issueId, body, marker) => source.addComment(issueId, body, marker) : undefined,
  };
}
