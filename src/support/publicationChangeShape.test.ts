import { describe, expect, it } from 'vitest';
import { changeShape, changeShapeSection } from './publicationChangeShape.js';

describe('changeShape (AGT-4407 / AGT-4408)', () => {
  it('counts source, tests, docs and other, and names the two shapes a reviewer must know', () => {
    expect(changeShape(['apps/x/config.py', 'docs/a.md', 'infra/nas/schedules.json'])).toMatchObject({
      source: 1, tests: 0, docs: 1, other: 1, testsNone: true, docsOnly: false,
    });
    expect(changeShape(['apps/x/config.py', 'tests/test_config.py'])).toMatchObject({ testsNone: false, docsOnly: false });
    expect(changeShape(['docs/B4-MULTI-SOURCE.md', 'docs/LEDGER.md'])).toMatchObject({ docsOnly: true, testsNone: false });
    expect(changeShape([])).toMatchObject({ docsOnly: false, testsNone: false });
  });

  it('renders the banners only when they apply', () => {
    expect(changeShapeSection([])).toBe('');
    const testsNone = changeShapeSection(['src/a.ts']);
    expect(testsNone).toContain('tests: none');
    expect(testsNone).not.toContain('docs-only');
    const docsOnly = changeShapeSection(['docs/a.md']);
    expect(docsOnly).toContain('docs-only');
    expect(docsOnly).not.toContain('tests: none');
    expect(changeShapeSection(['src/a.ts', 'src/a.test.ts'])).not.toMatch(/⚠/);
  });
});
