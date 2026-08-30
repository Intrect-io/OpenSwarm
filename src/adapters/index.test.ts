import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';
import {
  listAdapterNames,
  listBoundarySafeModels,
  isKnownAdapter,
  probeAdapterAvailability,
  resolveBoundarySafeDefaultModel,
} from './index.js';
import { configureHumanSurfaceReadOnly } from '../mcp/humanSurfacePolicy.js';

afterEach(() => {
  configureHumanSurfaceReadOnly(false);
  vi.restoreAllMocks();
});

describe('isKnownAdapter', () => {
  it('accepts currently-registered adapters (incl. claude, the opt-in claude -p delegate)', () => {
    for (const name of ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'claude', 'cc-router', 'cursor']) {
      expect(isKnownAdapter(name)).toBe(true);
    }
  });

  it('rejects unknown providers', () => {
    expect(isKnownAdapter('')).toBe(false);
    expect(isKnownAdapter('anthropic')).toBe(false);
    expect(isKnownAdapter('gpt5')).toBe(false);
    // must not be fooled by Object.prototype members
    expect(isKnownAdapter('toString')).toBe(false);
    expect(isKnownAdapter('constructor')).toBe(false);
  });

  it('listAdapterNames returns every registered adapter', () => {
    expect([...listAdapterNames()].sort()).toEqual(
      ['atlascloud', 'cc-router', 'claude', 'codex', 'cursor', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter'].sort(),
    );
  });
});

describe('adapter discovery human-surface boundary', () => {
  function adapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
    return {
      name: 'delegated-test',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: true,
        supportsModelSelection: true,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: vi.fn(async () => true),
      getDefaultModel: vi.fn(async () => 'model-a'),
      listModels: vi.fn(async () => ['model-a']),
      buildCommand: vi.fn(() => ({ command: 'fake-cli', args: [] })),
      parseWorkerOutput: vi.fn(),
      parseReviewerOutput: vi.fn(),
      ...overrides,
    };
  }

  it('does not invoke delegated availability or model probes in strict mode', async () => {
    const delegated = adapter();
    configureHumanSurfaceReadOnly(true);

    await expect(probeAdapterAvailability(delegated)).resolves.toBe(false);
    await expect(resolveBoundarySafeDefaultModel(delegated)).rejects.toThrow('HUMAN_SURFACE_READ_ONLY');
    await expect(listBoundarySafeModels(delegated)).rejects.toThrow('HUMAN_SURFACE_READ_ONLY');

    expect(delegated.isAvailable).not.toHaveBeenCalled();
    expect(delegated.getDefaultModel).not.toHaveBeenCalled();
    expect(delegated.listModels).not.toHaveBeenCalled();
    expect(delegated.buildCommand).not.toHaveBeenCalled();
  });

  it('keeps discovery for a policy-enforcing native adapter', async () => {
    const native = adapter({
      name: 'native-test',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: true,
        supportsModelSelection: true,
        managedGit: false,
        supportedSkills: [],
        enforcesHumanSurfaceReadOnly: true,
      },
      run: vi.fn(),
    });
    configureHumanSurfaceReadOnly(true);

    await expect(probeAdapterAvailability(native)).resolves.toBe(true);
    await expect(resolveBoundarySafeDefaultModel(native)).resolves.toBe('model-a');
    await expect(listBoundarySafeModels(native)).resolves.toEqual(['model-a']);
  });
});
