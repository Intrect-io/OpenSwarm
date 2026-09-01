// OpenSwarm - GraphQL Schema Exporter
// KnowledgeGraph → .openswarm/repo.graphql + repo-snapshot.json
// 에이전트가 컨텍스트 윈도우 없이도 저장소를 완전히 이해할 수 있는 정적 파일 생성

import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph } from './graph.js';
import type { GraphNode, GraphEdge } from './types.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';

// GraphQL 스키마 (고정 — 데이터 구조 정의)
const REPO_SCHEMA = `# OpenSwarm Repository Graph Schema
# 에이전트가 저장소를 이해하기 위한 정적 스키마
# 데이터: repo-snapshot.json

type Query {
  project: Project!
  module(id: ID!): Module
  modules(layer: ArchLayer, language: Language): [Module!]!
  entrypoints: [Module!]!
  hotspots(limit: Int = 5): [Module!]!
  untested: [Module!]!
  circularDeps: [Cycle!]!
  impactOf(moduleId: ID!): Impact!
}

type Project {
  name: String!
  path: String!
  scannedAt: String!
  totalModules: Int!
  totalTests: Int!
  languages: [LanguageBreakdown!]!
  layers: [LayerBreakdown!]!
  summary: ProjectSummary!
}

type Module {
  id: ID!
  path: String!
  name: String!
  type: NodeType!
  layer: ArchLayer
  language: Language!
  loc: Int!
  exports: Int!
  imports: Int!
  dependsOn: [Module!]!
  dependedBy: [Module!]!
  tests: [Module!]!
  churnScore: Float
  isHotspot: Boolean!
  risk: String!
}

type LanguageBreakdown {
  language: Language!
  count: Int!
  loc: Int!
}

type LayerBreakdown {
  layer: ArchLayer!
  count: Int!
  loc: Int!
}

type ProjectSummary {
  totalModules: Int!
  totalTests: Int!
  totalLoc: Int!
  testCoverage: Float!
  hotspots: Int!
  circularDepGroups: Int!
  avgChurn: Float!
  entrypoints: Int!
}

type Impact {
  module: Module!
  transitiveCount: Int!
  testCount: Int!
  risk: String!
}

type Cycle {
  modules: [String!]!
  length: Int!
}

enum ArchLayer {
  INFRASTRUCTURE
  ADAPTER
  APPLICATION
  DOMAIN
  SUPPORT
  UNKNOWN
}

enum Language {
  TYPESCRIPT
  JAVASCRIPT
  PYTHON
  RUST
  GO
  UNKNOWN
}

enum NodeType {
  MODULE
  TEST
  CONFIG
  DATA
}
`;

// --- Helpers (pure, unit-tested) ---

/** Infer architectural layer from module path. */
export function inferLayer(modulePath: string): string {
  if (modulePath.startsWith('src/domain')) return 'DOMAIN';
  if (modulePath.startsWith('src/application') || modulePath.startsWith('src/app')) return 'APPLICATION';
  if (modulePath.startsWith('src/adapter') || modulePath.startsWith('src/adapters')) return 'ADAPTER';
  if (modulePath.startsWith('src/infra') || modulePath.startsWith('src/infrastructure')) return 'INFRASTRUCTURE';
  if (modulePath.startsWith('src/support') || modulePath.startsWith('src/tui') || modulePath.startsWith('src/cli')) return 'SUPPORT';
  return 'UNKNOWN';
}

/** Compute risk label from test coverage and dependency count. */
export function computeRisk(node: GraphNode, hasTests: boolean, dependentCount: number): string {
  if (!hasTests && dependentCount > 5) return 'HIGH';
  if (!hasTests && dependentCount > 0) return 'MEDIUM';
  if (!hasTests) return 'LOW';
  return 'NONE';
}

/** Detect cycles in the dependency graph (simple DFS). */
export function detectCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(u: string, path: string[]) {
    visited.add(u);
    stack.add(u);
    for (const v of adj.get(u) ?? []) {
      if (stack.has(v)) {
        const idx = path.indexOf(v);
        if (idx !== -1) cycles.push(path.slice(idx).concat(v));
      } else if (!visited.has(v)) {
        dfs(v, path.concat(v));
      }
    }
    stack.delete(u);
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) dfs(n.id, [n.id]);
  }
  return cycles;
}

/** Find entrypoint modules (no incoming edges). */
export function findEntrypoints(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const hasIncoming = new Set<string>();
  for (const e of edges) hasIncoming.add(e.target);
  return new Set(nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id));
}

/** Build a filtered summary from module nodes and test edges. */
export function buildFilteredSummary(moduleNodes: GraphNode[], testEdges: GraphEdge[]): RepoSnapshot['project']['summary'] {
  const testModules = new Set(testEdges.map((e) => e.source));
  const totalModules = moduleNodes.length;
  const totalTests = testModules.size;
  const totalLoc = moduleNodes.reduce((s, n) => s + n.loc, 0);
  const testCoverage = totalModules > 0 ? totalTests / totalModules : 0;
  const hotspots = moduleNodes.filter((n) => n.isHotspot).length;
  const circularDepGroups = 0; // computed separately
  const avgChurn = moduleNodes.reduce((s, n) => s + (n.churnScore ?? 0), 0) / (totalModules || 1);
  const entrypoints = moduleNodes.filter((n) => n.isEntrypoint).length;
  return { totalModules, totalTests, totalLoc, testCoverage, hotspots, circularDepGroups, avgChurn, entrypoints };
}

