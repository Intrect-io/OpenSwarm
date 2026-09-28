import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseNulDelimitedChurnOutput } from './gitInfo.js';
import { KnowledgeGraph } from './graph.js';
import type { GraphNode } from './types.js';

const saveGraphMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./store.js', () => ({
  saveGraph: saveGraphMock,
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { enrichWithGitInfo } from './gitInfo.js';

/**
 * Real `git log -z --format=%x1e%ct --name-only` output: commits are
 * NUL-separated, each commit's first filename is prefixed with the newline
 * that terminates the format, and there is NO empty token between commits.
 */
const RS = '\x1e';
const commit = (ts: number, files: string[]) => [`${RS}${ts}`, ...files.map((f) => `\n${f}`)].join('\0');

describe('parseNulDelimitedChurnOutput', () => {
  it('counts a numeric filename as a file, never as a commit boundary', () => {
    const churns = parseNulDelimitedChurnOutput(`${commit(1700000000, ['12345'])}\0`);
    expect([...churns.keys()]).toEqual(['12345']);
    expect(churns.get('12345')).toEqual({
      path: '12345',
      commitCount: 1,
      lastCommitDate: 1700000000 * 1000,
    });
  });

  it('attributes a multi-file commit to its own timestamp', () => {
    const churns = parseNulDelimitedChurnOutput(`${commit(1700000000, ['src/a.ts', 'src/b.ts'])}\0`);
    expect(churns.size).toBe(2);
    expect(churns.get('src/a.ts')?.lastCommitDate).toBe(1700000000 * 1000);
    expect(churns.get('src/b.ts')?.lastCommitDate).toBe(1700000000 * 1000);
  });

  it('keeps each commit separate — a later timestamp is not read as a filename', () => {
    // Regression: a state machine that expects an empty token between commits
    // treats 1700001000 as a path, inventing a file and dropping src/c.ts.
    const churns = parseNulDelimitedChurnOutput([
      commit(1700000000, ['src/a.ts']),
      commit(1700001000, ['src/a.ts', 'src/c.ts']),
      '',
    ].join('\0'));

    expect([...churns.keys()].sort()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(churns.get('src/a.ts')).toEqual({
      path: 'src/a.ts',
      commitCount: 2,
      lastCommitDate: 1700001000 * 1000,
    });
    expect(churns.get('src/c.ts')?.commitCount).toBe(1);
  });

  it('ignores git output with no churn (empty and whitespace-only)', () => {
    expect(parseNulDelimitedChurnOutput('').size).toBe(0);
    expect(parseNulDelimitedChurnOutput('\0\0').size).toBe(0);
  });
});

function moduleNode(id: string, path: string): GraphNode {
  return {
    id,
    type: 'module',
    name: id,
    path,
    metrics: { loc: 10, exportCount: 1, importCount: 1, language: 'typescript' },
  };
}

function mockGitLogOutput(filePath: string, timestampSec: number): string {
  // Matches `git log -z --format=%x1e%ct --name-only`, which
  // parseNulDelimitedChurnOutput consumes: each commit is RS+ts, its first
  // filename carries the format-terminating newline, and there is no empty
  // token between commits.
  return `${RS}${timestampSec}\0\n${filePath}\0`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('enrichWithGitInfo', () => {
  it('does not mutate original node objects and persists via saveGraph', async () => {
    const graph = new KnowledgeGraph('test-project', '/repo');
    const node = moduleNode('mod-a', 'src/a.ts');
    graph.addNode(node);
    const nodeRefBefore = graph.getNode('mod-a');
    expect(nodeRefBefore?.gitInfo).toBeUndefined();

    const nowSec = Math.floor(Date.now() / 1000);
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.stdout.emit('data', mockGitLogOutput('src/a.ts', nowSec));
        proc.emit('close', 0);
      });
      return proc;
    });

    await enrichWithGitInfo(graph, '/repo');

    expect(node.gitInfo).toBeUndefined();
    expect(nodeRefBefore?.gitInfo).toBeUndefined();

    const enriched = graph.getNode('mod-a');
    expect(enriched).toBeDefined();
    expect(enriched).not.toBe(node);
    expect(enriched?.metrics).not.toBe(node.metrics);
    expect(enriched?.gitInfo).toEqual({
      lastCommitDate: nowSec * 1000,
      commitCount30d: 1,
      churnScore: 1,
    });
    expect(saveGraphMock).toHaveBeenCalledWith(graph);
  });
});
