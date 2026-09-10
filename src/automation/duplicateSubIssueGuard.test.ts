import { describe, it, expect } from 'vitest';
import { findDuplicateSibling, titleSimilarity, fileScopeOverlap, type ExistingSibling } from './duplicateSubIssueGuard.js';

const sibling = (over: Partial<ExistingSibling>): ExistingSibling => ({
  id: 'sib-id',
  identifier: 'AGT-1',
  title: 'sibling title',
  fileScope: [],
  ...over,
});

// Real AGT-2908 evidence: five sub-issues, all scoped to the same 4 files, with
// titles that differ only in a bracketed prefix.
const AGT_2908_FILE_SCOPE = [
  'api/models/db.py',
  'api/models/schemas.py',
  'api/routes/analyze.py',
  'tests/test_analyze_history.py',
];

describe('findDuplicateSibling', () => {
  it('flags the AGT-2908 shape: identical multi-file scope, differently prefixed titles', () => {
    const candidate = { title: '[API Schema] Define the Detect analysis history response contract', fileScope: AGT_2908_FILE_SCOPE };
    const existing = [
      sibling({ identifier: 'AGT-2735', title: '[Backend] Add the durable single-analysis model and response schemas', fileScope: AGT_2908_FILE_SCOPE }),
    ];
    const match = findDuplicateSibling(candidate, existing);
    expect(match?.sibling.identifier).toBe('AGT-2735');
    expect(match?.fileScopeScore).toBe(1);
  });

  it('does not flag a candidate with no file scope, even with an identical title', () => {
    const candidate = { title: 'Add durable single-analysis model and response schemas', fileScope: [] };
    const existing = [sibling({ title: 'Add durable single-analysis model and response schemas', fileScope: AGT_2908_FILE_SCOPE })];
    expect(findDuplicateSibling(candidate, existing)).toBeNull();
  });

  it('does not flag two unrelated single-file tasks sharing one trivial file', () => {
    const candidate = { title: 'Bump the eslint dependency version', fileScope: ['package.json'] };
    const existing = [sibling({ title: 'Rotate the deploy signing key', fileScope: ['package.json'] })];
    expect(findDuplicateSibling(candidate, existing)).toBeNull();
  });

  it('flags two single-file tasks about the same file with overlapping intent', () => {
    const candidate = { title: 'fix(envFile): warn on a divergent ambient value', fileScope: ['src/core/envFile.ts'] };
    const existing = [sibling({ identifier: 'AGT-4154', title: 'fix(envFile): shell export silently shadows a divergent .env value', fileScope: ['src/core/envFile.ts'] })];
    expect(findDuplicateSibling(candidate, existing)?.sibling.identifier).toBe('AGT-4154');
  });

  it('does not flag two files in scope that share nothing else', () => {
    const candidate = { title: 'Add a new CLI flag', fileScope: ['src/cli.ts', 'src/cli.test.ts'] };
    const existing = [sibling({ title: 'Fix a race in the daemon scheduler', fileScope: ['src/automation/scheduler.ts', 'src/automation/scheduler.test.ts'] })];
    expect(findDuplicateSibling(candidate, existing)).toBeNull();
  });

  it('prefers the strongest match when several siblings share file scope', () => {
    const candidate = { title: 'Persist completed analyses and expose isolated history APIs', fileScope: AGT_2908_FILE_SCOPE };
    const existing = [
      sibling({ identifier: 'AGT-2735', title: 'Add the durable single-analysis model and response schemas', fileScope: AGT_2908_FILE_SCOPE }),
      sibling({ identifier: 'AGT-2742', title: 'Persist completed analyses and expose isolated history APIs', fileScope: AGT_2908_FILE_SCOPE }),
    ];
    expect(findDuplicateSibling(candidate, existing)?.sibling.identifier).toBe('AGT-2742');
  });
});

describe('titleSimilarity', () => {
  it('ignores bracket and conventional-commit prefixes', () => {
    expect(titleSimilarity('[Backend] Add durable history', 'feat(backend): add durable history')).toBeGreaterThan(0.5);
  });

  it('returns 0 for titles with nothing in common', () => {
    expect(titleSimilarity('Rotate the deploy signing key', 'Bump the eslint dependency version')).toBe(0);
  });
});

describe('fileScopeOverlap', () => {
  it('is 1 for identical scopes regardless of order', () => {
    expect(fileScopeOverlap(['a.ts', 'b.ts'], ['b.ts', 'a.ts'])).toBe(1);
  });

  it('is 0 for disjoint scopes', () => {
    expect(fileScopeOverlap(['a.ts'], ['b.ts'])).toBe(0);
  });
});
