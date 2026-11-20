import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REPO_SNAPSHOT_BYTES, exportRepoGraph, hasRepoSnapshot, loadRepoSnapshot } from './graphqlExporter.js';
import { KnowledgeGraph } from './graph.js';

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

  // The writer side of the same boundary: a rescan must heal a symlinked
  // snapshot file, and must not write through a symlinked `.openswarm/`.
  it('export replaces a symlinked snapshot file with a real one and leaves the target alone', () => {
    const target = join(outside, 'secret.json');
    writeFileSync(target, 'do not touch');
    mkdirSync(join(project, '.openswarm'));
    const path = join(project, '.openswarm', 'repo-snapshot.json');
    symlinkSync(target, path);

    exportRepoGraph(new KnowledgeGraph('p', project), project);

    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('do not touch');
    expect(hasRepoSnapshot(project)).toBe(true);
    expect(loadRepoSnapshot(project)).not.toBeNull();
  });

  it('export refuses to write through a symlinked .openswarm directory', () => {
    symlinkSync(outside, join(project, '.openswarm'));
    expect(() => exportRepoGraph(new KnowledgeGraph('p', project), project)).toThrow(/Refusing to write through/);
    expect(existsSync(join(outside, 'repo-snapshot.json'))).toBe(false);
    expect(existsSync(join(outside, 'repo.graphql'))).toBe(false);
  });

  it('export into a dangling .openswarm symlink does not create its target', () => {
    const missing = join(outside, 'missing');
    symlinkSync(missing, join(project, '.openswarm'));
    expect(() => exportRepoGraph(new KnowledgeGraph('p', project), project)).toThrow(/Refusing to write through/);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('repoSnapshotDirRefused (#883 review)', () => {
  it('is true only for a .openswarm that exists and is not a plain directory', async () => {
    const { repoSnapshotDirRefused } = await import('./graphqlExporter.js');
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'snapdir-'));
    try {
      const plain = join(root, 'plain'); mkdirSync(join(plain, '.openswarm'), { recursive: true });
      const none = join(root, 'none'); mkdirSync(none);
      const linked = join(root, 'linked'); mkdirSync(linked); symlinkSync(join(root, 'plain', '.openswarm'), join(linked, '.openswarm'));
      expect(repoSnapshotDirRefused(plain)).toBe(false);
      expect(repoSnapshotDirRefused(none)).toBe(false);
      expect(repoSnapshotDirRefused(linked)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
