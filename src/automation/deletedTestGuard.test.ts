// ============================================
// OpenSwarm — deleting a passing test must not be free (AGT-4277)
// ============================================
//
// PR #580 removed four tests from planCommand.test.ts and passed 8/8 CI. The
// originals pass unmodified against that PR's own production code, so they were
// not deleted because they broke — and three mutations of planCommand.ts that
// main's suite kills survive without them.

import { describe, expect, it } from 'vitest';
import { collectTestCaseDeltas, countTestCases, deletedTestNotice, findDeletedTests } from './deletedTestGuard.js';

const FOUR_CASES = `
describe('planCommand', () => {
  it('does not dispatch on no', () => {});
  it('drops a sub-task on edit, then dispatches the remainder', () => {});
  test('uses the single-task path when no decomposition is needed', () => {});
  it.each([1, 2])('dispatches the approved sub-tasks on yes %i', () => {});
});
`;
const ONE_CASE = `
describe('planCommand', () => {
  it('dispatches the approved sub-tasks on yes', () => {});
});
`;

describe('deleted test guard (AGT-4277)', () => {
  it('counts declarations, including it.each and test', () => {
    expect(countTestCases(FOUR_CASES)).toBe(4);
    expect(countTestCases(ONE_CASE)).toBe(1);
  });

  it('does not count a word that merely ends in "it"', () => {
    // `submit(`, `edit(`, `await it` — a naive /it\(/ would flag all three.
    expect(countTestCases('submit(x); audit(y); const edit = () => {};')).toBe(0);
  });

  it('reports the loss PR #580 made, with the file and the counts', () => {
    const finding = findDeletedTests([
      { file: 'src/support/planCommand.test.ts', before: FOUR_CASES, after: ONE_CASE },
    ]);

    expect(finding.removed).toBe(3);
    expect(finding.files).toEqual([
      { file: 'src/support/planCommand.test.ts', before: 4, after: 1 },
    ]);
  });

  it('counts a deleted test file as losing every case it held', () => {
    const finding = findDeletedTests([
      { file: 'src/support/planCommand.test.ts', before: FOUR_CASES, after: null },
    ]);

    expect(finding.removed).toBe(4);
  });

  it('says nothing about a change that only adds tests', () => {
    const finding = findDeletedTests([
      { file: 'src/support/planCommand.test.ts', before: ONE_CASE, after: FOUR_CASES },
      { file: 'src/support/planCommand.ts', before: 'it(', after: '' },
    ]);

    expect(finding.removed).toBe(0);
    expect(finding.files).toEqual([]);
  });

  it('ignores production files, whose "it(" is not a test', () => {
    // planCommand.ts itself contains `submit(`; a guard that read production
    // files would fire on every refactor and be turned off within a day.
    const finding = findDeletedTests([
      { file: 'src/support/planCommand.ts', before: 'it("x", () => {}); it("y", () => {});', after: '' },
    ]);

    expect(finding.removed).toBe(0);
  });

  it('puts the worst file first, so a long list still leads with the point', () => {
    const finding = findDeletedTests([
      { file: 'a.test.ts', before: ONE_CASE, after: '' },
      { file: 'b.test.ts', before: FOUR_CASES, after: '' },
    ]);

    expect(finding.files.map(f => f.file)).toEqual(['b.test.ts', 'a.test.ts']);
  });

  it('writes a notice that names the count, the file, and what to do', () => {
    const notice = deletedTestNotice(findDeletedTests([
      { file: 'src/support/planCommand.test.ts', before: FOUR_CASES, after: ONE_CASE },
    ]));

    expect(notice).toContain('removes 3 test case(s)');
    expect(notice).toContain('src/support/planCommand.test.ts');
    expect(notice).toContain('| 4 | 1 | −3 |');
    // Not a block — a gate that refused legitimate deletions would be routed
    // around. It asks the change to say why.
    expect(notice).toContain('restore them');
    expect(notice).toContain('say so in the description');
  });

  it('reads the delta out of git, treating an absent side as zero', async () => {
    const run = async (args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha\n';
      if (args[0] === 'diff') return 'src/a.test.ts\nsrc/prod.ts\nsrc/gone.test.ts\n';
      const ref = args[1];
      if (ref === 'base-sha:src/a.test.ts') return FOUR_CASES;
      if (ref === 'HEAD:src/a.test.ts') return ONE_CASE;
      if (ref === 'base-sha:src/gone.test.ts') return ONE_CASE;
      throw new Error(`fatal: path does not exist in ${ref}`);
    };

    const finding = await collectTestCaseDeltas('origin/HEAD', run);

    // 3 from the rewritten file, 1 from the deleted one. prod.ts never read.
    expect(finding.removed).toBe(4);
    expect(finding.files.map(f => f.file)).toEqual(['src/a.test.ts', 'src/gone.test.ts']);
  });

  it('says nothing when the branch shares no history to compare against', async () => {
    const run = async () => { throw new Error('fatal: no merge base'); };

    await expect(collectTestCaseDeltas('origin/HEAD', run)).resolves.toEqual({ files: [], removed: 0 });
  });
});
