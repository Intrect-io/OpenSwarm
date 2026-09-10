import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
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
  return `${timestampSec}\0${filePath}\0`;
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
