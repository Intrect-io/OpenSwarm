import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGuards } from './pipelineGuards.js';
import type { WorkerResult } from './agentPair.js';

function mockWorker(filesChanged: string[] = []): WorkerResult {
  return { success: true, summary: '', filesChanged, commands: [], output: '' };
}

function guardIssues(results: Awaited<ReturnType<typeof runGuards>>, guard: string): string[] {
  return results.results.find(r => r.guard === guard)?.issues ?? [];
}

describe('pipelineGuards — INT-2388 deterministic guards', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-guards-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it('warns that the legacy quality gate is deprecated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runGuards(mockWorker(), repo, { qualityGate: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('autonomous.verify'));
    warn.mockRestore();
  });

  describe('dependencyAntiPatternCheck', () => {
    it('blocks __version__ spoofing after an import failure', async () => {
      writeFileSync(join(repo, 'thirdpartyshim.py'), '__version__ = "9.6.0"\n');
      const res = await runGuards(
        { ...mockWorker(['thirdpartyshim.py']), output: 'ModuleNotFoundError: No module named stonks' },
        repo,
        { dependencyAntiPatternCheck: true },
      );
      const issues = guardIssues(res, 'dependencyAntiPattern');
      expect(issues.some(i => i.includes('thirdpartyshim.py') && i.includes('__version__'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('blocks new package scaffold after a module-not-found failure', async () => {
      mkdirSync(join(repo, 'packages', 'missing-sdk'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'missing-sdk', 'package.json'), '{"name":"missing-sdk","version":"1.0.0"}\n');
      const res = await runGuards(
        { ...mockWorker(['packages/missing-sdk/package.json']), output: 'Cannot find module missing-sdk' },
        repo,
        { dependencyAntiPatternCheck: true },
      );
      const issues = guardIssues(res, 'dependencyAntiPattern');
      expect(issues.some(i => i.includes('packages/missing-sdk/package.json'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not flag __version__ without a dependency failure signal', async () => {
      writeFileSync(join(repo, 'ownedpkg.py'), '__version__ = "1.0.0"\n');
      const res = await runGuards(
        { ...mockWorker(['ownedpkg.py']), output: 'normal feature work' },
        repo,
        { dependencyAntiPatternCheck: true },
      );
      const issues = guardIssues(res, 'dependencyAntiPattern');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('does not flag an existing __version__ when the diff only changes another line', async () => {
      writeFileSync(join(repo, 'ownedpkg.py'), '__version__ = "1.0.0"\nexport const value = 1\n');
      execFileSync('git', ['add', 'ownedpkg.py'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add owned package'], { cwd: repo });

      writeFileSync(join(repo, 'ownedpkg.py'), '__version__ = "1.0.0"\nexport const value = 2\n');
      const res = await runGuards(
        { ...mockWorker(['ownedpkg.py']), output: 'ModuleNotFoundError: No module named stonks' },
        repo,
        { dependencyAntiPatternCheck: true },
      );
      const issues = guardIssues(res, 'dependencyAntiPattern');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });
  });

  describe('contractEvidenceCheck', () => {
    it('blocks a self-referential contract literal introduced only in a test', async () => {
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('foreign_summary:').toBe('foreign_summary:'));\n",
      );
      const res = await runGuards(
        mockWorker(['contract.test.ts']),
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('foreign_summary:'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('allows a contract literal that already exists in HEAD producer code', async () => {
      writeFileSync(join(repo, 'publisher.ts'), "export const KEY_PREFIX = 'stockapi:foreign_summary:';\n");
      execFileSync('git', ['add', 'publisher.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add publisher contract'], { cwd: repo });

      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses real key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      const res = await runGuards(
        mockWorker(['contract.test.ts']),
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('allows contract evidence from HEAD JSON schema files', async () => {
      writeFileSync(join(repo, 'schema.json'), '{"required":["foreign_net_buy"]}\n');
      execFileSync('git', ['add', 'schema.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add wire schema'], { cwd: repo });

      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses schema field', () => expect('foreign_net_buy').toBeTruthy());\n",
      );
      const res = await runGuards(
        mockWorker(['contract.test.ts']),
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('allows a new contract literal when worker evidence cites a measured command sample', async () => {
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses measured key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['contract.test.ts']),
          output: 'redis-cli measured output sample: stockapi:foreign_summary:005930 -> {"ok":true}',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('does not accept producer code added in the same diff as independent evidence', async () => {
      mkdirSync(join(repo, 'src', 'cache'), { recursive: true });
      writeFileSync(join(repo, 'src', 'cache', 'foreign.py'), "KEY_PREFIX = 'stockapi:foreign_summary:'\n");
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses same-diff key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['src/cache/foreign.py', 'contract.test.ts']),
          output: 'Evidence: src/cache/foreign.py:1 contains stockapi:foreign_summary:',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not accept same-diff producer evidence with dot-relative or absolute paths', async () => {
      mkdirSync(join(repo, 'src', 'cache'), { recursive: true });
      writeFileSync(join(repo, 'src', 'cache', 'foreign.py'), "KEY_PREFIX = 'stockapi:foreign_summary:'\n");
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses same-diff key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );

      for (const citedPath of ['./src/cache/foreign.py', join(repo, 'src', 'cache', 'foreign.py')]) {
        const res = await runGuards(
          {
            ...mockWorker(['src/cache/foreign.py', 'contract.test.ts']),
            output: `Evidence: ${citedPath}:1 contains stockapi:foreign_summary:`,
          },
          repo,
          { contractEvidenceCheck: true },
        );
        const issues = guardIssues(res, 'contractEvidence');
        expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
        expect(res.allPassed).toBe(false);
      }
    });

    it('does not accept project-external file references as contract evidence', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'openswarm-outside-contract-'));
      const outside = join(outsideDir, 'contract.py');
      writeFileSync(outside, "KEY_PREFIX = 'stockapi:foreign_summary:'\n");
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      try {
        const res = await runGuards(
          {
            ...mockWorker(['contract.test.ts']),
            output: `Evidence: ${outside}:1 contains stockapi:foreign_summary:`,
          },
          repo,
          { contractEvidenceCheck: true },
        );
        const issues = guardIssues(res, 'contractEvidence');
        expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
        expect(res.allPassed).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('does not accept parent-relative external file references as contract evidence', async () => {
      const parentOutside = join(repo, '..', `outside-contract-${process.pid}-${Date.now()}.py`);
      writeFileSync(parentOutside, "KEY_PREFIX = 'stockapi:foreign_summary:'\n");
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      try {
        const res = await runGuards(
          {
            ...mockWorker(['contract.test.ts']),
            output: `Evidence: ../${parentOutside.split('/').pop()}:1 contains stockapi:foreign_summary:`,
          },
          repo,
          { contractEvidenceCheck: true },
        );
        const issues = guardIssues(res, 'contractEvidence');
        expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
        expect(res.allPassed).toBe(false);
      } finally {
        rmSync(parentOutside, { force: true });
      }
    });

    it('does not treat HEAD test-only literals as producer evidence', async () => {
      writeFileSync(
        join(repo, 'old-contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('old invented key', () => expect('invented_prefix:').toBeTruthy());\n",
      );
      execFileSync('git', ['add', 'old-contract.test.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add old test-only contract'], { cwd: repo });

      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('reuses invented key', () => expect('invented_prefix:').toBeTruthy());\n",
      );
      const res = await runGuards(
        mockWorker(['contract.test.ts']),
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('invented_prefix:'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not accept vague worker output as contract evidence', async () => {
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['contract.test.ts']),
          output: 'The producer uses stockapi:foreign_summary: and the consumer is aligned.',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not accept the changed test file itself as contract evidence', async () => {
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('stockapi:foreign_summary:').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['contract.test.ts']),
          output: 'Evidence: contract.test.ts:2 contains stockapi:foreign_summary:',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('stockapi:foreign_summary:'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });
  });

  describe('verifiedMetricEvidenceCheck', () => {
    it('blocks removing verified documentation without counter-evidence', async () => {
      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'KIS and pykrx parity is verified by 2026-06-28 sample.\n');
      execFileSync('git', ['add', 'ARCHITECTURE.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add verified doc'], { cwd: repo });

      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'KIS and pykrx parity needs more study.\n');
      const res = await runGuards(
        mockWorker(['ARCHITECTURE.md']),
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('ARCHITECTURE.md'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('allows removing verified documentation when counter-evidence is cited', async () => {
      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'The old parity claim is confirmed by sample A.\n');
      execFileSync('git', ['add', 'ARCHITECTURE.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add confirmed doc'], { cwd: repo });

      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'The old parity claim is superseded.\n');
      const res = await runGuards(
        {
          ...mockWorker(['ARCHITECTURE.md']),
          output: 'ARCHITECTURE.md counter-evidence: remeasured 8 rows and disproves the old parity claim.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('does not accept a negative counter-evidence statement', async () => {
      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'The old parity claim is measured by sample A.\n');
      execFileSync('git', ['add', 'ARCHITECTURE.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add measured doc'], { cwd: repo });

      writeFileSync(join(repo, 'ARCHITECTURE.md'), 'The old parity claim is removed.\n');
      const res = await runGuards(
        {
          ...mockWorker(['ARCHITECTURE.md']),
          output: 'Counter-evidence was not found.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('ARCHITECTURE.md'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('blocks score logic changes without before/after distribution evidence', async () => {
      writeFileSync(join(repo, 'scoreGate.ts'), 'export const score = (x: number) => x > 10 ? 1 : 0;\n');
      execFileSync('git', ['add', 'scoreGate.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add score gate'], { cwd: repo });

      writeFileSync(join(repo, 'scoreGate.ts'), 'export const score = (x: number) => x > 20 ? 1 : 0;\n');
      const res = await runGuards(
        mockWorker(['scoreGate.ts']),
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('scoreGate.ts'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not block config/test terminology that mentions metric or gate', async () => {
      writeFileSync(join(repo, 'config.example.yaml'), 'verifiedMetricEvidenceCheck: true\n');
      writeFileSync(join(repo, 'guardTerminology.test.ts'), 'it("mentions score gate", () => {});\n');
      const res = await runGuards(
        mockWorker(['config.example.yaml', 'guardTerminology.test.ts']),
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('blocks threshold logic changes in non-metric-named source files', async () => {
      writeFileSync(join(repo, 'strategy.ts'), 'export const decide = (score: number) => score > 10;\n');
      execFileSync('git', ['add', 'strategy.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add strategy'], { cwd: repo });

      writeFileSync(join(repo, 'strategy.ts'), 'export const decide = (score: number) => score > 20;\n');
      const res = await runGuards(
        mockWorker(['strategy.ts']),
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('strategy.ts'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('allows score logic changes with before/after distribution evidence', async () => {
      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 1;\n');
      execFileSync('git', ['add', 'metricRanker.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add metric ranker'], { cwd: repo });

      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 2;\n');
      const res = await runGuards(
        {
          ...mockWorker(['metricRanker.ts']),
          output: 'metricRanker.ts before/after distribution: changed 12 items, median delta +2.1, histogram attached.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('does not accept a negative before/after distribution statement', async () => {
      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 1;\n');
      execFileSync('git', ['add', 'metricRanker.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add metric ranker'], { cwd: repo });

      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 3;\n');
      const res = await runGuards(
        {
          ...mockWorker(['metricRanker.ts']),
          output: 'No before/after distribution was produced; delta unavailable.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('metricRanker.ts'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('requires before/after evidence per changed metric file', async () => {
      writeFileSync(join(repo, 'scoreGate.ts'), 'export const score = (x: number) => x > 10 ? 1 : 0;\n');
      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 1;\n');
      execFileSync('git', ['add', 'scoreGate.ts', 'metricRanker.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add metric files'], { cwd: repo });

      writeFileSync(join(repo, 'scoreGate.ts'), 'export const score = (x: number) => x > 20 ? 1 : 0;\n');
      writeFileSync(join(repo, 'metricRanker.ts'), 'export const rank = (score: number) => score * 2;\n');
      const res = await runGuards(
        {
          ...mockWorker(['scoreGate.ts', 'metricRanker.ts']),
          output: 'metricRanker.ts before/after distribution: changed 12 items, median delta +2.1.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('scoreGate.ts'))).toBe(true);
      expect(issues.some(i => i.includes('metricRanker.ts'))).toBe(false);
      expect(res.allPassed).toBe(false);
    });

    it('requires counter-evidence per verified doc removal', async () => {
      writeFileSync(join(repo, 'A.md'), 'Claim A is verified.\n');
      writeFileSync(join(repo, 'B.md'), 'Claim B is measured.\n');
      execFileSync('git', ['add', 'A.md', 'B.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add evidence docs'], { cwd: repo });

      writeFileSync(join(repo, 'A.md'), 'Claim A removed.\n');
      writeFileSync(join(repo, 'B.md'), 'Claim B removed.\n');
      const res = await runGuards(
        {
          ...mockWorker(['A.md', 'B.md']),
          output: 'A.md counter-evidence: remeasured and disproves Claim A.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('A.md'))).toBe(false);
      expect(issues.some(i => i.includes('B.md'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });

    it('does not let basename-matched doc evidence clear another file', async () => {
      mkdirSync(join(repo, 'docs', 'old'), { recursive: true });
      mkdirSync(join(repo, 'docs', 'new'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'old', 'README.md'), 'Old claim is verified.\n');
      writeFileSync(join(repo, 'docs', 'new', 'README.md'), 'New claim is measured.\n');
      execFileSync('git', ['add', 'docs/old/README.md', 'docs/new/README.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add nested docs'], { cwd: repo });

      writeFileSync(join(repo, 'docs', 'old', 'README.md'), 'Old claim removed.\n');
      writeFileSync(join(repo, 'docs', 'new', 'README.md'), 'New claim removed.\n');
      const res = await runGuards(
        {
          ...mockWorker(['docs/old/README.md', 'docs/new/README.md']),
          output: 'docs/new/README.md counter-evidence: remeasured and disproves New claim.',
        },
        repo,
        { verifiedMetricEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'verifiedMetricEvidence');
      expect(issues.some(i => i.includes('docs/old/README.md'))).toBe(true);
      expect(issues.some(i => i.includes('docs/new/README.md'))).toBe(false);
      expect(res.allPassed).toBe(false);
    });
  });

  describe('deadModuleCheck', () => {
    it('flags a new source module that nothing imports', async () => {
      writeFileSync(join(repo, 'orphanwidget.ts'), 'export function orphanwidget() { return 1; }\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('orphanwidget.ts'))).toBe(true);
      // non-blocking: overall still passes
      expect(res.allPassed).toBe(true);
    });

    it('does NOT flag a new module that an existing file imports', async () => {
      // A committed file references the new module by basename.
      writeFileSync(join(repo, 'caller.ts'), "import { helperthing } from './helperthing.js';\nexport const c = helperthing;\n");
      execFileSync('git', ['add', 'caller.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add caller'], { cwd: repo });
      // Now the new module appears (untracked); caller already imports it.
      writeFileSync(join(repo, 'helperthing.ts'), 'export const helperthing = 42;\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('helperthing.ts'))).toBe(false);
    });

    it('ignores new test files', async () => {
      writeFileSync(join(repo, 'somefeature.test.ts'), 'import { it } from "vitest"; it("x", () => {});\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('somefeature.test.ts'))).toBe(false);
    });

    it('skips generic/short basenames to avoid grep noise', async () => {
      writeFileSync(join(repo, 'index.ts'), 'export const idx = 1;\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('index.ts'))).toBe(false);
    });
  });

  describe('reformatCheck', () => {
    it('flags a whitespace-only change', async () => {
      writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n'); // re-indent only
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.some(i => i.includes('base.ts') && i.includes('reformat-only'))).toBe(true);
      expect(res.allPassed).toBe(true);
    });

    it('does NOT flag a semantic change', async () => {
      writeFileSync(join(repo, 'base.ts'), 'export const base = 999;\n');
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.length).toBe(0);
    });

    it('flags an oversized diff (tracked-line count)', async () => {
      // Large-diff uses tracked numstat; rewrite a committed file so the added
      // lines register (untracked new files count as 0 added — see guard note).
      const bigLine = 'export const v = 1;\n';
      writeFileSync(join(repo, 'base.ts'), bigLine.repeat(1300));
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.some(i => i.includes('Large diff'))).toBe(true);
    });
  });

  it('runs neither guard when disabled', async () => {
    writeFileSync(join(repo, 'orphanwidget.ts'), 'export const x = 1;\n');
    const res = await runGuards(mockWorker(), repo, {});
    expect(res.results.find(r => r.guard === 'deadModule')).toBeUndefined();
    expect(res.results.find(r => r.guard === 'reformatScope')).toBeUndefined();
  });

  // A worker can close a "diagnose root cause" task while its own report admits
  // the cause was never pinned down — this signal must reach the reviewer instead
  // of dying silently (INT-2421, real incident: STO-1447/PR #217).
  describe('uncertaintyDetection', () => {
    it('flags a worker report admitting an unconfirmed root cause', async () => {
      const res = await runGuards(
        { ...mockWorker(), summary: 'Cause — unconfirmed (open question), added a backfill workaround.' },
        repo,
        { uncertaintyDetection: true },
      );
      const issues = guardIssues(res, 'uncertaintyDetection');
      expect(issues.some(i => i.includes('unconfirmed'))).toBe(true);
      // non-blocking — surfaced as a warning, does not fail the guard run
      expect(res.allPassed).toBe(true);
    });

    it('does not flag a confident, evidence-backed report', async () => {
      const res = await runGuards(
        { ...mockWorker(), summary: 'Root cause confirmed at trading_engine.py:42; fixed and verified with a regression test.' },
        repo,
        { uncertaintyDetection: true },
      );
      const issues = guardIssues(res, 'uncertaintyDetection');
      expect(issues.length).toBe(0);
    });
  });
});
