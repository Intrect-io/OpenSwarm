import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeGraph, GraphNode, GraphEdge } from './graph.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { REPO_SCHEMA } from './repoSchema.js';

// ============================================
// OpenSwarm - GraphQL Schema & Snapshot Export
// ============================================

// --- Helpers ---

function inferLayer(modulePath: string): string {
  if (modulePath.startsWith('src/')) return 'source';
  if (modulePath.startsWith('benchmarks/')) return 'benchmark';
  if (modulePath.startsWith('workers/')) return 'worker';
  if (modulePath.startsWith('docs/')) return 'documentation';
  if (modulePath.startsWith('scripts/')) return 'script';
  if (modulePath.startsWith('config/')) return 'config';
  return 'other';
}

function computeRisk(node: GraphNode, hasTests: boolean, dependentCount: number): string {
  if (!hasTests && dependentCount > 5) return 'high';
  if (!hasTests && dependentCount > 2) return 'medium';
  return 'low';
}

function detectCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) cycles.push(path.slice(cycleStart));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor, path);
    }
    path.pop();
    stack.delete(node);
  }

  for (const node of nodes) dfs(node.id, []);
  return cycles;
}

function findEntrypoints(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const hasIncoming = new Set<string>();
  for (const edge of edges) hasIncoming.add(edge.target);
  const entrypoints = new Set<string>();
  for (const node of nodes) {
    if (!hasIncoming.has(node.id)) entrypoints.add(node.id);
  }
  return entrypoints;
}

function buildFilteredSummary(
  moduleNodes: GraphNode[],
  testEdges: GraphEdge[],
): RepoSnapshot['project']['summary'] {
  const total = moduleNodes.length;
  const tested = new Set(testEdges.map(e => e.source));
  const untested = moduleNodes.filter(n => !tested.has(n.id));
  const highRisk = moduleNodes.filter(n => computeRisk(n, tested.has(n.id), 0) === 'high');
  return {
    totalEntities: total,
    untestedEntities: untested.length,
    highRiskEntities: highRisk.length,
  };
}

function toGraphQLEnum(value: string | undefined): string | null {
  if (!value) return null;
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// --- Types ---

export interface RepoSnapshot {
  project: {
    name: string;
    summary: {
      totalEntities: number;
      untestedEntities: number;
      highRiskEntities: number;
    };
  };
  nodes: Array<{
    id: string;
    label: string;
    layer: string;
    risk: string;
    hasTests: boolean;
    dependentCount: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
  }>;
  cycles: Array<{
    modules: string[];
    length: number;
  }>;
  entrypoints: string[];
}

// --- Build snapshot ---

export function buildSnapshot(graph: KnowledgeGraph, projectPath: string): RepoSnapshot {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();

  const testEdges = edges.filter(e => e.label === 'test');
  const moduleNodes = nodes.filter(n => n.layer !== 'test');
  const testedModules = new Set(testEdges.map(e => e.source));
  const dependentCount = new Map<string, number>();
  for (const edge of edges) {
    if (edge.label === 'import') {
      dependentCount.set(edge.target, (dependentCount.get(edge.target) ?? 0) + 1);
    }
  }

  const cycles = detectCycles(moduleNodes, edges);
  const entrypoints = findEntrypoints(moduleNodes, edges);

  return {
    project: {
      name: projectPath.split('/').pop() ?? 'unknown',
      summary: buildFilteredSummary(moduleNodes, testEdges),
    },
    nodes: moduleNodes.map(n => ({
      id: n.id,
      label: n.label,
      layer: inferLayer(n.id),
      risk: computeRisk(n, testedModules.has(n.id), dependentCount.get(n.id) ?? 0),
      hasTests: testedModules.has(n.id),
      dependentCount: dependentCount.get(n.id) ?? 0,
    })),
    edges: edges.map(e => ({
      source: e.source,
      target: e.target,
      label: e.label,
    })),
    cycles: cycles.map(c => ({ modules: c, length: c.length })),
    entrypoints: [...entrypoints],
  };
}

function assertSafeOpenswarmDir(projectPath: string, dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new Error(`[security] refusing to export: .openswarm is missing after mkdir`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`[security] refusing to export: .openswarm is not a real directory`);
  }
  const expected = join(realpathSync(projectPath), '.openswarm');
  const actual = realpathSync(dir);
  if (actual !== expected) {
    throw new Error(`[security] refusing to export: .openswarm path escapes project (${actual} !== ${expected})`);
  }
}

// .openswarm/ 디렉토리에 스키마 + 스냅샷 저장
export function exportRepoGraph(graph: KnowledgeGraph, projectPath: string): {
  schemaPath: string;
  snapshotPath: string;
} {
  // Resolve projectPath before constructing dir so a symlink replacement race
  // between the join and mkdirSync cannot redirect the export outside the project.
  const resolvedProject = realpathSync(projectPath);
  const dir = join(resolvedProject, '.openswarm');
  mkdirSync(dir, { recursive: true });
  assertSafeOpenswarmDir(resolvedProject, dir);

  const schemaPath = join(dir, 'repo.graphql');
  const snapshotPath = join(dir, 'repo-snapshot.json');

  // Re-validate immediately before writes to resist symlink replacement races.
  assertSafeOpenswarmDir(resolvedProject, dir);

  atomicWriteFileSync(schemaPath, REPO_SCHEMA);

  const snapshot = buildSnapshot(graph, projectPath);
  atomicWriteFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  return { schemaPath, snapshotPath };
}

export function hasRepoSnapshot(projectPath: string): boolean {
  const dir = join(projectPath, '.openswarm');
  const snapshotPath = join(dir, 'repo-snapshot.json');
  try {
    lstatSync(snapshotPath);
    return true;
  } catch {
    return false;
  }
}

export function loadRepoSnapshot(projectPath: string): RepoSnapshot | null {
  const dir = join(projectPath, '.openswarm');
  const snapshotPath = join(dir, 'repo-snapshot.json');
  try {
    const raw = atomicReadFileSync(snapshotPath, 'utf8');
    return JSON.parse(raw) as RepoSnapshot;
  } catch {
    return null;
  }
}

export function snapshotAgeMinutes(projectPath: string): number | null {
  const dir = join(projectPath, '.openswarm');
  const snapshotPath = join(dir, 'repo-snapshot.json');
  try {
    const st = lstatSync(snapshotPath);
    return (Date.now() - st.mtimeMs) / 60_000;
  } catch {
    return null;
  }
}

// atomicReadFileSync is used by loadRepoSnapshot but not exported from atomicFile.ts
import { readFileSync } from 'node:fs';
function atomicReadFileSync(path: string, encoding: BufferEncoding): string {
  return readFileSync(path, encoding);
}