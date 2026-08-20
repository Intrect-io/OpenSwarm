// ============================================
// OpenSwarm - repository-local review history
// ============================================

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewResult } from '../agents/agentPair.js';

const HISTORY_VERSION = 1;
const HISTORY_DIR = join('.openswarm', 'review-history');
const MAX_RECORDS = 12;
const MAX_LEGACY_REPORTS = 2;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_HISTORY_FILE_BYTES = 1_000_000;

export interface ReviewHistoryArea {
  label: string;
  files: string[];
  review?: ReviewResult;
  error?: string;
}

export interface ReviewHistoryRecord {
  version: typeof HISTORY_VERSION;
  createdAt: string;
  kind: 'direct' | 'max';
  base?: string;
  files: string[];
  fileHashes: Record<string, string>;
  review?: ReviewResult;
  areas?: ReviewHistoryArea[];
}

export interface LoadedReviewHistory {
  records: ReviewHistoryRecord[];
  legacyExcerpts: string[];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function hashReviewFile(projectPath: string, relativePath: string): Promise<string> {
  const path = join(projectPath, relativePath);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return `type:${info.mode}`;
      return `file:${createHash('sha256').update(await handle.readFile()).digest('hex')}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    // `O_NOFOLLOW` rejects a symlink before opening its target. Hash its link
    // text rather than following it, so a retargeted symlink is visible to
    // review-history dedupe without allowing a repository-controlled link to
    // read outside the repository.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      const target = await readlink(path);
      return `symlink:${createHash('sha256').update(target).digest('hex')}`;
    }
    throw error;
  }
}

export async function captureReviewFileHashes(
  projectPath: string,
  files: Iterable<string>,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of [...new Set([...files].map(normalizePath))].sort()) {
    hashes[file] = await hashReviewFile(projectPath, file);
  }
  return hashes;
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (!value || typeof value !== 'object') return false;
  const review = value as Partial<ReviewResult>;
  const stringArray = (items: unknown): boolean => items === undefined
    || (Array.isArray(items) && items.every((item) => typeof item === 'string'));
  const actions = review.recommendedActions;
  return (review.decision === 'approve' || review.decision === 'revise' || review.decision === 'reject')
    && typeof review.feedback === 'string'
    && stringArray(review.issues)
    && stringArray(review.suggestions)
    && (actions === undefined || (Array.isArray(actions) && actions.every((action) =>
      Boolean(action)
      && typeof action === 'object'
      && typeof action.type === 'string'
      && typeof action.title === 'string'
      && (action.location === undefined || typeof action.location === 'string'))));
}

function isHistoryArea(value: unknown): value is ReviewHistoryArea {
  if (!value || typeof value !== 'object') return false;
  const area = value as Partial<ReviewHistoryArea>;
  return typeof area.label === 'string'
    && Array.isArray(area.files)
    && area.files.every((file) => typeof file === 'string')
    && (area.review === undefined || isReviewResult(area.review))
    && (area.error === undefined || typeof area.error === 'string');
}

function parseRecord(value: unknown): ReviewHistoryRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<ReviewHistoryRecord>;
  if (record.version !== HISTORY_VERSION || (record.kind !== 'direct' && record.kind !== 'max')) return undefined;
  if (typeof record.createdAt !== 'string' || !Array.isArray(record.files) || !record.fileHashes) return undefined;
  if (!record.files.every((file) => typeof file === 'string')) return undefined;
  if (typeof record.fileHashes !== 'object'
    || !Object.entries(record.fileHashes).every(([path, hash]) => path.length > 0 && typeof hash === 'string')) return undefined;
  if (record.base !== undefined && typeof record.base !== 'string') return undefined;
  if (record.review && !isReviewResult(record.review)) return undefined;
  if (record.areas !== undefined && (!Array.isArray(record.areas) || !record.areas.every(isHistoryArea))) return undefined;
  return record as ReviewHistoryRecord;
}

function legacyReportExcerpt(markdown: string): string {
  const starts = [markdown.indexOf('## Recommended follow-ups'), markdown.indexOf('## Issues')]
    .filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : 0;
  return markdown.slice(start, start + 4_000).trim();
}

async function readRegularHistoryFile(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    // Never follow repository-controlled symlinks into files outside the repo,
    // and cap reads before parsing so a bogus log cannot exhaust the CLI.
    if (!info.isFile() || info.size > MAX_HISTORY_FILE_BYTES) return undefined;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Load structured history plus compact excerpts from older `review --max` reports. */
export async function loadReviewHistory(projectPath: string): Promise<LoadedReviewHistory> {
  const historyRoot = join(projectPath, HISTORY_DIR);
  const auditRoot = join(projectPath, '.openswarm', 'audit');
  const records: ReviewHistoryRecord[] = [];
  try {
    const names = (await readdir(historyRoot))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, MAX_RECORDS);
    for (const name of names) {
      try {
        const content = await readRegularHistoryFile(join(historyRoot, name));
        const parsed = content === undefined ? undefined : parseRecord(JSON.parse(content));
        if (parsed) records.push(parsed);
      } catch {
        // One truncated/corrupt history entry must not block a review.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const legacyExcerpts: string[] = [];
  try {
    const names = (await readdir(auditRoot))
      .filter((name) => /^audit-.*\.md$/.test(name))
      .sort()
      .reverse()
      .slice(0, MAX_LEGACY_REPORTS);
    for (const name of names) {
      const content = await readRegularHistoryFile(join(auditRoot, name));
      if (content === undefined) continue;
      const excerpt = legacyReportExcerpt(content);
      if (excerpt) legacyExcerpts.push(`${name}\n${excerpt}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { records, legacyExcerpts };
}

function filesOverlap(left: Iterable<string>, right: Set<string>): boolean {
  return [...left].some((file) => right.has(normalizePath(file)));
}

function renderResult(result: ReviewResult): string[] {
  const lines = [`decision=${result.decision}`];
  for (const issue of (result.issues ?? []).slice(0, 8)) lines.push(`issue: ${issue}`);
  for (const action of (result.recommendedActions ?? []).slice(0, 8)) {
    lines.push(`follow-up: [${action.type}] ${action.title}${action.location ? ` (${action.location})` : ''}`);
  }
  return lines;
}

/** Render only history relevant to the current file scope, capped for prompt safety. */
export function renderReviewHistoryContext(
  loaded: LoadedReviewHistory,
  files: Iterable<string>,
  currentHashes: Record<string, string>,
): { context?: string; matchingRecords: ReviewHistoryRecord[] } {
  const scope = new Set([...files].map(normalizePath));
  const matchingRecords = loaded.records.filter((record) => filesOverlap(record.files, scope));
  const lines: string[] = [];
  for (const record of matchingRecords) {
    const overlapping = record.files.filter((file) => scope.has(normalizePath(file)));
    const unchanged = overlapping.filter((file) => record.fileHashes[file] === currentHashes[file]).length;
    lines.push(`[${record.createdAt}] ${record.kind} (${unchanged}/${overlapping.length} overlapping files unchanged)`);
    if (record.review) lines.push(...renderResult(record.review));
    for (const area of record.areas ?? []) {
      if (!filesOverlap(area.files, scope)) continue;
      lines.push(`area: ${area.label}${area.error ? ` error=${area.error}` : ''}`);
      if (area.review) lines.push(...renderResult(area.review));
    }
  }
  if (loaded.legacyExcerpts.length > 0) {
    lines.push('Legacy review --max report excerpts (no file hashes; verify before relying on them):');
    lines.push(...loaded.legacyExcerpts);
  }
  const context = lines.join('\n').slice(0, MAX_CONTEXT_CHARS).trim();
  return { context: context || undefined, matchingRecords };
}

function normalizeFinding(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function locationFile(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const withoutArea = location.includes(': ') ? location.slice(location.lastIndexOf(': ') + 2) : location;
  return normalizePath(withoutArea.replace(/:\d+(?::\d+)?$/, '').replace(/^`|`$/g, ''));
}

function recordUnchangedAt(
  record: ReviewHistoryRecord,
  location: string | undefined,
  currentHashes: Record<string, string>,
): boolean {
  const file = locationFile(location);
  if (file && record.fileHashes[file] !== undefined) return record.fileHashes[file] === currentHashes[file];
  return record.files.length > 0
    && record.files.every((path) => currentHashes[path] !== undefined && record.fileHashes[path] === currentHashes[path]);
}

function historicalResults(record: ReviewHistoryRecord): ReviewResult[] {
  return [record.review, ...(record.areas ?? []).map((area) => area.review)]
    .filter((review): review is ReviewResult => Boolean(review));
}

/**
 * Drop follow-ups already emitted for byte-identical code. Blocking issues stay
 * visible; this only prevents duplicate tracking tickets/recommended actions.
 */
export function dedupeReviewActions(
  review: ReviewResult,
  records: ReviewHistoryRecord[],
  currentHashes: Record<string, string>,
): { review: ReviewResult; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const recommendedActions = (review.recommendedActions ?? []).filter((action) => {
    const key = `${action.type}|${normalizeFinding(action.title)}|${normalizeFinding(locationFile(action.location) ?? '')}`;
    if (seen.has(key)) {
      removed++;
      return false;
    }
    seen.add(key);
    const repeated = records.some((record) => recordUnchangedAt(record, action.location, currentHashes)
      && historicalResults(record).some((historical) => (historical.recommendedActions ?? []).some((old) =>
        `${old.type}|${normalizeFinding(old.title)}|${normalizeFinding(locationFile(old.location) ?? '')}` === key)));
    if (repeated) removed++;
    return !repeated;
  });
  return { review: { ...review, recommendedActions }, removed };
}

export async function saveReviewHistory(
  projectPath: string,
  input: Omit<ReviewHistoryRecord, 'version' | 'createdAt' | 'fileHashes'> & {
    createdAt?: string;
    /** Alternate checkout whose file contents were actually reviewed. */
    hashProjectPath?: string;
  },
): Promise<string> {
  const root = join(projectPath, HISTORY_DIR);
  await mkdir(root, { recursive: true });
  const { createdAt = new Date().toISOString(), hashProjectPath = projectPath, ...persisted } = input;
  const record: ReviewHistoryRecord = {
    ...persisted,
    version: HISTORY_VERSION,
    createdAt,
    files: [...new Set(input.files.map(normalizePath))].sort(),
    fileHashes: await captureReviewFileHashes(hashProjectPath, input.files),
  };
  const stem = `${createdAt.replace(/[^A-Za-z0-9_-]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const target = join(root, `${stem}.json`);
  const temporary = join(root, `.${stem}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}
