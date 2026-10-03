import { describe, expect, it } from 'vitest';
import { enforcedFileScope, filesOutsideWriteScope } from './writeScope.js';

describe('enforcedFileScope', () => {
  const scope = ['src/a.ts', 'src/b.ts'];

  it('binds a declared or drafted reservation', () => {
    expect(enforcedFileScope({ fileScope: scope, fileScopeSource: 'declared' })).toEqual(scope);
    expect(enforcedFileScope({ fileScope: scope, fileScopeSource: 'drafted' })).toEqual(scope);
  });

  // vela 2026-09-02: 3 of 3 scope violations were mention-scopes that were
  // simply wrong; validated-direct runs finished 1 of 43 at 15 attempts each.
  it('treats knowledge-graph mention scopes as advisory, whether raw or existence-checked', () => {
    expect(enforcedFileScope({ fileScope: scope, fileScopeSource: 'inferred' })).toBeUndefined();
    expect(enforcedFileScope({ fileScope: scope, fileScopeSource: 'validated-direct' })).toBeUndefined();
  });

  it('enforces nothing when there is no reservation', () => {
    expect(enforcedFileScope({})).toBeUndefined();
    expect(enforcedFileScope({ fileScope: [], fileScopeSource: 'declared' })).toBeUndefined();
  });

  it('returns a copy so a consumer cannot widen the task in place', () => {
    const task = { fileScope: [...scope], fileScopeSource: 'declared' as const };
    enforcedFileScope(task)!.push('src/c.ts');
    expect(task.fileScope).toEqual(scope);
  });
});

describe('filesOutsideWriteScope', () => {
  it('allows a companion test beside a scoped source file', () => {
    expect(filesOutsideWriteScope(['src/a.ts', 'src/a.test.ts', 'src/z.ts'], ['src/a.ts'])).toEqual(['src/z.ts']);
  });
});


describe('language companion tests', () => {
  it.each([
    ['pkg/module.py', 'pkg/tests/test_module.py'], ['pkg/module.py', 'pkg/tests/module_test.py'],
    ['pkg/module.py', 'pkg/test_module.py'], ['pkg/module.py', 'pkg/module_test.py'],
    ['pkg/module.go', 'pkg/module_test.go'], ['crate/src/module.rs', 'crate/tests/module.rs'],
  ])('allows %s -> %s', (scoped, candidate) => { expect(filesOutsideWriteScope([candidate], [scoped])).toEqual([]); });
  it.each([
    ['pkg/module.py', 'pkg/tests/test_other.py'], ['pkg/module.py', 'other/tests/test_module.py'],
    ['pkg/module.go', 'pkg/other_test.go'], ['crate/src/module.rs', 'other/tests/module.rs'],
    ['pkg/module.py', 'pkg/tests/nested/test_module.py'],
  ])('rejects non-companion/crafted path %s -> %s', (scoped, candidate) => { expect(filesOutsideWriteScope([candidate], [scoped])).toEqual([candidate]); });
});
