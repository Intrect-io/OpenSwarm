// ============================================
// OpenSwarm - a pipeline needs an explicit worker fence (AGT-4815)
// ============================================
//
// `workerSandbox` used to be optional, and unset meant unfenced: three entry
// points (PR remediation, the conflict resolver, `openswarm run`) built
// pipelines without it while the config said `on`. It is now required by the
// type and checked at runtime for callers the type does not reach.

import { describe, expect, it } from 'vitest';
import { PairPipeline, createDefaultPipeline, createFullPipeline, createPipelineFromConfig } from './pairPipeline.js';

const configOf = (pipeline: PairPipeline) => (pipeline as unknown as { config: { workerSandbox?: string } }).config;

describe('PairPipeline workerSandbox (AGT-4815)', () => {
  it('refuses to build a pipeline without an explicit workerSandbox', () => {
    const untyped = (config: object) => () => new PairPipeline(config as never);
    expect(untyped({ stages: ['worker'], maxIterations: 1 })).toThrow(/workerSandbox must be 'on' or 'off'/);
    expect(untyped({ stages: ['worker'], maxIterations: 1, workerSandbox: undefined })).toThrow(/workerSandbox/);
    expect(untyped({ stages: ['worker'], maxIterations: 1, workerSandbox: 'yes' })).toThrow(/workerSandbox/);

    // The factories carry the same requirement.
    expect(() => (createPipelineFromConfig as (...args: unknown[]) => PairPipeline)(undefined)).toThrow(/workerSandbox/);
    expect(() => (createDefaultPipeline as (...args: unknown[]) => PairPipeline)(3)).toThrow(/workerSandbox/);
    expect(() => (createFullPipeline as (...args: unknown[]) => PairPipeline)({})).toThrow(/workerSandbox/);
  });

  it('builds with an explicit on or off and keeps it', () => {
    expect(configOf(new PairPipeline({ stages: ['worker'], maxIterations: 1, workerSandbox: 'on' })).workerSandbox).toBe('on');
    expect(configOf(new PairPipeline({ stages: ['worker'], maxIterations: 1, workerSandbox: 'off' })).workerSandbox).toBe('off');
    expect(configOf(createDefaultPipeline(3, 'on')).workerSandbox).toBe('on');
    const fromConfig = createPipelineFromConfig(
      undefined, 3, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'on',
    );
    expect(configOf(fromConfig).workerSandbox).toBe('on');
  });
});
