import { describe, expect, it, vi } from 'vitest';

// Only the write-boundary decision is under test here; every other context
// source is stubbed to an empty result so it cannot mask the assertion.
vi.mock('../knowledge/index.js', () => ({ analyzeIssue: vi.fn(async () => null) }));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn(async () => []) }));
vi.mock('../registry/sqliteStore.js', () => ({ getRegistryStore: vi.fn(() => null) }));
vi.mock('./siblingWork.js', () => ({ collectSiblingWork: vi.fn(async () => []) }));

import { collectWorkerContext } from './workerContext.js';

function contextWith(fileScope: string[], fileScopeSource?: string): never {
  return { task: { fileScope, fileScopeSource }, projectPath: '/tmp/does-not-exist' } as never;
}

describe('collectWorkerContext write boundary', () => {
  it('announces a declared scope, which the post-run guard also enforces', async () => {
    const wc = await collectWorkerContext(contextWith(['src/router.ts'], 'declared'), undefined);
    expect(wc?.fileScope).toEqual(['src/router.ts']);
  });

  it('stays silent about an inferred scope, which no consumer enforces', async () => {
    // pairPipeline.ts and publishOnPark.ts both pass `undefined` for an
    // inferred scope. Rendering it as "binding" would make the worker refuse
    // edits that would in fact have passed the gate.
    const wc = await collectWorkerContext(contextWith(['src/router.ts'], 'inferred'), undefined);
    expect(wc?.fileScope).toBeUndefined();
  });

  it('copies the scope rather than aliasing the task', async () => {
    const scope = ['src/router.ts'];
    const wc = await collectWorkerContext(contextWith(scope, 'declared'), undefined);
    wc?.fileScope?.push('src/injected.ts');
    expect(scope).toEqual(['src/router.ts']);
  });
});
