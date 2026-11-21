// Created: 2026-11-21
// Purpose: synthetic replay of the 2026-10-20 AX dispatch incident through the readiness gate and the pre-claim hold (AGT-4784)
// Dependencies: definitionOfReady (partition), readinessGate (project skip labels), preClaimHold (hold), agentEligibility (default skip labels)
// Test Status: passing

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftScopeVerdict } from '../agents/draftScope.js';
import { DEFAULT_AGENT_SKIP } from './agentEligibility.js';
import { partitionByDefinitionOfReady } from './definitionOfReady.js';
import { holdBeforeClaim, preClaimDecision, resetPreClaimHoldMemo } from './preClaimHold.js';
import { projectSkipLabelsHook } from './readinessGate.js';

type FixtureTask = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  title: string;
  linearState: string;
  labels: string[];
  linearProject: { id: string; name: string };
  preAdmissionDraft?: { scope?: DraftScopeVerdict };
};
type ProjectAgent = { projectPath: string; linearProjectId: string; skipLabels: string[] };
type Fixture = { note: string; projectAgents: ProjectAgent[]; tasks: FixtureTask[] };

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ax-dispatch-20261020.json', import.meta.url), 'utf8'),
) as Fixture;

const BACKLOG_LABELLED = ['AX-2005', 'AX-2006', 'AX-2007', 'AX-2017', 'AX-2103', 'AX-2104', 'AX-2107', 'AX-2109', 'AX-2153'];
const DECISION_PENDING = ['AX-2148', 'AX-2145', 'AX-2034', 'AX-2147'];
const HUMAN_ONLY = ['AX-2144', 'AX-2154'];
const CONTROLS = ['AX-9001', 'AX-9002', 'AX-9003'];
const sorted = (keys: readonly string[]) => [...keys].sort();

interface ReplayOptions {
  includeBacklog?: boolean;
  projectAgents?: ProjectAgent[];
  mutate?: (task: FixtureTask) => void;
}

/** The readiness partition, then the pre-claim hold on the ready set. The Definition of Ready hooks and the human-owned title-tag step the runner also applies are left out: both only hold more issues. */
async function replay(options: ReplayOptions = {}) {
  const tasks = structuredClone(fixture.tasks);
  if (options.mutate) tasks.forEach(options.mutate);
  const { ready, held } = await partitionByDefinitionOfReady(tasks, {
    exclusionLabels: DEFAULT_AGENT_SKIP.labels,
    includeBacklog: options.includeBacklog ?? false,
    projectExclusionLabels: projectSkipLabelsHook(options.projectAgents ?? fixture.projectAgents),
  });
  const reasons = new Map<string, string>();
  for (const [reason, keys] of held) for (const key of keys) reasons.set(key, reason);
  for (const task of ready) {
    const decision = preClaimDecision(task, false);
    if (decision.hold) reasons.set(task.issueIdentifier, decision.reason);
  }
  const logs: string[] = [];
  const kept = await holdBeforeClaim(ready.map((task) => ({ task })), new Set(), {
    log: (line) => logs.push(line),
    label: (task) => task.issueIdentifier ?? task.id,
  });
  return { claimed: kept.map((c) => c.task.issueIdentifier), reasons, logs };
}

describe('2026-10-20 AX dispatch replay (AGT-4784)', () => {
  beforeEach(() => resetPreClaimHoldMemo());

  it('is a synthetic, anonymised stand-in for the operator-only replay', () => {
    expect(fixture.note).toMatch(/synthetic/i);
    expect(fixture.tasks.map((t) => t.issueIdentifier)).toEqual([...BACKLOG_LABELLED, ...DECISION_PENDING, ...HUMAN_ONLY, ...CONTROLS]);
    for (const task of fixture.tasks) expect(task.linearProject).toEqual({ id: 'proj-ax', name: 'AX' });
  });

  it('replays the 2026-10-20 AX dispatch fixture: no incident issue is claimed', async () => {
    const { claimed, reasons, logs } = await replay();
    expect(claimed).toEqual(CONTROLS);
    for (const key of BACKLOG_LABELLED) expect(reasons.get(key)).toBe('state:Backlog');
    for (const key of DECISION_PENDING) expect(reasons.get(key)).toBe('verdict:decision_pending');
    for (const key of HUMAN_ONLY) expect(reasons.get(key)).toBe('verdict:human_action_only');
    for (const key of CONTROLS) expect(reasons.has(key)).toBe(false);
    expect(reasons.size).toBe(BACKLOG_LABELLED.length + DECISION_PENDING.length + HUMAN_ONLY.length);
    // The hold names its reason in the log line for every issue it held.
    for (const key of [...DECISION_PENDING, ...HUMAN_ONLY]) {
      expect(logs.some((line) => line.includes(key) && line.includes(reasons.get(key)!))).toBe(true);
    }
  });

  it('(a) includeBacklog alone does not release the labelled Backlog issues; removing the label too does', async () => {
    const backlogOn = await replay({ includeBacklog: true });
    expect(backlogOn.claimed).toEqual(CONTROLS);
    for (const key of BACKLOG_LABELLED) expect(backlogOn.reasons.get(key)).toBe('label:추가 유지보수');

    const unlabelled = await replay({ includeBacklog: true, mutate: (t) => { t.labels = []; } });
    expect(sorted(unlabelled.claimed)).toEqual(sorted([...BACKLOG_LABELLED, ...CONTROLS]));
  });

  it('(a) the project label still holds with different case and padding', async () => {
    const { claimed, reasons } = await replay({
      includeBacklog: true,
      mutate: (t) => { t.labels = t.labels.map((label) => `  ${label.toUpperCase()} `); },
    });
    expect(claimed).toEqual(CONTROLS);
    for (const key of BACKLOG_LABELLED) expect(reasons.get(key)).toBe('label:추가 유지보수');
  });

  it('(b) an empty per-project skip list alone does not release them; with includeBacklog it does', async () => {
    const noProjectLabel = fixture.projectAgents.map((agent) => ({ ...agent, skipLabels: [] }));
    expect(projectSkipLabelsHook(noProjectLabel)).toBeUndefined();

    const backlogOff = await replay({ projectAgents: noProjectLabel });
    expect(backlogOff.claimed).toEqual(CONTROLS);
    for (const key of BACKLOG_LABELLED) expect(backlogOff.reasons.get(key)).toBe('state:Backlog');

    const backlogOn = await replay({ projectAgents: noProjectLabel, includeBacklog: true });
    expect(sorted(backlogOn.claimed)).toEqual(sorted([...BACKLOG_LABELLED, ...CONTROLS]));
  });

  it('(c) an actionable verdict alone releases only the decision-pending and human-only issues', async () => {
    // A draft that omits `scope` is the actionable verdict: the field is only emitted to decline.
    const { claimed, reasons } = await replay({ mutate: (t) => { if (t.preAdmissionDraft) t.preAdmissionDraft = {}; } });
    expect(sorted(claimed)).toEqual(sorted([...DECISION_PENDING, ...HUMAN_ONLY, ...CONTROLS]));
    for (const key of BACKLOG_LABELLED) expect(reasons.get(key)).toBe('state:Backlog');
  });
});
