import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgenticLoopOptions } from './agenticLoop.js';
import { CodexResponsesAdapter } from './codexResponses.js';

// The loop sizes compaction from `contextWindowTokens`; the adapter is the only
// place that can supply it for this provider. Without it every worker compacts
// at the fixed 60k fallback no matter how large the model's window is (AGT-4660).
const captured = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock('./agenticLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agenticLoop.js')>();
  return {
    ...actual,
    runAgenticLoop: vi.fn(async (options: unknown) => {
      captured.options = options;
      return {
        text: 'ok', toolCallCount: 0, apiCallCount: 1, totalTokens: 0, inputTokens: 0,
        outputTokens: 0, cachedTokens: 0, costUsd: 0, meteredCalls: 0,
      };
    }),
  };
});

class ProbeAdapter extends CodexResponsesAdapter {
  protected override async credentials(): Promise<{ accessToken: string; accountId: string }> {
    return { accessToken: 'token', accountId: 'account' };
  }
}

describe('codex-responses adapter passes the model context window to the loop (AGT-4660)', () => {
  let home: string;
  let catalogDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-window-adapter-home-'));
    catalogDir = mkdtempSync(join(tmpdir(), 'codex-window-adapter-catalog-'));
    vi.stubEnv('CODEX_HOME', home);
    vi.stubEnv('OPENSWARM_MODEL_CATALOG_DIR', catalogDir);
    captured.options = undefined;
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.6-terra', context_window: 272000, effective_context_window_percent: 95 }],
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(catalogDir, { recursive: true, force: true });
  });

  const runWith = async (model: string): Promise<AgenticLoopOptions> => {
    await new ProbeAdapter().run({ prompt: 'x', cwd: tmpdir(), model });
    return captured.options as AgenticLoopOptions;
  };

  it('hands the loop the window the Codex backend reports for the model', async () => {
    expect((await runWith('gpt-5.6-terra')).contextWindowTokens).toBe(258400);
  });

  it('leaves the window unset for a model nobody reports one for, so the fixed fallback still applies', async () => {
    expect((await runWith('gpt-unknown')).contextWindowTokens).toBeUndefined();
  });
});
