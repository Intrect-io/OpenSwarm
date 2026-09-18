// Purpose: the in-loop reviewer is a read-only judge that can see the change.
//
// Before this it inherited the default-off `readOnly` of the local
// `openswarm review` path, so it held write_file/edit_file/apply_patch/bash on
// the worktree it was judging and could repair the diff before approving it.
// Read-only alone is not enough either: without a diff a read-only reviewer
// sees only the resulting files, and reading a file shows the result, never the
// change (INT-3101). (AGT-4443)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEWER_DIFF_MAX_BYTES, buildReviewerStageOptions } from './reviewerStageOptions.js';
import { buildReviewerPrompt } from './reviewer.js';
import type { PipelineConfig, PipelineContext } from './pairPipelineTypes.js';
import type { WorkerResult } from './worker.js';

const repos: string[] = [];
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** A repo whose worktree carries the shape that started this: an edited gate test. */
function repoWithWorkerEdits(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'osw-reviewer-diff-')));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'test_contracts.py'), 'def test_x():\n    assert check(a)\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  // Tracked file weakened, plus a brand-new untracked file.
  writeFileSync(join(repo, 'tests', 'test_contracts.py'), 'def test_x():\n    if "sensitive" in a:\n        return\n    assert check(a)\n');
  writeFileSync(join(repo, 'adapter.py'), 'class A2FixedExpense:\n    pass\n');
  return repo;
}

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    success: true,
    summary: 'added the adapter',
    filesChanged: ['tests/test_contracts.py', 'adapter.py'],
    commands: ['pytest'],
    output: '',
    ...over,
  };
}

function context(projectPath: string): PipelineContext {
  return {
    task: { id: 'i', issueId: 'i', issueIdentifier: 'AX-1556', source: 'linear', title: 'A2 adapter', priority: 2, createdAt: 0 },
    projectPath,
    workerResult: workerResult(),
    session: { id: 's' },
    currentIteration: 1,
    taskPrefix: 'p',
  } as unknown as PipelineContext;
}

const config = { roles: { reviewer: { enabled: true } } } as unknown as PipelineConfig;

describe('the in-loop reviewer stage (AGT-4443)', () => {
  it('is read-only, so it cannot repair the diff it is judging', async () => {
    const repo = repoWithWorkerEdits();
    const options = await buildReviewerStageOptions({ config, context: context(repo), prefix: 'p' });
    expect(options.readOnly).toBe(true);
  });

  it('carries the diff, including the weakened tracked file and the new untracked one', async () => {
    const repo = repoWithWorkerEdits();
    const options = await buildReviewerStageOptions({ config, context: context(repo), prefix: 'p' });

    expect(options.diff).toBeDefined();
    // The edit a reviewer must be able to see: a gate test taught to return early.
    expect(options.diff).toContain('tests/test_contracts.py');
    expect(options.diff).toContain('+    if "sensitive" in a:');
    // `git diff` alone ignores untracked files, which would list a changed file
    // with no patch behind it.
    expect(options.diff).toContain('adapter.py');
    expect(options.diff).toContain('+class A2FixedExpense:');
  });

  it('leaves the diff undefined on a clean tree rather than sending an empty string', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'osw-reviewer-clean-')));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');

    const options = await buildReviewerStageOptions({ config, context: context(repo), prefix: 'p' });
    expect(options.diff).toBeUndefined();
  });

  it('still produces options when the path is not a repository, so review is never skipped for a git failure', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'osw-reviewer-norepo-'));
    repos.push(notARepo);
    const options = await buildReviewerStageOptions({ config, context: context(notARepo), prefix: 'p' });
    expect(options.readOnly).toBe(true);
    expect(options.diff).toBeUndefined();
    expect(options.workerResult.filesChanged).toContain('adapter.py');
  });

  it('keeps the evidence and guard-warning wiring the stage already had', async () => {
    const repo = repoWithWorkerEdits();
    const ctx = context(repo);
    (ctx as { guardsResult?: unknown }).guardsResult = {
      results: [
        { guard: 'bsDetector', passed: false, blocking: false, issues: ['service.py:1058 magic number'] },
        { guard: 'other', passed: true, blocking: false, issues: ['not reported'] },
      ],
    };
    const options = await buildReviewerStageOptions({ config, context: ctx, prefix: 'p' });

    expect(options.guardWarnings).toEqual(['service.py:1058 magic number']);
    expect(options.projectPath).toBe(repo);
  });
});

describe('the change-mode prompt shows the diff (AGT-4443)', () => {
  it('includes the diff when one is supplied, after the fields a cut must not eat', () => {
    const prompt = buildReviewerPrompt({
      taskTitle: 'A2 adapter',
      taskDescription: 'AX-1556',
      workerResult: workerResult(),
      projectPath: '/repo',
      diff: '--- a/tests/test_contracts.py\n+++ b/tests/test_contracts.py\n+    if "sensitive" in a:',
    });

    expect(prompt).toContain('Diff under review');
    expect(prompt).toContain('+    if "sensitive" in a:');
    // The verdict-bearing fields come first, so a template-level truncation
    // takes the diff's tail rather than the summary or the guard warnings.
    expect(prompt.indexOf('**Summary:**')).toBeLessThan(prompt.indexOf('Diff under review'));
  });

  it('omits the section entirely when no diff was supplied', () => {
    const prompt = buildReviewerPrompt({
      taskTitle: 'A2 adapter',
      taskDescription: 'AX-1556',
      workerResult: workerResult(),
      projectPath: '/repo',
    });
    expect(prompt).not.toContain('Diff under review');
  });

  it('bounds the diff the stage collects', () => {
    // Stated as a constant so the cap is reviewable; getDiffText puts its
    // truncation notice first, so a cut cannot hide that the diff is partial.
    expect(REVIEWER_DIFF_MAX_BYTES).toBe(16_000);
  });
});
