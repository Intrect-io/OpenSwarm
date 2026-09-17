import { describe, expect, it } from 'vitest';
import { figuresChangedInPlace, uncitedApprovalClaims, unsourcedFigures } from './claimEvidenceGuard.js';

describe('claim evidence guard (AGT-4408)', () => {
  it('pairs a removed and an added doc line by skeleton and reports the figures that changed', () => {
    const removed = ['| 안심뉴타운 | 27행 | 20,706,700 |', '| run | 13570 |', '- unrelated removed'];
    const added = ['| 안심뉴타운 | 27행 | 13,955,000 |', '| run | 132 |', '- brand new line 42'];
    const changes = figuresChangedInPlace(removed, added);
    expect(changes.map((c) => [c.before, c.after])).toEqual([
      [['27', '20706700'], ['27', '13955000']],
      [['13570'], ['132']],
    ]);
  });

  it('ignores dates, single digits and lines whose figures did not change', () => {
    const removed = ['Decided on 2026-09-14 in meeting 3', '| total | 5,000 |'];
    const added = ['Decided on 2026-09-15 in meeting 4', '| total | 5,000 |'];
    expect(figuresChangedInPlace(removed, added)).toEqual([]);
  });

  it('accepts a new figure the run itself printed and rejects one it never did', () => {
    const changes = figuresChangedInPlace(['| A | 20,706,700 |', '| B | 100 |'], ['| A | 13,955,000 |', '| B | 250 |']);
    const report = 'Ran: uv run b4 --site A\n... total=13955000 rows=27\n';
    const unsourced = unsourcedFigures(changes, report);
    expect(unsourced.map((c) => c.missing)).toEqual([['250']]);
  });

  it('flags an approval claim without link or date, not one that cites or one that says pending', () => {
    const lines = [
      '# approved by CGF on 2026-09-16 (https://linear.app/x/comment/1)',
      '## 승인 대기 항목',
      '# 승인됨 — 근거: https://example/thread',
      'approval_pending = True',
    ];
    const flagged = uncitedApprovalClaims(lines);
    expect(flagged).toEqual([]);
    // #508's line: the only "date" is part of a file name, and the file says pending.
    expect(uncitedApprovalClaims([
      '# CGF approval reference: docs/CGF-A3-META-FORM-INVENTORY-2026-09-15.md',
      'status = "승인 완료"',
    ])).toEqual([
      '# CGF approval reference: docs/CGF-A3-META-FORM-INVENTORY-2026-09-15.md',
      'status = "승인 완료"',
    ]);
  });
});
