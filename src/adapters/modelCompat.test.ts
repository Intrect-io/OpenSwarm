import { afterEach, describe, it, expect, vi } from 'vitest';
import { readCachedCatalog } from './modelCatalog.js';

vi.mock('./modelCatalog.js', () => ({ readCachedCatalog: vi.fn(() => null) }));

const { mapModelForProvider } = await import('./modelCompat.js');

// Regression for INT-2510: decomposition.plannerModel 'gpt-5.5' leaked into
// `claude -p --model gpt-5.5` after a provider switch → API 404 on every
// decomposition attempt.
describe('mapModelForProvider', () => {
  afterEach(() => {
    vi.mocked(readCachedCatalog).mockReset().mockReturnValue(null);
  });

  it('codex keeps gpt-* slugs and drops everything else', () => {
    expect(mapModelForProvider('codex-responses', 'gpt-5.5')).toBe('gpt-5.5');
    expect(mapModelForProvider('codex', 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(mapModelForProvider('codex-responses', 'sonnet')).toBeUndefined();
    expect(mapModelForProvider('codex-responses', 'qwen/qwen3-coder')).toBeUndefined();
  });

  it('claude keeps claude-* ids and version-agnostic aliases, drops foreign ids', () => {
    expect(mapModelForProvider('claude', 'sonnet')).toBe('sonnet');
    expect(mapModelForProvider('claude', 'opus')).toBe('opus');
    expect(mapModelForProvider('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(mapModelForProvider('claude', 'gpt-5.5')).toBeUndefined(); // the INT-2510 leak
    expect(mapModelForProvider('claude', 'openai/gpt-5')).toBeUndefined(); // config schema default
    expect(mapModelForProvider('claude', 'z-ai/glm-5.2')).toBeUndefined(); // OpenRouter escalation
  });

  it('openrouter-style adapters keep namespaced ids only', () => {
    expect(mapModelForProvider('openrouter', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(mapModelForProvider('openrouter', 'claude-sonnet-5')).toBeUndefined();
    expect(mapModelForProvider('gpt', 'sonnet')).toBeUndefined();
    expect(mapModelForProvider('local', 'qwen/qwen3-coder')).toBe('qwen/qwen3-coder');
  });

  it('empty/blank models resolve to undefined (adapter default)', () => {
    expect(mapModelForProvider('claude', undefined)).toBeUndefined();
    expect(mapModelForProvider('claude', '  ')).toBeUndefined();
  });

  // Regression: atlascloud and openrouter both name models "vendor/model", but
  // the vendor slugs are different catalogs (OpenRouter's z-ai/glm-5.2 vs
  // Atlas's own zai-org/GLM-4.6). Before this fix, atlascloud fell into the
  // generic "any namespaced id survives" branch, so switching provider to
  // atlascloud kept an openrouter-configured reviewer/worker model verbatim —
  // confirmed live against api.atlascloud.ai: that id 400s ("not found") on
  // every single call, failing every review.
  describe('atlascloud', () => {
    it('keeps a curated Atlas Cloud id', () => {
      expect(mapModelForProvider('atlascloud', 'deepseek-ai/deepseek-v4-pro')).toBe('deepseek-ai/deepseek-v4-pro');
    });

    it('drops an OpenRouter-namespaced id even though it looks like "vendor/model"', () => {
      expect(mapModelForProvider('atlascloud', 'z-ai/glm-5.2')).toBeUndefined();
      expect(mapModelForProvider('atlascloud', 'deepseek/deepseek-v4-flash')).toBeUndefined();
    });

    it('keeps an id found in the live-fetched catalog cache even when not curated', () => {
      vi.mocked(readCachedCatalog).mockReturnValue({ models: ['qwen/qwen3.5-flash'], fetchedAt: '2026-08-04T00:00:00.000Z' });
      expect(mapModelForProvider('atlascloud', 'qwen/qwen3.5-flash')).toBe('qwen/qwen3.5-flash');
    });

    it('does not leak an Atlas Cloud id into openrouter on the reverse switch', () => {
      expect(mapModelForProvider('openrouter', 'zai-org/GLM-4.6')).toBeUndefined();
      // An id genuinely foreign to Atlas still carries over to openrouter as before.
      expect(mapModelForProvider('openrouter', 'z-ai/glm-5.2')).toBe('z-ai/glm-5.2');
    });
  });
});
