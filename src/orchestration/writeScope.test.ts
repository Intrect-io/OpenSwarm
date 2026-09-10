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