/** Convert a string to a GraphQL enum value (uppercase, null-safe). */
export function toGraphQLEnum(value: string | undefined): string | null {
  if (!value) return null;
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// --- Snapshot types ---

export interface RepoSnapshot {
  project: {
    name: string;
    path: string;
    scannedAt: string;
    totalModules: number;
    totalTests: number;
    languages: Array<{ language: string; count: number; loc: number }>;
    layers: Array<{ layer: string; count: number; loc: number }>;
    summary: {
      totalModules: number;
      totalTests: number;
      totalLoc: number;
      testCoverage: number;
      hotspots: number;
      circularDepGroups: number;
      avgChurn: number;
      entrypoints: number;
    };
  };
  modules: Array<{
    id: string;
    path: string;
    name: string;
    type: string;
    layer: string;
    language: string;
    loc: number;
    exports: number;
    imports: number;
    churnScore: number;
    isHotspot: boolean;
    risk: string;
  }>;
  circularDeps: Array<{ modules: string[]; length: number }>;
}

/** Build a snapshot from the current graph state. */
export function buildSnapshot(graph: KnowledgeGraph, projectPath: string): RepoSnapshot {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();
  const entrypoints = findEntrypoints(nodes, edges);
  const cycles = detectCycles(nodes, edges);

  // Language breakdown
  const langMap = new Map<string, { count: number; loc: number }>();
  for (const n of nodes) {
    const lang = n.language ?? 'UNKNOWN';
    const entry = langMap.get(lang) ?? { count: 0, loc: 0 };
    entry.count++;
    entry.loc += n.loc;
    langMap.set(lang, entry);
  }

  // Layer breakdown
  const layerMap = new Map<string, { count: number; loc: number }>();
  for (const n of nodes) {
    const layer = n.layer ?? 'UNKNOWN';
    const entry = layerMap.get(layer) ?? { count: 0, loc: 0 };
    entry.count++;
    entry.loc += n.loc;
    layerMap.set(layer, entry);
  }

  // Test edges (source → target where target is a test)
  const testEdges = edges.filter((e) => nodes.find((n) => n.id === e.target)?.type === 'test');

  // Hot modules (high churn + many dependents)
  const churnValues = nodes.map((n) => n.churnScore ?? 0).filter((c) => c > 0);
  const avgChurn = churnValues.length > 0 ? churnValues.reduce((a, b) => a + b, 0) / churnValues.length : 0;
  const hotModulesSet = new Set(
    nodes
      .filter((n) => {
        const depBy = edges.filter((e) => e.target === n.id).length;
        return (n.churnScore ?? 0) > avgChurn * 1.5 && depBy > 3;
      })
      .map((n) => n.id),
  );

  return {
    project: {
      name: projectPath.split('/').pop() ?? 'unknown',
      path: projectPath,
      scannedAt: new Date().toISOString(),
      totalModules: nodes.length,
      totalTests: nodes.filter((n) => n.type === 'test').length,
      languages: Array.from(langMap.entries()).map(([language, { count, loc }]) => ({ language, count, loc })),
      layers: Array.from(layerMap.entries()).map(([layer, { count, loc }]) => ({ layer, count, loc })),
      summary: buildFilteredSummary(nodes, testEdges),
    },
    modules: nodes.map((n) => {
      const depBy = edges.filter((e) => e.target === n.id).length;
      const tests = testEdges.filter((e) => e.source === n.id).length;
      return {
        id: n.id,
        path: n.path,
        name: n.name,
        type: n.type,
        layer: n.layer ?? 'UNKNOWN',
        language: n.language ?? 'UNKNOWN',
        loc: n.loc,
        exports: n.exports,
        imports: n.imports,
        churnScore: n.churnScore ?? 0,
        isHotspot: hotModulesSet.has(n.id),
        risk: computeRisk(n, tests > 0, depBy),
      };
    }),

    circularDeps: cycles.map(c => ({ modules: c, length: c.length })),
  };
}

// .openswarm/ 디렉토리에 스키마 + 스냅샷 저장
export function exportRepoGraph(graph: KnowledgeGraph, projectPath: string): {
  schemaPath: string;
  snapshotPath: string;
} {
  const dir = join(projectPath, '.openswarm');

  // Reject symlinked .openswarm directories to prevent redirection attacks.
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to export to symlinked directory: ${dir} -> ${join(projectPath, '.openswarm')} is a symlink. Remove the symlink or point it to a real directory.`,
      );
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  const schemaPath = join(dir, 'repo.graphql');
  const snapshotPath = join(dir, 'repo-snapshot.json');

  atomicWriteFileSync(schemaPath, REPO_SCHEMA);

  const snapshot = buildSnapshot(graph, projectPath);
  atomicWriteFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  console.log(`[Knowledge] Exported repo graph: ${schemaPath} (schema) + ${snapshotPath} (${snapshot.modules.length} modules, ${snapshot.circularDeps.length} cycles)`);

  return { schemaPath, snapshotPath };
}

// 스냅샷이 존재하는지 확인
export function hasRepoSnapshot(projectPath: string): boolean {
  return existsSync(join(projectPath, '.openswarm', 'repo-snapshot.json'));
}

// 스냅샷 로드 (에이전트가 읽을 때)
export function loadRepoSnapshot(projectPath: string): RepoSnapshot | null {
  const snapshotPath = join(projectPath, '.openswarm', 'repo-snapshot.json');
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf8')) as RepoSnapshot;
  } catch {
    return null;
  }
}

// 스냅샷 나이 확인 (분)
export function snapshotAgeMinutes(projectPath: string): number | null {
  const snapshot = loadRepoSnapshot(projectPath);
  if (!snapshot) return null;
  return (Date.now() - new Date(snapshot.scannedAt).getTime()) / 60_000;
}