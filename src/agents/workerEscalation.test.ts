import { describe, it, expect } from 'vitest';
import { buildRepeatEscalation, resolveWorkerStageOverrides } from './workerEscalation.js';
import type { RoleConfig } from '../core/types.js';

const workerCfg = (extra: Partial<RoleConfig> = {}): RoleConfig => ({
  enabled: true,
  model: 'base-model',
  timeoutMs: 0,
  ...extra,
});

describe('buildRepeatEscalation', () => {
  it('bumps effort to high when no escalateModel is configured (zero-config default)', () => {
    expect(buildRepeatEscalation({
      workerCfg: workerCfg(),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'low',
    })).toEqual({ model: undefined, reasoningEffort: 'high' });
  });

  it('escalates model and effort when escalateModel differs and effort is not high', () => {
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 99 }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'medium',
      // `modelRole: 'escalate'` travels with the model: this override reaches the
      // worker stage through the same merge as the iteration-count escalation,
      // and without it the stage resolves it through `worker` and escalates to
      // the worker's own model. (AGT-4273)
    })).toEqual({ model: 'bigger-model', reasoningEffort: 'high', modelRole: 'escalate' });
  });

  it('treats an already-active iteration escalation as a model no-op (effort only)', () => {
    // Default escalateAfterIteration=2: iteration 3 would run escalateModel
    // anyway — re-targeting it adds nothing, only the effort bump counts.
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model' }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'low',
    })).toEqual({ model: undefined, reasoningEffort: 'high' });
  });

  it('does not label an effort-only bump as a model escalation', () => {
    // No model changes, so there is nothing to resolve a role for; tagging it
    // would send the stage looking for an escalation model that is not there.
    const result = buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: undefined, escalateAfterIteration: 99 }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'medium',
    });

    // `toEqual` ignores undefined-valued properties, so it cannot tell an absent
    // key from one set to undefined — and that difference is the whole bug: an
    // own `model: undefined` overwrites the escalated model in the spread merge.
    expect(result).toStrictEqual({ reasoningEffort: 'high' });
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('modelRole');
  });

  it('returns undefined when nothing is left to escalate (abort path)', () => {
    // Iteration escalation already in effect AND effort already high.
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model' }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'high',
    })).toBeUndefined();
  });
});

describe('resolveWorkerStageOverrides', () => {
  const base = { taskId: 't1', taskPrefix: 'p' };

  it('labels an iteration-count escalation as an escalation', () => {
    // The worker twin of the reviewer escalation. Without the label the stage
    // resolved this override through `worker`, so on an adapter that routes per
    // role the model never changed — while the log line and the
    // `pipeline:escalation` event both told the dashboard it had. (AGT-4273)
    const overrides = resolveWorkerStageOverrides({
      ...base,
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 2 }),
      iteration: 2,
      baseModel: 'base-model',
      signalEscalation: undefined,
    });

    expect(overrides).toMatchObject({ model: 'bigger-model', modelRole: 'escalate' });
  });

  it('does not label the ordinary base model as an escalation', () => {
    const overrides = resolveWorkerStageOverrides({
      ...base,
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 99 }),
      iteration: 1,
      baseModel: 'base-model',
      signalEscalation: undefined,
    });

    expect(overrides).toEqual({ model: 'base-model' });
  });

  it('keeps the escalation label when a signal escalation merges over it', () => {
    // The spread at the end of resolveWorkerStageOverrides replaces `model`;
    // the label has to survive that, or the merged result resolves as `worker`.
    const overrides = resolveWorkerStageOverrides({
      ...base,
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 2 }),
      iteration: 2,
      baseModel: 'base-model',
      signalEscalation: { model: 'even-bigger', reasoningEffort: 'high', modelRole: 'escalate' },
    });

    expect(overrides).toMatchObject({ model: 'even-bigger', modelRole: 'escalate' });
  });

  it('keeps the escalated model when a real effort-only signal merges over it', () => {
    // Built by calling buildRepeatEscalation rather than written as a literal:
    // a hand-written signal cannot expose a defect in what that function
    // actually returns, and this is the merge where it mattered.
    const signalEscalation = buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 2 }),
      currentIteration: 2,
      currentModel: 'bigger-model',
      currentEffort: 'medium',
    });
    expect(signalEscalation).toStrictEqual({ reasoningEffort: 'high' });

    const overrides = resolveWorkerStageOverrides({
      ...base,
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 2 }),
      iteration: 2,
      baseModel: 'base-model',
      signalEscalation,
    });

    // The effort bump must ADD to the escalation, not undo it.
    expect(overrides).toStrictEqual({
      model: 'bigger-model', modelRole: 'escalate', reasoningEffort: 'high',
    });
  });
});
