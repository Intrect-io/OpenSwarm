import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REPO_SNAPSHOT_BYTES, hasRepoSnapshot, loadRepoSnapshot } from './graphqlExporter.js';

/**
 * `.openswarm/repo-snapshot.json` sits inside the repository a worker edits,
 * so the daemon must not let it point the read elsewhere or make it read an
 * unbounded file (AGT-3467).
 */
describe('repo snapshot read is symlink-safe and size-bounded (AGT-3467)', () => {
  let root: string;
  let project: string;
  let outside: string;

  const snapshot = { scannedAt: '2026-11-15T00:00:00.000Z', modules: [], circularDeps: [] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-snapshot-'));
    project = join(root, 'project');
    outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a plain snapshot file', () => {
    mkdirSync(join(project, '.openswarm'));
    writeFileSync(join(project, '.openswarm', 'repo-snapshot.json'), JSON.stringify(snapshot));
    expect(hasRepoSnapshot(project)).toBe(true);
    expect(loadRepoSnapshot(project)).toEqual(snapshot);
  });

  it('returns null when there is no snapshot', () => {
    expect(hasRepoSnapshot(project)).toBe(false);
    expect(loadRepoSnapshot(project)).toBeNull();
  });

  it('refuses a snapshot that is a symlink to another file', () => {
    const target = join(outside, 'secret.json');
    writeFileSync(target, JSON.stringify({ ...snapshot, leaked: true }));
    mkdirSync(join(project, '.openswarm'));
    symlinkSync(target, join(project, '.openswarm', 'repo-snapshot.json'));
    expect(hasRepoSnapshot(project)).toBe(false);
    expect(loadRepoSnapshot(project)).toBeNull();
  });

  it('refuses a .openswarm directory that is a symlink', () => {
    writeFileSync(join(outside, 'repo-snapshot.json'), JSON.stringify(snapshot));
    symlinkSync(outside, join(project, '.openswarm'));
    expect(hasRepoSnapshot(project)).toBe(false);
    expect(loadRepoSnapshot(project)).toBeNull();
  });

  it('refuses a snapshot that is a directory', () => {
    mkdirSync(join(project, '.openswarm', 'repo-snapshot.json'), { recursive: true });
    expect(hasRepoSnapshot(project)).toBe(false);
    expect(loadRepoSnapshot(project)).toBeNull();
  });

  it('refuses a snapshot larger than the cap even when it is valid JSON', () => {
    mkdirSync(join(project, '.openswarm'));
    // Valid JSON followed by whitespace, one byte past the cap: only the size
    // bound can refuse it — the parser alone would accept it.
    const body = Buffer.alloc(MAX_REPO_SNAPSHOT_BYTES + 1, 0x20);
    body.write(JSON.stringify(snapshot), 0, 'utf8');
    writeFileSync(join(project, '.openswarm', 'repo-snapshot.json'), body);
    expect(loadRepoSnapshot(project)).toBeNull();
  });

  it('reads a snapshot with trailing whitespace under the cap', () => {
    mkdirSync(join(project, '.openswarm'));
    writeFileSync(join(project, '.openswarm', 'repo-snapshot.json'), JSON.stringify(snapshot) + ' '.repeat(1024));
    expect(loadRepoSnapshot(project)).toEqual(snapshot);
  });
});
