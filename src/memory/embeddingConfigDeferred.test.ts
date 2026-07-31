// Isolated in its own file: it re-imports memoryCore with a mutated environment, and
// that module holds pipeline/table singletons that must not leak into other suites.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('malformed embedding configuration', () => {
  it('does not throw at import time', async () => {
    // A typo in an env var must not take down every command that merely imports the
    // memory module — memory is a small corner of the CLI.
    vi.stubEnv('OPENSWARM_EMBEDDING_MODEL', 'some-org/mystery-embedder');
    vi.resetModules();

    const mod = await import('./memoryCore.js');
    expect(mod.EMBEDDING_DIM).toBe(768); // falls back to the default spec
  });

  it('throws with the original message on the first embedding call', async () => {
    vi.stubEnv('OPENSWARM_EMBEDDING_MODEL', 'some-org/mystery-embedder');
    vi.resetModules();

    const mod = await import('./memoryCore.js');
    await expect(mod.embedPassage('anything')).rejects.toThrow(/OPENSWARM_EMBEDDING_DIM/);
    await expect(mod.embedQuery('anything')).rejects.toThrow(/OPENSWARM_EMBEDDING_DIM/);
  });

  it('stays silent when the configuration is valid', async () => {
    vi.stubEnv('OPENSWARM_EMBEDDING_MODEL', 'Xenova/multilingual-e5-small');
    vi.resetModules();

    const mod = await import('./memoryCore.js');
    expect(mod.EMBEDDING_DIM).toBe(384);
  });
});
