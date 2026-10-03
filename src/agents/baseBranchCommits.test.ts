import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliAdapter, CliRunResult } from '../adapters/types.js';
import { findBaseCommitsForIssue, formatBaseCommitsSection } from './baseBranchCommits.js';
import { runDraftAnalysis } from './draftAnalyzer.js';
import * as adapterModule from '../adapters/index.js';
import * as knowledgeModule from '../knowledge/index.js';
import * as registryModule from '../registry/sqliteStore.js';

// AX-1828 was run seven times and published as a PR over tests `main` already carried,
// because nothing told the worker that commits for the issue were already there (AGT-4674).

const roots: string[] = [];

function repoWith(messages: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'osw-base-commits-'));
  roots.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    stdio: 'pipe',
  });
  git('init', '-q', '-b', 'main');
  messages.forEach((message, index) => {
    writeFileSync(join(dir, 'f.txt'), `${index}\n`);
    git('add', 'f.txt');
    git('commit', '-q', '-m', message);
  });
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('findBaseCommitsForIssue', () => {
  it('lists commits that name the issue in the subject or in the body, newest first', async () => {
    const dir = repoWith([
      'fix(b1): keep month cells on one line (AX-1828)',
      'chore: unrelated',
      'feat(b1): one store, one row\n\nCloses AX-1828 for the alias rows.',
    ]);
    const found = await findBaseCommitsForIssue(dir, 'AX-1828');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('feat(b1): one store, one row');
    expect(found[1]).toContain('keep month cells on one line (AX-1828)');
    expect(found[0]).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} /);
  });

  it('does not take AX-18281 or AX-182 for AX-1828', async () => {
    const dir = repoWith(['fix: other issue (AX-18281)', 'fix: shorter id (AX-182)', 'fix: right one (AX-1828)']);
    const found = await findBaseCommitsForIssue(dir, 'AX-1828');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('right one');
  });

  it('lists at most eight commits', async () => {
    const dir = repoWith(Array.from({ length: 12 }, (_, i) => `fix: step ${i} (AX-1828)`));
    expect(await findBaseCommitsForIssue(dir, 'AX-1828')).toHaveLength(8);
  });

  it('returns nothing for no match, a bad identifier, a missing id or a directory that is not a repository', async () => {
    const dir = repoWith(['fix: something (AX-1)']);
    expect(await findBaseCommitsForIssue(dir, 'AX-1828')).toEqual([]);
    for (const bad of ['', 'not an id', '--all', 'AX-', 'AX-1828; rm -rf /', undefined]) {
      expect(await findBaseCommitsForIssue(dir, bad as string | undefined)).toEqual([]);
    }
    const plain = mkdtempSync(join(tmpdir(), 'osw-not-a-repo-'));
    roots.push(plain);
    expect(await findBaseCommitsForIssue(plain, 'AX-1828')).toEqual([]);
  });
});

describe('formatBaseCommitsSection', () => {
  it('is empty without commits and tells the worker to check coverage with them', () => {
    expect(formatBaseCommitsSection([])).toBe('');
    const section = formatBaseCommitsSection(['abc1234 2026-10-02 fix: month cells (AX-1828)']);
    expect(section).toContain('## Already on the base branch for this issue');
    expect(section).toContain('- abc1234 2026-10-02 fix: month cells (AX-1828)');
    expect(section).toContain('build only what is missing');
  });
});

describe('runDraftAnalysis brief with base-branch commits (AGT-4674)', () => {
  const adapter = {
    name: 'codex',
    capabilities: { supportsStreaming: true, supportsJsonOutput: true, supportsModelSelection: true, managedGit: false, supportedSkills: [] },
    isAvailable: vi.fn(async () => true),
    getDefaultModel: vi.fn(async () => 'default-model'),
    buildCommand: () => ({ command: 'echo', args: [] }),
    parseWorkerOutput: vi.fn(),
    parseReviewerOutput: vi.fn(),
  } as unknown as CliAdapter;
  const sufficient = JSON.stringify({
    taskType: 'bugfix', intentSummary: 'Drop the alias rows from the monthly view',
    relevantFiles: ['a.ts'], suggestedApproach: 'Extend the existing store-name helper and call it.',
    completionCriteria: ['alias rows are gone from the monthly view (cite the render path)', 'test covers the alias case'],
  });

  beforeEach(() => {
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(null);
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue({
      getStats: vi.fn(() => ({ total: 0, byKind: [], byStatus: [], deprecated: 0, untested: 0, withWarnings: 0, highRisk: 0 })),
      highRiskEntities: vi.fn(() => []),
      fileBrief: vi.fn(() => ({ filePath: 'a.ts', summary: 'ok', entities: [] })),
    } as never);
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(adapter);
  });

  function capture(): string[] {
    const prompts: string[] = [];
    vi.spyOn(adapterModule, 'spawnCli').mockImplementation(async (_adapter, options) => {
      prompts.push(options.prompt);
      await options.finishValidator?.(sufficient, 1);
      return { exitCode: 0, stdout: sufficient, stderr: '', durationMs: 1 } as CliRunResult;
    });
    return prompts;
  }

  it('puts the commits the base branch already has for the issue into the prompt', async () => {
    const dir = repoWith(['fix(b1): keep month cells on one line (AX-1828)']);
    const prompts = capture();
    await runDraftAnalysis({ taskTitle: 'Alias rows', taskDescription: 'd', projectPath: dir, taskId: 'AX-1828' });
    expect(prompts[0]).toContain('## Already on the base branch for this issue');
    expect(prompts[0]).toContain('keep month cells on one line (AX-1828)');
    expect(prompts[0].indexOf('## Task')).toBeLessThan(prompts[0].indexOf('## Already on the base branch'));
  });

  it('leaves the prompt as it was when the base branch has nothing for the issue', async () => {
    const dir = repoWith(['fix: something else (AX-1)']);
    const prompts = capture();
    await runDraftAnalysis({ taskTitle: 'Alias rows', taskDescription: 'd', projectPath: dir, taskId: 'AX-1828' });
    expect(prompts[0]).not.toContain('Already on the base branch');
  });
});
