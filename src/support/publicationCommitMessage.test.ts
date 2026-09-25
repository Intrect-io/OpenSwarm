import { describe, expect, it } from 'vitest';
import { inferCommitType, publicationCommitSubject } from './publicationCommitMessage.js';
import { runConventionalCommitGuard } from '../agents/pipelineGuards.js';

describe('publicationCommitSubject (AGT-4410)', () => {
  it('keeps the type a typed title already carries instead of prefixing feat again (#488)', () => {
    const subject = publicationCommitSubject(
      'AX-1420', 'fix(integrations): make external writes idempotent and bounded', ['apps/x.py'],
    );
    expect(subject).toBe('fix(AX-1420): integrations: make external writes idempotent and bounded');
    expect(subject).not.toMatch(/feat\(/);
  });

  it('preserves a breaking-change marker and normalises the type\'s case', () => {
    expect(publicationCommitSubject('AX-1', 'Feat!: drop v1 endpoints', ['src/a.ts']))
      .toBe('feat(AX-1)!: drop v1 endpoints');
  });

  it('does not repeat the issue when the title already scopes to it', () => {
    expect(publicationCommitSubject('AX-7', 'fix(AX-7): stop the double prefix', ['src/a.ts']))
      .toBe('fix(AX-7): stop the double prefix');
  });

  it('types a docs-only change docs, not feat (#503)', () => {
    expect(publicationCommitSubject('AX-1439', 'B4 대천·종로 41건 승인 기준 재처리·회귀 검증', ['docs/B4-MULTI-SOURCE.md', 'docs/ledger.md']))
      .toBe('docs(AX-1439): B4 대천·종로 41건 승인 기준 재처리·회귀 검증');
  });

  it('types a tests-only change test, and anything mixed feat', () => {
    expect(inferCommitType(['tests/test_intake.py', 'src/a.test.ts', 'spec/b.spec.tsx'])).toBe('test');
    expect(inferCommitType(['tests/test_intake.py', 'src/intake.py'])).toBe('feat');
    expect(inferCommitType(['docs/a.md', 'src/intake.py'])).toBe('feat');
    expect(inferCommitType([])).toBe('feat');
  });

  it('still bounds the description at 72 characters', () => {
    const long = 'x'.repeat(100);
    expect(publicationCommitSubject('AX-2', long, ['src/a.ts'])).toBe(`feat(AX-2): ${'x'.repeat(72)}`);
    expect(publicationCommitSubject('AX-2', `fix: ${long}`, ['src/a.ts'])).toBe(`fix(AX-2): ${'x'.repeat(72)}`);
  });

  it('always satisfies the conventional-commit guard the publication runs next', () => {
    for (const [title, files] of [
      ['fix(integrations): make it so', ['a.py']],
      ['Plain title', ['docs/a.md']],
      ['refactor!: rename', ['src/a.ts']],
      ['chore(deps): bump', ['package.json']],
    ] as const) {
      expect(runConventionalCommitGuard(publicationCommitSubject('AX-9', title, [...files])).passed, title).toBe(true);
    }
  });
});
