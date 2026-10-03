// Created: 2026-10-03
// Purpose: the draft's scope verdict — whether an autonomous worker can usefully act on a task in this repository (AGT-4662)
// Dependencies: none

/** Why a task cannot be worked here. Closed set: the gate acts on it. */
export const SCOPE_KINDS = ['wrong_repository', 'human_action_only', 'blocked_by_dependency', 'out_of_goal'] as const;
export type DraftScopeKind = (typeof SCOPE_KINDS)[number];

export interface DraftScopeVerdict {
  /** Always false: the field is only ever emitted to decline a task. */
  applicable: false;
  kind: DraftScopeKind;
  confidence: number;
  reason: string;
  evidence: string[];
}

/** Same bar as the duplicate-grooming gate: a decline needs a measured claim, not a hunch. */
export const SCOPE_GATE_MIN_CONFIDENCE = 0.9;
export const SCOPE_GATE_MIN_EVIDENCE = 2;

/**
 * Parse the model's `scope` object. Anything that is not a well-formed decline
 * becomes undefined, so a malformed or missing field never blocks a task.
 */
export function parseScopeVerdict(raw: unknown): DraftScopeVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.applicable !== false) return undefined;
  const kind = SCOPE_KINDS.find((candidate) => candidate === value.kind);
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!kind || !reason) return undefined;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : 0;
  return { applicable: false, kind, confidence, reason, evidence };
}

/** Whether a verdict is strong enough to stop the worker from starting. */
export function isScopeDeclined(scope: DraftScopeVerdict | undefined): scope is DraftScopeVerdict {
  return !!scope
    && scope.confidence >= SCOPE_GATE_MIN_CONFIDENCE
    && scope.evidence.length >= SCOPE_GATE_MIN_EVIDENCE;
}

/**
 * The two prompt fragments the drafter needs to produce a verdict: the JSON
 * field and the rules for filling it. Both are empty without a goal, so a
 * project that sets none gets the exact prompt it always had.
 */
export function scopePromptParts(goal: string | undefined): { field: string; rules: string } {
  if (!goal?.trim()) return { field: '', rules: '' };
  return {
    field: ',\n  "scope": {"applicable": false, "kind": "wrong_repository" | "human_action_only" | "blocked_by_dependency" | "out_of_goal", '
      + '"confidence": 0.0, "reason": "one sentence", "evidence": ["concrete fact you verified"]}  // optional: ONLY when this task cannot be done here',
    rules: `
### scope (only because a Standing project goal is set)
Decide whether an autonomous worker can usefully act on this task in THIS repository. Include "scope" ONLY when it cannot, and omit the field otherwise. Hard tasks, large tasks and tasks that need narrowing are still in scope: narrow them as described above.
- wrong_repository: the files, services or runtime the task names do not exist in this repository (you searched for them) and the work belongs to another one.
- human_action_only: completing it needs something only a person can do (send a message to a customer or vendor, obtain an approval, wait for an external reply, change production data by hand) and there is no code or doc change you can describe that completes it.
- blocked_by_dependency: it needs the output of another open issue that is not done yet, and the Standing project goal makes that order binding.
- out_of_goal: completing it would not move the Standing project goal forward.
Use confidence >= 0.90 only with at least two concrete pieces of evidence (a path you searched that has nothing, the line of the task that says the action is human-only, the open issue it waits on). If the task has a code or doc deliverable you can name, it is in scope.
`,
  };
}
