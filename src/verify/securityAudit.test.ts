import { describe, expect, it } from 'vitest';
import { detectCodeqlLanguages, newSecurityFindings, securityFindingFingerprint, selectSecuritySourceFiles } from './securityAudit.js';

describe('security audit primitives', () => {
  it('maps only supported tracked source languages', () => {
    expect(detectCodeqlLanguages(['src/a.ts', 'lib/b.py', 'tool/c.rs', 'README.md'])).toEqual([
      'javascript', 'python', 'rust',
    ]);
  });

  it('includes nonignored new source files and deduplicates Git path entries', () => {
    expect(selectSecuritySourceFiles([
      'src/existing.ts',
      'src/newly-created.ts',
      'src/existing.ts',
      'README.md',
      '',
    ])).toEqual(['src/existing.ts', 'src/newly-created.ts']);
  });

  it('treats shifted existing findings as a baseline match', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const current = [{ ...baseline[0], line: 20 }, { ruleId: 'codeql/js/y', level: 'error' as const, message: 'new', filePath: 'src/b.ts' }];
    expect(securityFindingFingerprint(baseline[0]!)).not.toContain(':2');
    expect(newSecurityFindings(baseline, current)).toEqual([current[1]]);
  });

  it('keeps an additional result with the same stable fingerprint as new', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const existingMoved = { ...baseline[0], line: 20 };
    const newlyIntroducedDuplicate = { ...baseline[0], line: 40 };

    expect(newSecurityFindings(baseline, [existingMoved, newlyIntroducedDuplicate]))
      .toEqual([newlyIntroducedDuplicate]);
  });
});
