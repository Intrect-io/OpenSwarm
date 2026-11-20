import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinChildDirectory, pinNestedDirectory, writeFileInPinnedDirectory } from './containedWrite.js';
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

  it('leaves a hard-linked sibling untouched', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    const target = writeFileInPinnedDirectory(dir, 'a.json', 'original');
    const sibling = join(project, '.openswarm', 'sibling.json');
    linkSync(target, sibling);
    const before = statSync(sibling);
    expect(statSync(target).ino).toBe(before.ino);

    writeFileInPinnedDirectory(dir, 'a.json', 'replaced');

    expect(readFileSync(target, 'utf8')).toBe('replaced');
    expect(readFileSync(sibling, 'utf8')).toBe('original');
    const after = statSync(sibling);
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(statSync(target).ino).not.toBe(before.ino);
  });

  it('exclusive writes refuse an existing entry and leave it alone', () => {
    const dir = pinChildDirectory(project, '.openswarm');
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, join(project, '.openswarm', 'link.txt'));
    writeFileSync(join(project, '.openswarm', 'file.txt'), 'kept');

    expect(() => writeFileInPinnedDirectory(dir, 'link.txt', 'x', { exclusive: true })).toThrow(/EEXIST/);
    expect(() => writeFileInPinnedDirectory(dir, 'file.txt', 'x', { exclusive: true })).toThrow(/EEXIST/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readFileSync(join(project, '.openswarm', 'file.txt'), 'utf8')).toBe('kept');
    expect(readdirSync(join(project, '.openswarm')).sort()).toEqual(['file.txt', 'link.txt']);

    const fresh = writeFileInPinnedDirectory(dir, 'new.txt', 'hello', { exclusive: true, mode: 0o644 });
    expect(readFileSync(fresh, 'utf8')).toBe('hello');
    expect(statSync(fresh).mode & 0o777).toBe(0o644);
  });

  it('pins a nested directory and refuses a nested symlink', () => {
    const parent = pinChildDirectory(project, '.github');
    const nested = pinNestedDirectory(parent, 'workflows');
    writeFileInPinnedDirectory(nested, 'ci.yml', 'name: CI');
    expect(readFileSync(join(project, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe('name: CI');

    symlinkSync(outside, join(project, '.github', 'evil'));
    expect(() => pinNestedDirectory(parent, 'evil')).toThrow(/not a real directory/);

    // A parent swapped for a symlink after it was pinned is detected, not followed.
    renameSync(join(project, '.github'), join(base, 'moved'));
    symlinkSync(outside, join(project, '.github'));
    expect(() => pinNestedDirectory(parent, 'other')).toThrow(/replaced after it was checked/);
    expect(readdirSync(outside)).toEqual([]);
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
