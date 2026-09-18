import { describe, expect, it } from 'vitest';
import { admitsConflictScope } from '../automation/runLedgerScope.js';
import { fileScopesConflict } from './conflictDetector.js';
import { conflictScopeEntriesOverlap, isDocumentationPath, normalizeConflictScope } from './conflictScope.js';

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
  ])('treats unsafe or unknown scope %j as empty; durable admission defaults to admit', (requested) => {
    expect(normalizeConflictScope(requested)).toEqual(new Set());
    expect(fileScopesConflict(requested, ['src/safe.ts'])).toBe(true);
    expect(admitsConflictScope(requested, [{ fileScope: ['src/safe.ts'] }])).toBe(true);
    expect(admitsConflictScope(requested, [{ fileScope: ['src/safe.ts'] }], 'serialize')).toBe(false);
  });
});

// AGT-4422: the requirements ledger every cgf-portal PR updates made one open
// hand PR supersede every task in the repository.
describe('documentation paths are never ownership (AGT-4422)', () => {
  it.each([
    'docs/REQUIREMENTS-LEDGER.md',
    'docs/material-inventory.json',
    'apps/portal/doc/api.html',
    'README.md',
    'CHANGELOG',
    'LICENSE.txt',
    'apps/pipelines/NOTICE',
    'guide.mdx',
    'spec.rst',
  ])('%s is documentation', (entry) => {
    expect(isDocumentationPath(entry)).toBe(true);
  });

  it.each([
    'apps/pipelines/src/cgf_pipelines/jobs/c_workstreams.py',
    'apps/portal/src/api/c3.js',
    'requirements.txt',
    'infra/nas/schedules.json',
    'src/documents/index.ts',
    'docstring_tools.py',
  ])('%s is implementation', (entry) => {
    expect(isDocumentationPath(entry)).toBe(false);
  });

  it('a documentation entry overlaps nothing, not even itself', () => {
    expect(conflictScopeEntriesOverlap('docs/requirements-ledger.md', 'docs/requirements-ledger.md')).toBe(false);
    expect(conflictScopeEntriesOverlap('docs', 'docs/requirements-ledger.md')).toBe(false);
    expect(conflictScopeEntriesOverlap('apps/pipelines', 'apps/pipelines/src/x.py')).toBe(true);
  });
});
