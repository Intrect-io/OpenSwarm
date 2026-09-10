// ============================================
// OpenSwarm — the stage IS the role, and it has to travel (AGT-4273)
// ============================================
//
// `compatibleStageModel` had the stage name in hand and did not pass it to
// `mapModelForProvider`. Nothing referenced this module from any test file, so
// the omission was invisible: an adapter that resolves per role saw `undefined`
// at every stage boundary and handed the reviewer the same model as the worker,
// which is the review layer quietly ceasing to be a second opinion.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../adapters/modelCatalog.js', () => ({
  // Never read the developer's real ~/.openswarm state from a unit test: an
  // ambient catalogue silently decided this suite's verdict once already.
  readCachedCatalog: () => null,
  writeCachedCatalog: () => {},
}));


import { compatibleStageModel, modelForTask } from './pipelineRoleSelection.js';
import type { PipelineConfig } from './pairPipelineTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const task = (estimatedMinutes = 5) => ({ id: 't1', title: 'x', estimatedMinutes }) as TaskItem;

function cursorConfig(model: string): PipelineConfig {
  return {
    stages: ['worker', 'reviewer'],
    roles: {
      worker: { adapter: 'cursor', model },
      reviewer: { adapter: 'cursor', model },
    },
  } as unknown as PipelineConfig;
}

describe('compatibleStageModel', () => {
  it('gives the reviewer a different model from the worker on cursor', () => {
    const config = cursorConfig('deepseek/deepseek-v4-flash');

    const worker = compatibleStageModel(config, 'worker', 'deepseek/deepseek-v4-flash');
    const reviewer = compatibleStageModel(config, 'reviewer', 'deepseek/deepseek-v4-flash');

    expect(worker).toBe('auto');
    expect(reviewer).toBe('cursor-grok-4.6-high');
    // The assertion that matters: not the specific ids, but that a corrector
    // exists at all. Dropping the stage argument makes these equal.
    expect(reviewer).not.toBe(worker);
  });

  it('routes the remaining stages by their own role', () => {
    // Every stage needs its own `roles` entry: without one there is no adapter
    // to be compatible WITH, and the model passes through untouched.
    const config = {
      stages: ['tester', 'documenter', 'auditor'],
      roles: {
        tester: { adapter: 'cursor', model: 'gpt-5-codex' },
        documenter: { adapter: 'cursor', model: 'gpt-5-codex' },
        auditor: { adapter: 'cursor', model: 'gpt-5-codex' },
      },
    } as unknown as PipelineConfig;

    expect(compatibleStageModel(config, 'tester', 'gpt-5-codex')).toBe('auto');
    expect(compatibleStageModel(config, 'documenter', 'gpt-5-codex')).toBe('auto');
    expect(compatibleStageModel(config, 'auditor', 'gpt-5-codex')).toBe('cursor-grok-4.6-high');
  });

  it('resolves a reviewer escalation as an escalation, not as the reviewer', () => {
    // pairPipeline runs the escalation IN the reviewer stage. Resolving it by
    // stage gave it the reviewer's own model while the pipeline logged that it
    // was escalating to something else.
    const config = cursorConfig('deepseek/deepseek-v4-flash');

    const reviewer = compatibleStageModel(config, 'reviewer', 'deepseek/deepseek-v4-flash');
    const escalated = compatibleStageModel(config, 'reviewer', 'gpt-5.6-terra-max', 'escalate');

    expect(escalated).toBe('cursor-grok-4.6-xhigh');
    expect(escalated).not.toBe(reviewer);
  });

  it('leaves the model untouched when the stage pins no adapter', () => {
    const config = { stages: ['worker'], roles: {} } as unknown as PipelineConfig;

    expect(compatibleStageModel(config, 'worker', 'deepseek/deepseek-v4-flash'))
      .toBe('deepseek/deepseek-v4-flash');
  });

  it('still drops an incompatible id for adapters that reject rather than route', () => {
    const config = {
      stages: ['worker'],
      roles: { worker: { adapter: 'codex', model: 'x' } },
    } as unknown as PipelineConfig;

    expect(compatibleStageModel(config, 'worker', 'deepseek/deepseek-v4-flash')).toBeUndefined();
    expect(compatibleStageModel(config, 'worker', 'gpt-5-codex')).toBe('gpt-5-codex');
  });
});

describe('modelForTask', () => {
  it('prefers a matching jobProfile model over the role default, both role-routed', () => {
    const config = {
      stages: ['worker', 'reviewer'],
      roles: {
        worker: { adapter: 'cursor', model: 'gpt-5-codex' },
        reviewer: { adapter: 'cursor', model: 'gpt-5-codex' },
      },
      jobProfiles: [{ name: 'light', maxMinutes: 10, roles: { worker: 'sonnet', reviewer: 'sonnet' } }],
    } as unknown as PipelineConfig;

    expect(modelForTask(config, 'worker', task(5))).toBe('auto');
    expect(modelForTask(config, 'reviewer', task(5))).toBe('cursor-grok-4.6-high');
  });

  it('falls back to the role model when the matching profile pins nothing for this stage', () => {
    // The `??` chain depends on the first call returning undefined. That still
    // holds for cursor, whose branch otherwise never returns undefined, because
    // the empty-model guard fires before any adapter branch is reached — but
    // the case is worth pinning, since making the cursor branch total is
    // exactly the kind of change that quietly swallows a fallback.
    const config = {
      stages: ['reviewer'],
      roles: { reviewer: { adapter: 'cursor', model: 'gpt-5-codex' } },
      jobProfiles: [{ name: 'light', maxMinutes: 10, roles: { worker: 'sonnet' } }],
    } as unknown as PipelineConfig;

    expect(modelForTask(config, 'reviewer', task(5))).toBe('cursor-grok-4.6-high');
  });

  it('falls back to the role model when no profile matches', () => {
    const config = {
      stages: ['reviewer'],
      roles: { reviewer: { adapter: 'cursor', model: 'gpt-5-codex' } },
      jobProfiles: [{ name: 'heavy', minMinutes: 100, roles: { reviewer: 'sonnet' } }],
    } as unknown as PipelineConfig;

    expect(modelForTask(config, 'reviewer', task(5))).toBe('cursor-grok-4.6-high');
  });
});
