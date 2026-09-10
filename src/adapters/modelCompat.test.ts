import { afterEach, describe, it, expect, vi } from 'vitest';
import { readCachedCatalog } from './modelCatalog.js';

vi.mock('./modelCatalog.js', () => ({ readCachedCatalog: vi.fn(() => null) }));

const { mapModelForProvider, resetCursorRouteNoticesForTests } = await import('./modelCompat.js');

// Regression for INT-2510: decomposition.plannerModel 'gpt-5.5' leaked into
// `claude -p --model gpt-5.5` after a provider switch → API 404 on every
// decomposition attempt.
describe('mapModelForProvider', () => {
  afterEach(() => {
    vi.mocked(readCachedCatalog).mockReset().mockReturnValue(null);
  });

  // The catalog branch shipped reading `models` as `{ id }` objects when it is
  // a string[], so every lookup missed — and no test caught it, because
  // `readCachedCatalog` is mocked to null everywhere else in this file, which
  // left the branch unexecuted by the whole suite.
  //
  // `moonshotai/Kimi-K2` is deliberate: it is absent from
  // ATLASCLOUD_CURATED_MODELS and carries no `atlascloud/` prefix, so it can
  // only be accepted by the catalog lookup. An id like `zai-org/GLM-4.6` is
  // already curated and passes two checks earlier, proving nothing here.
  it('accepts an atlascloud id only the live catalog knows', () => {
    vi.mocked(readCachedCatalog).mockReturnValue({
      models: ['deepseek-ai/DeepSeek-V3', 'moonshotai/Kimi-K2'],
      fetchedAt: '2026-09-10T00:00:00Z',
    });

    expect(mapModelForProvider('atlascloud', 'moonshotai/Kimi-K2')).toBe('moonshotai/Kimi-K2');
  });

  it('still drops an id the catalog does not list', () => {
    vi.mocked(readCachedCatalog).mockReturnValue({
      models: ['deepseek-ai/DeepSeek-V3'],
      fetchedAt: '2026-09-10T00:00:00Z',
    });

    expect(mapModelForProvider('atlascloud', 'moonshotai/Kimi-K2')).toBeUndefined();
  });

  // Measured on vela 2026-09-10 against cursor-agent 2026.09.08: cursor-agent
  // aborts on `deepseek/deepseek-v4-flash` and on `gpt-5-codex`, and silently
  // resolves `sonnet` to Claude Sonnet 4. The old branch returned every one of
  // them unchanged, so nothing warned and the adapter rewrote them all to
  // `auto` — one model for worker and reviewer alike.
  describe('cursor routes by role, because no id carries over', () => {
    it('says on the log that it re-routed, naming the role and both models', () => {
      // Neither layer could otherwise speak: this returns a value, so the
      // rejection warning cannot fire, and CursorCliAdapter then receives an id
      // it recognises, so its substitution notice cannot fire either. An
      // operator who pinned a bare id cursor-agent accepts would watch it become
      // something else in total silence — the complaint this change answers,
      // recreated by the change.
      resetCursorRouteNoticesForTests();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      mapModelForProvider('cursor', 'gpt-5.3-codex', 'reviewer');

      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain('reviewer');
      expect(line).toContain('gpt-5.3-codex');
      expect(line).toContain('cursor-grok-4.6-high');
      // This file's afterEach restores only the catalog mock, so a console spy
      // left installed accumulates into every later test's expectations.
      log.mockRestore();
    });

    it('says it once per role and id, not once per stage run', () => {
      resetCursorRouteNoticesForTests();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      mapModelForProvider('cursor', 'gpt-5.3-codex', 'reviewer');
      mapModelForProvider('cursor', 'gpt-5.3-codex', 'reviewer');
      // A different role over the same id is a different fact, and is said.
      mapModelForProvider('cursor', 'gpt-5.3-codex', 'worker');

      expect(log).toHaveBeenCalledTimes(2);
      log.mockRestore();
    });

    it('sends bulk implementation to auto', () => {
      expect(mapModelForProvider('cursor', 'deepseek/deepseek-v4-flash', 'worker')).toBe('auto');
      expect(mapModelForProvider('cursor', 'gpt-5-codex', 'tester')).toBe('auto');
      expect(mapModelForProvider('cursor', 'sonnet', 'documenter')).toBe('auto');
    });

    it('gives every judging role a named model, so the corrector is not the worker', () => {
      const worker = mapModelForProvider('cursor', 'deepseek/deepseek-v4-flash', 'worker');
      for (const role of ['reviewer', 'auditor', 'planner', 'orchestrator'] as const) {
        const judge = mapModelForProvider('cursor', 'deepseek/deepseek-v4-flash', role);
        expect(judge).toBe('cursor-grok-4.6-high');
        expect(judge).not.toBe(worker);
      }
    });

    it('escalates the reviewer to a model above the reviewer, not onto it', () => {
      // A tier that resolves to the model it escalates FROM is a log line about
      // work that did not happen. pairPipeline announces the spot check before
      // the stage runs, so this silently made that announcement false.
      const reviewer = mapModelForProvider('cursor', 'deepseek/deepseek-v4-flash', 'reviewer');
      const escalated = mapModelForProvider('cursor', 'gpt-5.6-terra-max', 'escalate');

      expect(escalated).toBe('cursor-grok-4.6-xhigh');
      expect(escalated).not.toBe(reviewer);
    });

    it('keeps an id the operator pinned for cursor', () => {
      expect(mapModelForProvider('cursor', 'cursor-grok-4.6-xhigh', 'reviewer')).toBe('cursor-grok-4.6-xhigh');
      expect(mapModelForProvider('cursor', 'composer-2.5', 'worker')).toBe('composer-2.5');
      expect(mapModelForProvider('cursor', 'auto', 'reviewer')).toBe('auto');
    });

    it('ignores the persisted cursor catalogue entirely, so routing is the same everywhere', () => {
      // An earlier version consulted it, which re-admitted whatever the file
      // happened to list — `gpt-5.3-codex` IS a cursor id, so one config value
      // would have been kept for worker and reviewer alike and collapsed them
      // again, with the verdict decided by a file outside the repository.
      vi.mocked(readCachedCatalog).mockImplementation((provider: string) =>
        provider === 'cursor'
          ? { models: ['gpt-5.3-codex', 'glm-5.2-high'], fetchedAt: '2026-09-10T00:00:00Z' }
          : null);

      expect(mapModelForProvider('cursor', 'gpt-5.3-codex', 'worker')).toBe('auto');
      expect(mapModelForProvider('cursor', 'gpt-5.3-codex', 'reviewer')).toBe('cursor-grok-4.6-high');
      expect(mapModelForProvider('cursor', 'glm-5.2-high', 'reviewer')).toBe('cursor-grok-4.6-high');
    });

    it('gives an unrecognised role the bulk model rather than the judge model', () => {
      // The table is an allow-list: a role nobody argued for does not get the
      // expensive model by accident.
      expect(mapModelForProvider('cursor', 'gpt-5-codex', undefined)).toBe('auto');
      expect(mapModelForProvider('cursor', 'gpt-5-codex')).toBe('auto');
    });

    it('never returns undefined, because cursor has no getDefaultModel worth falling back to', () => {
      // `getDefaultModel()` returns the first line of `--list-models`, which is
      // `auto` — so falling through to it would undo the role split again.
      expect(mapModelForProvider('cursor', 'gpt-5-codex', 'reviewer')).toBeDefined();
    });
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

  // Was 'cursor adapter passes everything through', asserting these three ids
  // came back unchanged. The property worth keeping is the one below — cursor
  // never drops a model, because it has no useful default to drop to. Echoing
  // the id back was the defect, not the property: none of these three is a
  // cursor id. `claude-sonnet-5` is not in cursor-agent's catalogue (it lists
  // `claude-sonnet-5-high`, `-medium`, `-thinking-*`) and `openai/gpt-5` is
  // namespaced, which cursor-agent rejects outright.
  it('cursor adapter always yields a usable model, never undefined', () => {
    for (const id of ['gpt-5.5', 'openai/gpt-5', 'claude-sonnet-5']) {
      expect(mapModelForProvider('cursor', id, 'worker')).toBeDefined();
      expect(mapModelForProvider('cursor', id, 'reviewer')).toBeDefined();
    }
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