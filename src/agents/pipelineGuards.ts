// ============================================
// OpenSwarm - Pipeline Guards
// Quality gates and validation between worker/reviewer
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkerResult } from './agentPair.js';
import type { PipelineGuardsConfig } from '../core/types.js';

const execFileAsync = promisify(execFile);

// ============================================
// Types
// ============================================

export interface GuardResult {
  passed: boolean;
  guard: string;
  issues: string[];
  blocking: boolean;
}

export interface GuardsRunResult {
  allPassed: boolean;
  results: GuardResult[];
  combinedIssues: string[];
}

// ============================================
// Uncertainty Detection Patterns
// ============================================

const UNCERTAINTY_PATTERNS = [
  'maybe', 'might', 'probably', 'perhaps',
  'workaround', 'hack', 'temporary fix', 'temp fix',
  'not sure', 'not certain', 'unclear',
  'i think', 'i believe', 'i assume',
  'could be', 'seems like', 'appears to',
  'not tested', 'untested', 'skip test',
  'todo', 'fixme', 'xxx',
];

// ============================================
// Fake Data Detection Patterns
// ============================================

const FAKE_DATA_PATTERNS = [
  /faker\./i,
  /\bnp\.random\b/,
  /Math\.random\(\)/,
  /lorem\s*ipsum/i,
  /test@test\.com/i,
  /foo@bar\.com/i,
  /mockData\b/i,
  /dummy\s*data/i,
  /placeholder\s*text/i,
  /sample\s*data/i,
];

// ============================================
// Conventional Commit Pattern
// ============================================

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+/;

// ============================================
// Branch Name Patterns
// ============================================

const VALID_BRANCH_PATTERNS = [
  /^swarm\/.+/,
  /^feature\/.+/,
  /^release\/v.+/,
  /^hotfix\/.+/,
  /^main$/,
  /^develop$/,
];

// ============================================
// Guard Functions
// ============================================

/**
 * Quality gate: run tsc --noEmit on TypeScript files or ruff check on Python files.
 * Blocking — failure causes a revise.
 */
async function runQualityGate(
  workerResult: WorkerResult,
  projectPath: string,
): Promise<GuardResult> {
  const guard = 'qualityGate';
  const issues: string[] = [];

  const tsFiles = workerResult.filesChanged.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pyFiles = workerResult.filesChanged.filter(f => f.endsWith('.py'));

  if (tsFiles.length > 0) {
    try {
      await execFileAsync('npx', ['tsc', '--noEmit'], {
        cwd: projectPath,
        timeout: 60_000,
      });
    } catch (err: any) {
      const stderr = err.stderr || err.stdout || String(err);
      issues.push(`TypeScript check failed: ${stderr.slice(0, 500)}`);
    }
  }

  if (pyFiles.length > 0) {
    try {
      await execFileAsync('ruff', ['check', ...pyFiles], {
        cwd: projectPath,
        timeout: 60_000,
      });
    } catch (err: any) {
      const stderr = err.stderr || err.stdout || String(err);
      issues.push(`Ruff check failed: ${stderr.slice(0, 500)}`);
    }
  }

  return { passed: issues.length === 0, guard, issues, blocking: true };
}

/**
 * Fake data guard: detect faker, random, mock data patterns in changed output.
 * Non-blocking — warning only.
 */
function runFakeDataGuard(workerResult: WorkerResult): GuardResult {
  const guard = 'fakeDataGuard';
  const issues: string[] = [];

  const textToScan = workerResult.output.slice(0, 5000);

  for (const pattern of FAKE_DATA_PATTERNS) {
    const match = textToScan.match(pattern);
    if (match) {
      issues.push(`Possible fake/mock data detected: "${match[0]}"`);
    }
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Conventional commit guard: validate commit message format.
 * Non-blocking — warning only.
 */
export function runConventionalCommitGuard(commitMessage: string): GuardResult {
  const guard = 'conventionalCommits';
  const issues: string[] = [];

  const firstLine = commitMessage.split('\n')[0].trim();
  if (!CONVENTIONAL_COMMIT_RE.test(firstLine)) {
    issues.push(
      `Commit message does not follow conventional format: "${firstLine.slice(0, 80)}". ` +
      `Expected: type(scope): description`,
    );
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Branch name guard: validate branch naming convention.
 * Non-blocking — warning only.
 */
async function runBranchNameGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'branchValidation';
  const issues: string[] = [];

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      timeout: 5_000,
    });
    const branch = stdout.trim();
    if (branch && !VALID_BRANCH_PATTERNS.some(p => p.test(branch))) {
      issues.push(
        `Branch "${branch}" does not match allowed patterns: swarm/*, feature/*, release/v*, hotfix/*, main, develop`,
      );
    }
  } catch {
    // git not available or not in repo — skip silently
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Uncertainty detection: scan worker output for uncertainty phrases.
 * Non-blocking — populates uncertaintySignals on WorkerResult.
 */
function runUncertaintyDetection(workerResult: WorkerResult): GuardResult {
  const guard = 'uncertaintyDetection';
  const issues: string[] = [];

  const textToScan = (
    workerResult.summary + ' ' + workerResult.output.slice(0, 2000)
  ).toLowerCase();

  const detected: string[] = [];
  for (const phrase of UNCERTAINTY_PATTERNS) {
    if (textToScan.includes(phrase)) {
      detected.push(phrase);
    }
  }

  if (detected.length > 0) {
    issues.push(`Uncertainty signals detected: ${detected.join(', ')}`);
    // Populate on the result for downstream use
    workerResult.uncertaintySignals = detected;
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

// ============================================
// Guard Runner
// ============================================

/**
 * Run all enabled guards on a worker result.
 */
export async function runGuards(
  workerResult: WorkerResult,
  projectPath: string,
  config: Partial<PipelineGuardsConfig>,
): Promise<GuardsRunResult> {
  const results: GuardResult[] = [];

  if (config.qualityGate) {
    results.push(await runQualityGate(workerResult, projectPath));
  }

  if (config.fakeDataGuard) {
    results.push(runFakeDataGuard(workerResult));
  }

  if (config.branchValidation) {
    results.push(await runBranchNameGuard(projectPath));
  }

  if (config.uncertaintyDetection) {
    results.push(runUncertaintyDetection(workerResult));
  }

  // conventionalCommits is checked separately (needs commit message)
  // haltToLinear is handled by the pipeline, not a guard function

  const combinedIssues = results.flatMap(r => r.issues);
  const allPassed = results.every(r => r.passed || !r.blocking);

  return { allPassed, results, combinedIssues };
}
