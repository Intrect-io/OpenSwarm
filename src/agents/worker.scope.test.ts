import { describe, expect, it } from 'vitest';
import { reconcileWorkerFiles } from './worker.js';

const scope = ['src/support/web.ts'];

describe('worker file scope', () => {
  it('admits the tests for a file the worker may already rewrite', () => {
    // A task scoped to one source file, whose completion criteria demand tests,
    // otherwise rejects the worker for writing them — and the retry writes them
    // again. A real run burned all five iterations on exactly this.
    const { outsideScope } = reconcileWorkerFiles([
      'src/support/web.ts',
      'src/support/web.test.ts',
      'src/support/web.githubRepos.test.ts',
      'src/support/web.spec.ts',
    ], scope);
    expect(outsideScope).toEqual([]);
  });

  it('does not admit a test for a different file in the same directory', () => {
    const { outsideScope } = reconcileWorkerFiles(['src/support/staticAssets.test.ts'], scope);
    expect(outsideScope).toEqual(['src/support/staticAssets.test.ts']);
  });

  it('does not admit a subdirectory ride on a dotted infix', () => {
    // `.+` in the infix would have let a crafted path escape the directory:
    // src/support/web.x/evil/deep.test.ts matched a scope of src/support/web.ts.
    const { outsideScope } = reconcileWorkerFiles([
      'src/support/web.x/evil/deep.test.ts',
      'src/support/web.helpers/inner.spec.ts',
    ], scope);
    expect(outsideScope).toEqual([
      'src/support/web.x/evil/deep.test.ts',
      'src/support/web.helpers/inner.spec.ts',
    ]);
  });

  it('does not admit a same-named test in another directory', () => {
    const { outsideScope } = reconcileWorkerFiles(['tests/web.test.ts'], scope);
    expect(outsideScope).toEqual(['tests/web.test.ts']);
  });

  it('does not admit a non-test neighbour that merely shares the base name', () => {
    const { outsideScope } = reconcileWorkerFiles([
      'src/support/web.helpers.ts',
      'src/support/webSocket.ts',
    ], scope);
    expect(outsideScope).toEqual(['src/support/web.helpers.ts', 'src/support/webSocket.ts']);
  });

  it('keeps directory scope working', () => {
    const { outsideScope } = reconcileWorkerFiles(
      ['src/coordination/store.ts', 'src/agents/worker.ts'],
      ['src/coordination'],
    );
    expect(outsideScope).toEqual(['src/agents/worker.ts']);
  });

  it('treats an empty scope as unrestricted, as before', () => {
    const { outsideScope } = reconcileWorkerFiles(['anything.ts'], []);
    expect(outsideScope).toEqual([]);
  });

  it('reports every changed file regardless of scope', () => {
    const { filesChanged } = reconcileWorkerFiles(['src/support/web.ts', 'other.ts'], scope);
    expect(filesChanged).toEqual(['src/support/web.ts', 'other.ts']);
  });
});
