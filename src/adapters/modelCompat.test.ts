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
  });

  it('openrouter keeps namespaced ids, drops bare ids and atlascloud ids', () => {
    expect(mapModelForProvider('openrouter', 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(mapModelForProvider('openrouter', 'z-ai/glm-4.7-flash')).toBe('z-ai/glm-4.7-flash');
    expect(mapModelForProvider('openrouter', 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
    expect(mapModelForProvider('openrouter', 'gpt-5.5')).toBeUndefined(); // bare id
    expect(mapModelForProvider('openrouter', 'atlascloud/llama-4')).toBeUndefined(); // atlascloud namespace
  });

  it('atlascloud keeps its own models, drops foreign ids', () => {
    expect(mapModelForProvider('atlascloud', 'atlascloud/llama-4')).toBe('atlascloud/llama-4');
    expect(mapModelForProvider('atlascloud', 'openai/gpt-5')).toBeUndefined();
    expect(mapModelForProvider('atlascloud', 'gpt-5.5')).toBeUndefined();
  });

  it('gpt adapter keeps namespaced ids, drops bare ids', () => {
    expect(mapModelForProvider('gpt', 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(mapModelForProvider('gpt', 'gpt-5.5')).toBeUndefined();
  });

  it('cursor adapter passes everything through', () => {
    expect(mapModelForProvider('cursor', 'gpt-5.5')).toBe('gpt-5.5');
    expect(mapModelForProvider('cursor', 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(mapModelForProvider('cursor', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('returns undefined for empty/undefined model', () => {
    expect(mapModelForProvider('codex-responses', undefined)).toBeUndefined();
    expect(mapModelForProvider('codex-responses', '')).toBeUndefined();
    expect(mapModelForProvider('codex-responses', '   ')).toBeUndefined();
  });

  describe('warning log on rejection', () => {
    it('logs warning when codex-responses rejects an openrouter-style model id', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('codex-responses', 'z-ai/glm-4.7-flash', 'worker')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[modelCompat] Role worker model z-ai/glm-4.7-flash rejected for codex-responses, using default gpt-5.6-terra",
      );
      log.mockRestore();
    });

    it('logs warning when codex-responses rejects an openai/gpt-5 style id', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('codex-responses', 'openai/gpt-5', 'reviewer')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[modelCompat] Role reviewer model openai/gpt-5 rejected for codex-responses, using default gpt-5.6-terra",
      );
      log.mockRestore();
    });

    it('logs warning when openrouter rejects a codex-style gpt-* slug', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('openrouter', 'gpt-5.6-terra', 'worker')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[modelCompat] Role worker model gpt-5.6-terra rejected for openrouter, using default openai/gpt-5",
      );
      log.mockRestore();
    });

    it('logs warning when openrouter rejects a codex-style gpt-5.6-sol id', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('openrouter', 'gpt-5.6-sol', 'orchestrator')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[modelCompat] Role orchestrator model gpt-5.6-sol rejected for openrouter, using default openai/gpt-5",
      );
      log.mockRestore();
    });

    it('logs warning without role when role is omitted', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('claude', 'gpt-5.5')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("model gpt-5.5 rejected for claude"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.not.stringContaining('Role'),
      );
      log.mockRestore();
    });

    it('does not log warning when model is accepted', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(mapModelForProvider('codex-responses', 'gpt-5.6-terra', 'worker')).toBe('gpt-5.6-terra');
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });
});