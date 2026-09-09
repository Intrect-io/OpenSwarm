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
    expect(mapModelForProvider('claude', 'openai/gpt-5')).toBeUndefined();
    expect(mapModelForProvider('claude', 'z-ai/glm-5.2')).toBeUndefined(); // OpenRouter escalation
  });

  it('openrouter keeps namespaced ids, drops bare ids and atlascloud ids', () => {
    expect(mapModelForProvider('openrouter', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(mapModelForProvider('openrouter', 'claude-sonnet-5')).toBeUndefined();
    expect(mapModelForProvider('openrouter', 'gpt-5.5')).toBeUndefined();
    expect(mapModelForProvider('openrouter', 'zai-org/GLM-4.6')).toBeUndefined(); // atlascloud id
  });

  it('cursor passes everything through', () => {
    expect(mapModelForProvider('cursor', 'gpt-5.5')).toBe('gpt-5.5');
    expect(mapModelForProvider('cursor', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(mapModelForProvider('cursor', '')).toBeUndefined();
  });

  it('gpt passes namespaced ids and drops bare ids', () => {
    expect(mapModelForProvider('gpt', 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(mapModelForProvider('gpt', 'gpt-5.5')).toBeUndefined();
  });

  it('local passes namespaced ids and drops bare ids', () => {
    expect(mapModelForProvider('local', 'ollama/gemma3')).toBe('ollama/gemma3');
    expect(mapModelForProvider('local', 'gemma3')).toBeUndefined();
  });

  it('lmstudio passes namespaced ids and drops bare ids', () => {
    expect(mapModelForProvider('lmstudio', 'lm-studio/gemma-3-4b')).toBe('lm-studio/gemma-3-4b');
    expect(mapModelForProvider('lmstudio', 'gemma-3-4b')).toBeUndefined();
  });

  describe('atlascloud', () => {
    it('keeps curated models', () => {
      expect(mapModelForProvider('atlascloud', 'deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
    });

    it('keeps models found in the live-fetched catalog cache even when not curated', () => {
      vi.mocked(readCachedCatalog).mockReturnValue({ models: ['qwen/qwen3.5-flash'], fetchedAt: '2026-08-04T00:00:00.000Z' });
      expect(mapModelForProvider('atlascloud', 'qwen/qwen3.5-flash')).toBe('qwen/qwen3.5-flash');
    });

    it('does not leak an Atlas Cloud id into openrouter on the reverse switch', () => {
      expect(mapModelForProvider('openrouter', 'zai-org/GLM-4.6')).toBeUndefined();
      // An id genuinely foreign to Atlas still carries over to openrouter as before.
      expect(mapModelForProvider('openrouter', 'z-ai/glm-5.2')).toBe('z-ai/glm-5.2');
    });
  });

  describe('discard warning', () => {
    it('logs warning when codex-responses rejects an OpenRouter model id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mapModelForProvider('codex-responses', 'deepseek/deepseek-v4-flash', 'worker')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Role 'worker' rejected model 'deepseek/deepseek-v4-flash' for adapter 'codex-responses'"),
      );
      // The replacement default must be visible so the operator sees what the
      // rejected model is being replaced by (AGT-4232).
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to 'gpt-5.6-terra'"),
      );
      warn.mockRestore();
    });

    it('logs warning when openrouter rejects a codex gpt-* model id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mapModelForProvider('openrouter', 'gpt-5.6-terra', 'decompose')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Role 'decompose' rejected model 'gpt-5.6-terra' for adapter 'openrouter'"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to 'deepseek/deepseek-v4-flash'"),
      );
      warn.mockRestore();
    });

    it('logs warning without role when role is omitted', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mapModelForProvider('claude', 'gpt-5.5')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("rejected model 'gpt-5.5' for adapter 'claude'"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.not.stringContaining('Role'),
      );
      warn.mockRestore();
    });

    it('does not log warning when model is accepted', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mapModelForProvider('codex-responses', 'gpt-5.6-terra', 'worker')).toBe('gpt-5.6-terra');
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
