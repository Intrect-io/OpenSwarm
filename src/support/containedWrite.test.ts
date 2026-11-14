import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinChildDirectory, writeFileInPinnedDirectory } from './containedWrite.js';
import { exportRepoGraph } from '../knowledge/graphqlExporter.js';
import { KnowledgeGraph } from '../knowledge/graph.js';

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'openswarm-contained-'));
  project = join(base, 'project');
  outside = join(base, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('contained directory writes (AGT-3447)', () => {
  it('creates the directory and writes atomically inside it', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    const target = writeFileInPinnedDirectory(dir, 'a.json', '{"ok":true}');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(lstatSync(join(project, '.openswarm')).isDirectory()).toBe(true);
    // No temporary file is left behind.
    expect(readdirSync(join(project, '.openswarm'))).toEqual(['a.json']);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('refuses a .openswarm that is already a symlink out of the project', () => {
    symlinkSync(outside, join(project, '.openswarm'));
    expect(() => pinChildDirectory(project, '.openswarm')).toThrow(/not a real directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses when the directory is swapped for a symlink after it was checked', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    // The race: the checked directory is moved away and a link to another
    // tree takes its place before the write.
    renameSync(join(project, '.openswarm'), join(base, 'moved'));
    symlinkSync(outside, join(project, '.openswarm'));

    expect(() => writeFileInPinnedDirectory(dir, 'repo.graphql', 'schema')).toThrow(/replaced after it was checked/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('replaces a symlink at the target name instead of writing through it', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, join(project, '.openswarm', 'repo.graphql'));

    writeFileInPinnedDirectory(dir, 'repo.graphql', 'schema');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(join(project, '.openswarm', 'repo.graphql')).isFile()).toBe(true);
  });

  it('keeps the mode of an existing file', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    const target = writeFileInPinnedDirectory(dir, 'a.json', 'one');
    chmodSync(target, 0o644);
    writeFileInPinnedDirectory(dir, 'a.json', 'two');
    expect(readFileSync(target, 'utf8')).toBe('two');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('rejects names that are not a single path component', () => {
    expect(() => pinChildDirectory(project, '../escape')).toThrow(/Invalid directory name/);
    const dir = pinChildDirectory(project, '.openswarm');
    expect(() => writeFileInPinnedDirectory(dir, '../x', 'x')).toThrow(/Invalid file name/);
  });

  it('exportRepoGraph refuses a symlinked .openswarm and writes nothing outside', () => {
    symlinkSync(outside, join(project, '.openswarm'));
    const graph = new KnowledgeGraph('project', project);
    expect(() => exportRepoGraph(graph, project)).toThrow(/not a real directory/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, 'repo-snapshot.json'))).toBe(false);
  });
});
