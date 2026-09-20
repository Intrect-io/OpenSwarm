// AGT-3490 — entityWarnings needs a request-wide result budget, not per-page caps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let warned: Array<{ offset: number; limit: number }> = [];

vi.mock('./sqliteStore.js', () => ({
  getRegistryStore: () => ({
    getUnresolvedWarnings: (_severity: unknown, _projectId: unknown, limit: number, offset: number) => {
      warned.push({ limit, offset });
      return [];
    },
  }),
}));

let registryResolvers: (typeof import('./graphql/resolvers.js'))['registryResolvers'];

beforeEach(async () => {
  warned = [];
  ({ registryResolvers } = await import('./graphql/resolvers.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('entityWarnings request budget', () => {
  it('accepts a page that fits within the request-wide budget', async () => {
    await registryResolvers.Query.entityWarnings(undefined, { limit: 50, offset: 100 });
    expect(warned).toEqual([{ limit: 50, offset: 100 }]);
  });

  it('rejects an offset+limit window beyond the request-wide budget', async () => {
    try {
      await registryResolvers.Query.entityWarnings(undefined, { limit: 200, offset: 150 });
      expect.unreachable('the window should have been rejected');
    } catch (err) {
      expect((err as Error).message).toContain('exceeds the request budget of 200');
    }
    expect(warned).toEqual([]);
  });
});
