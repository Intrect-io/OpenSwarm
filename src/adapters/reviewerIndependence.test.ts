import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  ADAPTER_DEFAULT_MODELS,
  assertIndependentReviewer,
  collectReviewerFamilyViolations,
  modelFamily,
  type ReviewerIndependenceConfig,
} from './reviewerIndependence.js';
import { loadConfig } from '../core/config.js';
import { CLAUDE_DEFAULT_MODEL } from './claude.js';
import { CODEX_DEFAULT_MODEL } from './codex.js';
import { DEFAULT_MODEL as CODEX_RESPONSES_DEFAULT_MODEL } from './codexResponses.js';
import { DEFAULT_MODEL as GPT_DEFAULT_MODEL } from './gpt.js';
import { DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL } from './openrouter.js';
import { ATLASCLOUD_DEFAULT_MODEL } from './atlascloud.js';
import { DEFAULT_MODEL as LOCAL_DEFAULT_MODEL } from './local.js';
import { OLLAMA_CLOUD_DEFAULT_MODEL } from './ollamaCloud.js';

describe('modelFamily (AGT-4806)', () => {
  it.each([
    ['claude-sonnet-4-20250514', 'anthropic'],
    ['claude-haiku-4-5-20251001', 'anthropic'],
    ['sonnet', 'anthropic'],
    ['anthropic/claude-opus-4', 'anthropic'],
    ['gpt-5.6-terra', 'openai'],
    ['gpt-5-codex', 'openai'],
    ['openai/gpt-4o', 'openai'],
    ['o3-mini', 'openai'],
    ['deepseek/deepseek-v4-flash', 'deepseek'],
    ['deepseek-ai/deepseek-v4-pro', 'deepseek'],
    ['google/gemini-2.5-pro', 'google'],
    ['gemma3:4b', 'google'],
    ['qwen/qwen3-coder', 'qwen'],
    ['meta-llama/llama-4', 'meta'],
    ['mistralai/codestral-2', 'mistral'],
    ['x-ai/grok-4', 'xai'],
    ['kimi-k2.6', 'moonshot'],
    ['glm-5.3', 'zhipu'],
    ['z-ai/glm-4.6', 'zhipu'],
  ])('%s → %s', (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it.each(['local-model', 'my-finetune', '', undefined])('cannot name %s', (model) => {
    expect(modelFamily(model)).toBeNull();
  });
});

describe('adapter defaults stay in step with the adapters', () => {
  it('pins every literal to the adapter\'s exported default', () => {
    expect(ADAPTER_DEFAULT_MODELS).toEqual({
      claude: CLAUDE_DEFAULT_MODEL,
      codex: CODEX_DEFAULT_MODEL,
      'codex-responses': CODEX_RESPONSES_DEFAULT_MODEL,
      gpt: GPT_DEFAULT_MODEL,
      openrouter: OPENROUTER_DEFAULT_MODEL,
      atlascloud: ATLASCLOUD_DEFAULT_MODEL,
      local: LOCAL_DEFAULT_MODEL,
      'ollama-cloud': OLLAMA_CLOUD_DEFAULT_MODEL,
    });
  });
});

function config(autonomous: NonNullable<ReviewerIndependenceConfig['autonomous']>, adapter = 'codex-responses'): ReviewerIndependenceConfig {
  return { adapter, autonomous };
}

describe('collectReviewerFamilyViolations (AGT-4806)', () => {
  it('fails a config that resolves both roles to the same family', () => {
    const violations = collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { model: 'gpt-5.6-sol' } },
    }));
    expect(violations).toEqual([
      "autonomous.defaultRoles: reviewer 'gpt-5.6-sol' (openai) is the same model family as worker 'gpt-5.6-terra' (openai)",
    ]);
  });

  it('fails when neither role names a model: both fall back to the same adapter default', () => {
    expect(collectReviewerFamilyViolations(config({}))).toHaveLength(1);
  });

  it('passes a reviewer from another family', () => {
    expect(collectReviewerFamilyViolations(config({
      defaultRoles: {
        worker: { model: 'gpt-5.6-terra' },
        reviewer: { adapter: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
      },
    }))).toEqual([]);
  });

  it('resolves a role without a model to its own adapter\'s default', () => {
    // openrouter's default is a deepseek model; the worker stays on GPT.
    expect(collectReviewerFamilyViolations(config({
      defaultRoles: { worker: {}, reviewer: { adapter: 'openrouter' } },
    }))).toEqual([]);
  });

  it('fails a family it cannot name: independence has to be shown', () => {
    const violations = collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { adapter: 'lmstudio', model: 'local-model' } },
    }));
    expect(violations[0]).toMatch(/reviewer 'local-model' \(unknown family\) cannot be shown to be a different model family/);
  });

  it('counts the worker\'s escalation model as a worker model', () => {
    const violations = collectReviewerFamilyViolations(config({
      defaultRoles: {
        worker: { model: 'deepseek/deepseek-v4-flash', escalateModel: 'claude-sonnet-4-20250514', adapter: 'openrouter' },
        reviewer: { model: 'claude-opus-4', adapter: 'openrouter' },
      },
    }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("worker 'claude-sonnet-4-20250514' (anthropic)");
  });

  it('checks a projectAgents override merged onto the default roles', () => {
    const violations = collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { adapter: 'openrouter', model: 'deepseek/deepseek-v4-flash' } },
      projectAgents: [{ projectPath: '/repo', roles: { reviewer: { adapter: 'codex-responses', model: 'gpt-5.6-sol' } } }],
    }));
    expect(violations).toEqual([
      "autonomous.projectAgents[/repo].roles: reviewer 'gpt-5.6-sol' (openai) is the same model family as worker 'gpt-5.6-terra' (openai)",
    ]);
  });

  it('checks a jobProfile that replaces the stage models', () => {
    const violations = collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { adapter: 'openrouter', model: 'deepseek/deepseek-v4-flash' } },
      jobProfiles: [{ name: 'light', roles: { worker: 'deepseek/deepseek-v4-flash' } }],
    }));
    expect(violations[0]).toMatch(/^autonomous\.jobProfiles\[light\]: .* is the same model family/);
  });

  it('checks the legacy models block when there are no defaultRoles', () => {
    expect(collectReviewerFamilyViolations(config({ models: { worker: 'claude-haiku-4-5', reviewer: 'claude-sonnet-4' } }))).toHaveLength(1);
  });

  it('still checks a disabled reviewer role: the PR-time fresh review runs on its model', () => {
    expect(collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { enabled: false, model: 'gpt-5.6-sol' } },
    }))).toHaveLength(1);
  });

  it('skips a scope whose worker is switched off: nothing is produced to review', () => {
    expect(collectReviewerFamilyViolations(config({
      defaultRoles: { worker: { enabled: false, model: 'gpt-5.6-terra' }, reviewer: { model: 'gpt-5.6-sol' } },
    }))).toEqual([]);
  });

  it('accepts a same-family review only with the explicit override', () => {
    expect(collectReviewerFamilyViolations(config({
      allowSameFamilyReview: true,
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { model: 'gpt-5.6-sol' } },
    }))).toEqual([]);
  });

  it('does nothing without an autonomous section', () => {
    expect(collectReviewerFamilyViolations({ adapter: 'codex-responses' })).toEqual([]);
  });
});

describe('assertIndependentReviewer (AGT-4806)', () => {
  it('fails with a clear error naming the scope, both models and the override', () => {
    expect(() => assertIndependentReviewer(config({
      defaultRoles: { worker: { model: 'gpt-5.6-terra' }, reviewer: { model: 'gpt-5.6-sol' } },
    }))).toThrowError(/worker's model family[\s\S]*autonomous\.defaultRoles: reviewer 'gpt-5\.6-sol' \(openai\)[\s\S]*allowSameFamilyReview: true/);
  });

  it('lets the shipped example config start (it opts in explicitly)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loaded = loadConfig(fileURLToPath(new URL('../../config.example.yaml', import.meta.url)));
      expect(loaded.autonomous?.allowSameFamilyReview).toBe(true);
      expect(() => assertIndependentReviewer(loaded)).not.toThrow();
      // …and the opt-in is what lets it start: without it the example's GPT pair fails.
      expect(collectReviewerFamilyViolations({ ...loaded, autonomous: { ...loaded.autonomous, allowSameFamilyReview: false } }).length)
        .toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
