import { describe, expect, it } from 'vitest';
import { admitsConflictScope } from '../automation/runLedgerScope.js';
import { fileScopesConflict } from './conflictDetector.js';
import { normalizeConflictScope } from './conflictScope.js';

describe('canonical conflict scope policy', () => {
  const cases: Array<{
    name: string;
    left: string[];
    right: string[];
    conflict: boolean;
  }> = [
    { name: 'equal file', left: ['src/a.ts'], right: ['src/a.ts'], conflict: true },
    {
      name: 'directory owns child file',
      left: ['src/coordination'], right: ['src/coordination/store.ts'], conflict: true,
    },
    {
      name: 'dot segment alias',
      left: ['src/a.ts'], right: ['src/../src/a.ts'], conflict: true,
    },
    {
      name: 'separator and case alias',
      left: ['SRC\\Coordination'], right: ['./src/coordination/store.ts'], conflict: true,
    },
    {
      name: 'sibling prefix is not an ancestor',
      left: ['src/a'], right: ['src/ab/file.ts'], conflict: false,
    },
    { name: 'disjoint files', left: ['src/a.ts'], right: ['src/b.ts'], conflict: false },
  ];

  it.each(cases)('$name is identical in scheduler and durable admission', ({ left, right, conflict }) => {
    expect(fileScopesConflict(left, right)).toBe(conflict);
    expect(admitsConflictScope(left, [{ fileScope: right }])).toBe(!conflict);
  });

  it.each([
    ['/absolute/path.ts'],
    ['C:\\repo\\file.ts'],
    ['../outside.ts'],
    ['unknown-file-scope'],
  ])('fails closed for unsafe or unknown scope %j', (requested) => {
    expect(normalizeConflictScope(requested)).toEqual(new Set());
    expect(fileScopesConflict(requested, ['src/safe.ts'])).toBe(true);
    expect(admitsConflictScope(requested, [{ fileScope: ['src/safe.ts'] }])).toBe(false);
  });
});
