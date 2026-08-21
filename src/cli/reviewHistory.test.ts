import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReviewFileHashes,
  dedupeReviewActions,
  loadReviewHistory,
  renderReviewHistoryContext,
  saveReviewHistory,
} from './reviewHistory.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-review-history-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return root;
}

describe('review history', () => {
  it('persists a structured result and renders it for an overlapping unchanged scope', async () => {
    const root = await repo();
    const path = await saveReviewHistory(root, {
      kind: 'direct', files: ['src/a.ts'],
      review: {
        decision: 'revise', feedback: 'fix it', issues: ['src/a.ts:1 is wrong'],
        recommendedActions: [{ type: 'bug', title: 'Fix A', location: 'src/a.ts:1' }],
      },
      createdAt: '2026-07-21T00:00:00.000Z',
    });

    expect(JSON.parse(await readFile(path, 'utf8')).fileHashes['src/a.ts']).toMatch(/^file:/);
    const loaded = await loadReviewHistory(root);
    const hashes = await captureReviewFileHashes(root, ['src/a.ts']);
    const rendered = renderReviewHistoryContext(loaded, ['src/a.ts'], hashes);
    expect(rendered.context).toContain('1/1 overlapping files unchanged');
    expect(rendered.context).toContain('follow-up: [bug] Fix A');
    expect(rendered.matchingRecords).toHaveLength(1);
  });

  it('loads compact legacy audit excerpts without treating them as hash-backed records', async () => {
    const root = await repo();
    await mkdir(join(root, '.openswarm', 'audit'), { recursive: true });
    await writeFile(join(root, '.openswarm', 'audit', 'audit-2026-01-01.md'), [
      '# Codebase audit', '## Recommended follow-ups (1, deduped)', '- Fix old bug', '## Issues (1)', '- old issue',
    ].join('\n'));
    const loaded = await loadReviewHistory(root);
    expect(loaded.records).toEqual([]);
    expect(loaded.legacyExcerpts[0]).toContain('Fix old bug');
  });

  it('removes a repeated follow-up only while its target file is unchanged', async () => {
    const root = await repo();
    await saveReviewHistory(root, {
      kind: 'direct', files: ['src/a.ts'],
      review: {
        decision: 'revise', feedback: '',
        recommendedActions: [{ type: 'bug', title: 'Fix A', location: 'src/a.ts:1' }],
      },
    });
    const loaded = await loadReviewHistory(root);
    let hashes = await captureReviewFileHashes(root, ['src/a.ts']);
    const repeated = dedupeReviewActions({
      decision: 'revise', feedback: '', issues: ['still broken'],
      recommendedActions: [{ type: 'bug', title: 'Fix A', location: 'src/a.ts:9' }],
    }, loaded.records, hashes);
    expect(repeated.removed).toBe(1);
    expect(repeated.review.issues).toEqual(['still broken']);
    expect(repeated.review.recommendedActions).toEqual([]);

    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    hashes = await captureReviewFileHashes(root, ['src/a.ts']);
    const afterChange = dedupeReviewActions({
      decision: 'revise', feedback: '',
      recommendedActions: [{ type: 'bug', title: 'Fix A', location: 'src/a.ts:9' }],
    }, loaded.records, hashes);
    expect(afterChange.removed).toBe(0);
    expect(afterChange.review.recommendedActions).toHaveLength(1);
  });

  it('changes the review fingerprint when a symlink target changes without following it', async () => {
    const root = await repo();
    const link = join(root, 'src', 'linked.ts');
    await symlink('a.ts', link);
    const first = await captureReviewFileHashes(root, ['src/linked.ts']);

    await rm(link);
    await symlink('other.ts', link);
    const second = await captureReviewFileHashes(root, ['src/linked.ts']);

    expect(first['src/linked.ts']).toMatch(/^symlink:/);
    expect(second['src/linked.ts']).toMatch(/^symlink:/);
    expect(second['src/linked.ts']).not.toBe(first['src/linked.ts']);
  });

  it('ignores a corrupt structured history entry', async () => {
    const root = await repo();
    await mkdir(join(root, '.openswarm', 'review-history'), { recursive: true });
    await writeFile(join(root, '.openswarm', 'review-history', 'broken.json'), '{ nope');
    await expect(loadReviewHistory(root)).resolves.toEqual({ records: [], legacyExcerpts: [] });
  });

  it('ignores structurally invalid nested review data instead of crashing prompt rendering', async () => {
    const root = await repo();
    await mkdir(join(root, '.openswarm', 'review-history'), { recursive: true });
    await writeFile(join(root, '.openswarm', 'review-history', 'invalid.json'), JSON.stringify({
      version: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      kind: 'max',
      files: ['src/a.ts'],
      fileHashes: { 'src/a.ts': 'file:x' },
      areas: 'not-an-array',
    }));
    await expect(loadReviewHistory(root)).resolves.toEqual({ records: [], legacyExcerpts: [] });
  });

  it('does not suppress a location-less action when only part of its old scope is comparable', () => {
    const historical = {
      version: 1 as const,
      createdAt: '2026-07-21T00:00:00.000Z',
      kind: 'direct' as const,
      files: ['src/a.ts', 'src/b.ts'],
      fileHashes: { 'src/a.ts': 'file:same', 'src/b.ts': 'file:old' },
      review: {
        decision: 'revise' as const,
        feedback: '',
        recommendedActions: [{ type: 'bug', title: 'Fix shared contract' }],
      },
    };
    const result = dedupeReviewActions({
      decision: 'revise',
      feedback: '',
      recommendedActions: [{ type: 'bug', title: 'Fix shared contract' }],
    }, [historical], { 'src/a.ts': 'file:same' });
    expect(result.removed).toBe(0);
  });

  it('does not follow symlinked history files', async () => {
    const root = await repo();
    const historyRoot = join(root, '.openswarm', 'review-history');
    await mkdir(historyRoot, { recursive: true });
    const target = join(root, 'outside.json');
    await writeFile(target, JSON.stringify({
      version: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      kind: 'direct',
      files: ['src/a.ts'],
      fileHashes: { 'src/a.ts': 'file:x' },
      review: { decision: 'approve', feedback: 'secret-like external content' },
    }));
    await symlink(target, join(historyRoot, 'linked.json'));

    await expect(loadReviewHistory(root)).resolves.toEqual({ records: [], legacyExcerpts: [] });
  });

  // `kind: 'pr'` was added to the TypeScript union but not to parseRecord's
  // runtime allow-list, so every PR review record was written and then silently
  // dropped on load — the persistence it was added for never happened.
  // (INT-3914 review finding)
  it('round-trips a kind: "pr" record through save and load', async () => {
    const root = await repo();
    await saveReviewHistory(root, {
      kind: 'pr',
      base: 'mergebasesha123',
      files: ['src/a.ts'],
      review: { decision: 'approve', feedback: 'Coherent and well-tested.' },
    });

    const loaded = await loadReviewHistory(root);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].kind).toBe('pr');
    expect(loaded.records[0].review).toEqual({ decision: 'approve', feedback: 'Coherent and well-tested.' });
  });

  it('still rejects a record whose kind is not a known one', async () => {
    const root = await repo();
    const historyRoot = join(root, '.openswarm', 'review-history');
    await mkdir(historyRoot, { recursive: true });
    await writeFile(join(historyRoot, 'bogus.json'), JSON.stringify({
      version: 1,
      createdAt: '2026-08-21T00:00:00.000Z',
      kind: 'not-a-kind',
      files: ['src/a.ts'],
      fileHashes: { 'src/a.ts': 'file:x' },
    }));
    await expect(loadReviewHistory(root)).resolves.toEqual({ records: [], legacyExcerpts: [] });
  });
});
