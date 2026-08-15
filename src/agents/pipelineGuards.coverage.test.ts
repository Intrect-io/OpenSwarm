// ============================================
// OpenSwarm - Pipeline Guards additional coverage
// Targets guard functions that pipelineGuards.test.ts does not yet exercise:
// qualityGate, fakeDataGuard, conventionalCommits, branchValidation,
// registryCheck, bsDetector, plus a few narrow catch branches inside the
// contractEvidence and deadModule guards. Kept in a separate file per
// instructions — pipelineGuards.test.ts is left untouched.
// ============================================

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConventionalCommitGuard, runGuards } from './pipelineGuards.js';
import type { WorkerResult } from './agentPair.js';

function mockWorker(filesChanged: string[] = []): WorkerResult {
  return { success: true, summary: '', filesChanged, commands: [], output: '' };
}

function guardIssues(results: Awaited<ReturnType<typeof runGuards>>, guard: string): string[] {
  return results.results.find(r => r.guard === guard)?.issues ?? [];
}

describe('pipelineGuards — additional coverage', () => {
  let repo: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-guards-cov-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    // Keep the quality-gate tests independent from tools installed on the host.
    // `runQualityGate` invokes `npx tsc` and `ruff` from the target repository,
    // so provide deterministic fixture executables for both success and failure.
    const nodeBin = join(repo, 'node_modules', '.bin');
    const fixtureBin = join(repo, 'bin');
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(fixtureBin, { recursive: true });
    const tscFixture = join(nodeBin, 'tsc');
    writeFileSync(tscFixture, '#!/bin/sh\nif [ -f bad.ts ]; then exit 1; fi\n');
    chmodSync(tscFixture, 0o755);
    const ruffFixture = join(fixtureBin, 'ruff');
    writeFileSync(ruffFixture, '#!/bin/sh\nif [ -n "$RUFF_ARGS_LOG" ]; then printf "%s\\n" "$@" > "$RUFF_ARGS_LOG"; fi\nshift\nif grep -q "import os" "$@"; then exit 1; fi\n');
    chmodSync(ruffFixture, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fixtureBin}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.RUFF_ARGS_LOG;
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  // --------------------------------------------------------------
  // qualityGate — TypeScript branch (npx tsc --noEmit) and Python
  // branch (ruff check) are only reachable when config.qualityGate
  // is enabled; the companion test file never turns it on.
  // --------------------------------------------------------------
  describe('qualityGate', () => {
    it('passes when the TypeScript project type-checks cleanly', async () => {
      writeFileSync(
        join(repo, 'tsconfig.json'),
        '{"compilerOptions":{"strict":true,"noEmit":true},"files":["good.ts"]}\n',
      );
      writeFileSync(join(repo, 'good.ts'), 'export const ok: number = 1;\n');
      const res = await runGuards(mockWorker(['good.ts']), repo, { qualityGate: true });
      const issues = guardIssues(res, 'qualityGate');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    }, 30000);

    it('blocks when the TypeScript project fails to type-check', async () => {
      writeFileSync(
        join(repo, 'tsconfig.json'),
        '{"compilerOptions":{"strict":true,"noEmit":true},"files":["bad.ts"]}\n',
      );
      writeFileSync(join(repo, 'bad.ts'), 'const y: number = "oops";\n');
      const res = await runGuards(mockWorker(['bad.ts']), repo, { qualityGate: true });
      const issues = guardIssues(res, 'qualityGate');
      expect(issues.some(i => i.includes('TypeScript check failed'))).toBe(true);
      // qualityGate is blocking
      expect(res.allPassed).toBe(false);
    }, 30000);

    it('passes when Python files pass ruff check', async () => {
      writeFileSync(join(repo, 'clean.py'), 'x = 1\n');
      const res = await runGuards(mockWorker(['clean.py']), repo, { qualityGate: true });
      const issues = guardIssues(res, 'qualityGate');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    }, 30000);

    it('blocks when Python files fail ruff check', async () => {
      writeFileSync(join(repo, 'unused_import.py'), 'import os\n');
      const res = await runGuards(mockWorker(['unused_import.py']), repo, { qualityGate: true });
      const issues = guardIssues(res, 'qualityGate');
      expect(issues.some(i => i.includes('Ruff check failed'))).toBe(true);
      expect(res.allPassed).toBe(false);
    }, 30000);

    it('separates Ruff options from adversarial Python filenames with --', async () => {
      const file = '--select.py';
      const argsLog = join(repo, 'ruff-args.txt');
      process.env.RUFF_ARGS_LOG = argsLog;
      writeFileSync(join(repo, file), 'x = 1\n');

      const res = await runGuards(mockWorker([file]), repo, { qualityGate: true });

      expect(res.allPassed).toBe(true);
      expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual(['check', '--', file]);
      delete process.env.RUFF_ARGS_LOG;
    }, 30000);
  });

  // --------------------------------------------------------------
  // fakeDataGuard — non-blocking scan of worker output for fake/mock
  // data patterns.
  // --------------------------------------------------------------
  describe('fakeDataGuard', () => {
    it('flags a fake-data pattern in worker output without blocking', async () => {
      const res = await runGuards(
        { ...mockWorker(), output: 'Generated fixture via faker.name() for the demo user.' },
        repo,
        { fakeDataGuard: true },
      );
      const issues = guardIssues(res, 'fakeDataGuard');
      expect(issues.some(i => i.includes('faker.'))).toBe(true);
      // non-blocking
      expect(res.allPassed).toBe(true);
    });

    it('does not flag clean worker output', async () => {
      const res = await runGuards(
        { ...mockWorker(), output: 'Implemented the retry backoff and added a regression test.' },
        repo,
        { fakeDataGuard: true },
      );
      const issues = guardIssues(res, 'fakeDataGuard');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });
  });

  // --------------------------------------------------------------
  // conventionalCommits — exported directly, called by the pipeline
  // outside of runGuards (see comment at the bottom of runGuards).
  // --------------------------------------------------------------
  describe('runConventionalCommitGuard', () => {
    it('passes a well-formed conventional commit message', () => {
      const res = runConventionalCommitGuard('fix(guards): tighten branch validation regex');
      expect(res.issues.length).toBe(0);
      expect(res.passed).toBe(true);
      expect(res.blocking).toBe(false);
    });

    it('flags a commit message that does not follow the convention', () => {
      const res = runConventionalCommitGuard('updated some stuff');
      expect(res.issues.some(i => i.includes('does not follow conventional format'))).toBe(true);
      expect(res.passed).toBe(false);
      // non-blocking — advisory only
      expect(res.blocking).toBe(false);
    });
  });

  // --------------------------------------------------------------
  // branchValidation — reads the current branch via `git branch
  // --show-current` and checks it against the allowed patterns.
  // --------------------------------------------------------------
  describe('branchValidation', () => {
    it('passes on a branch matching an allowed pattern (main)', async () => {
      const res = await runGuards(mockWorker(), repo, { branchValidation: true });
      const issues = guardIssues(res, 'branchValidation');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('flags a branch name outside the allowed patterns', async () => {
      execFileSync('git', ['checkout', '-b', 'wip-experiment'], { cwd: repo });
      const res = await runGuards(mockWorker(), repo, { branchValidation: true });
      const issues = guardIssues(res, 'branchValidation');
      expect(issues.some(i => i.includes('wip-experiment') && i.includes('does not match allowed patterns'))).toBe(true);
      // non-blocking
      expect(res.allPassed).toBe(true);
    });
  });

  // --------------------------------------------------------------
  // registryCheck — reads the code registry (a real, shared SQLite
  // singleton keyed by getRegistryStore()'s default path). We only
  // exercise read-only paths against it:
  //  1. a file path guaranteed absent from the registry (empty brief)
  //  2. a forced store-path mismatch, which drives the guard's own
  //     catch branch without touching the registry's real data.
  // --------------------------------------------------------------
  describe('registryCheck', () => {
    it('passes with no issues for a file that has no registry entities', async () => {
      const res = await runGuards(
        mockWorker(['zz-coverage-registry-check-nonexistent-file-8842.ts']),
        repo,
        { registryCheck: true },
      );
      const issues = guardIssues(res, 'registryCheck');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('swallows a registry-store-unavailable error without throwing', async () => {
      const { getRegistryStore, closeRegistryStore } = await import('../registry/sqliteStore.js');
      closeRegistryStore();
      // Open the singleton against a different path first so the guard's own
      // getRegistryStore() call (which always requests the default path)
      // mismatches and throws — deterministically exercising the guard's
      // catch branch without touching the real ~/.openswarm/registry.db content.
      const decoyDbPath = join(repo, 'decoy-registry.db');
      getRegistryStore(decoyDbPath);
      try {
        const res = await runGuards(mockWorker(['base.ts']), repo, { registryCheck: true });
        const issues = guardIssues(res, 'registryCheck');
        expect(issues.length).toBe(0);
        expect(res.allPassed).toBe(true);
      } finally {
        closeRegistryStore();
      }
    });
  });

  // --------------------------------------------------------------
  // bsDetector — scans real changed-file contents for BS patterns
  // via scanFile()/scanFileContent(). CRITICAL patterns block; other
  // severities are advisory.
  // --------------------------------------------------------------
  describe('bsDetector', () => {
    it('blocks on a CRITICAL pattern (leftover debugger statement) and survives a missing file', async () => {
      writeFileSync(join(repo, 'debuggerfile.ts'), 'export function run() {\n  debugger;\n  return 1;\n}\n');
      const res = await runGuards(
        // Second entry does not exist on disk — scanFile()'s readFile will
        // reject, exercising the guard's own catch branch after the first
        // file's issue has already been recorded.
        mockWorker(['debuggerfile.ts', 'ghost-file-does-not-exist.ts']),
        repo,
        { bsDetector: true },
      );
      const issues = guardIssues(res, 'bsDetector');
      expect(issues.some(i => i.includes('CRITICAL') && i.includes('debuggerfile.ts'))).toBe(true);
      // bsDetector is blocking only when a CRITICAL issue is found
      expect(res.allPassed).toBe(false);
    });

    it('does not block on a WARNING-only pattern (console.log leftover)', async () => {
      writeFileSync(join(repo, 'chatty.ts'), "export function greet() {\n  console.log('hello');\n}\n");
      const res = await runGuards(mockWorker(['chatty.ts']), repo, { bsDetector: true });
      const issues = guardIssues(res, 'bsDetector');
      expect(issues.some(i => i.includes('WARNING') && i.includes('chatty.ts'))).toBe(true);
      // non-blocking — no CRITICAL issue among the findings
      expect(res.allPassed).toBe(true);
    });

    it('passes with no issues for clean source', async () => {
      writeFileSync(join(repo, 'clean-source.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
      const res = await runGuards(mockWorker(['clean-source.ts']), repo, { bsDetector: true });
      const issues = guardIssues(res, 'bsDetector');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });
  });

  // --------------------------------------------------------------
  // contractEvidenceCheck — hasExternalContractEvidence()'s per-file
  // readFile loop (lines the pipelineGuards.test.ts suite never
  // reaches because its scenarios are all excluded earlier by the
  // same-diff or knownInHead short-circuits).
  //
  // A gitignored evidence file is neither part of HEAD (so
  // literalExistsInHeadSource's git-grep won't find the literal) nor
  // part of the working-tree diff (so it isn't in excludedFiles) —
  // yet it is a real, readable file on disk, which is exactly the
  // condition needed to reach the targeted readFile lookup.
  // --------------------------------------------------------------
  describe('contractEvidenceCheck — external evidence file lookup', () => {
    it('accepts a gitignored evidence file cited by file:line as external proof', async () => {
      writeFileSync(join(repo, '.gitignore'), 'observed/\n');
      execFileSync('git', ['add', '.gitignore'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'ignore observed dir'], { cwd: repo });

      mkdirSync(join(repo, 'observed'), { recursive: true });
      writeFileSync(join(repo, 'observed', 'sample.json'), '{"key":"gitignored_evidence_literal_501"}\n');

      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('gitignored_evidence_literal_501').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['contract.test.ts']),
          output: 'Evidence: observed/sample.json:1 contains gitignored_evidence_literal_501',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.length).toBe(0);
      expect(res.allPassed).toBe(true);
    });

    it('does not accept a citation pointing at a file that does not exist on disk', async () => {
      writeFileSync(
        join(repo, 'contract.test.ts'),
        "import { expect, it } from 'vitest';\nit('uses key', () => expect('missing_producer_literal_777').toBeTruthy());\n",
      );
      const res = await runGuards(
        {
          ...mockWorker(['contract.test.ts']),
          output: 'Evidence: nonexistent/producer.ts:3 contains missing_producer_literal_777',
        },
        repo,
        { contractEvidenceCheck: true },
      );
      const issues = guardIssues(res, 'contractEvidence');
      expect(issues.some(i => i.includes('missing_producer_literal_777'))).toBe(true);
      expect(res.allPassed).toBe(false);
    });
  });

  // --------------------------------------------------------------
  // deadModuleCheck — the inner git-grep catch (zero matches for the
  // module's own basename, including inside its own file — unlike
  // the existing "nothing imports orphanwidget" test, whose file
  // content contains its own name and therefore matches itself,
  // taking the non-throwing branch instead).
  // --------------------------------------------------------------
  describe('deadModuleCheck — zero-match git-grep catch', () => {
    it('flags a new module whose own content never mentions its basename', async () => {
      // Content deliberately avoids the string "zzznevermentioned" so that
      // `git grep -F -e zzznevermentioned` finds zero matches anywhere
      // (including the file itself) and exits non-zero, exercising the
      // guard's internal catch instead of the post-filter "self-match" path.
      writeFileSync(join(repo, 'zzznevermentioned.ts'), 'export const value = 1;\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('zzznevermentioned.ts'))).toBe(true);
      expect(res.allPassed).toBe(true);
    });
  });
});
