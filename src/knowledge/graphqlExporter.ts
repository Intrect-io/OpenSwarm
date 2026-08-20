// OpenSwarm - GraphQL Schema Exporter
// KnowledgeGraph → .openswarm/repo.graphql + repo-snapshot.json
// 에이전트가 컨텍스트 윈도우 없이도 저장소를 완전히 이해할 수 있는 정적 파일 생성

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  commitCount30d: Int
  lastCommitDate: String
  state: ModuleState
  techDebt: Float
  isEntrypoint: Boolean!
  isHotspot: Boolean!
  risk: RiskLevel!
}

type Impact {
  direct: [Module!]!
  transitive: [Module!]!
  affectedTests: [Module!]!
  scope: Scope!
}

type Cycle {
  modules: [ID!]!
  length: Int!
}

type ProjectSummary {
  avgChurnScore: Float!
  hotModules: [ID!]!
  untestedModules: [ID!]!
  stableCount: Int!
  experimentalCount: Int!
  deprecatedCount: Int!
}

type LanguageBreakdown {
  language: Language!
  count: Int!
  loc: Int!
}

type LayerBreakdown {
  layer: ArchLayer!
  count: Int!
  modules: [ID!]!
}

enum NodeType { PROJECT DIRECTORY MODULE TEST_FILE }
enum Language { TYPESCRIPT PYTHON OTHER }
enum ArchLayer { CORE AGENT ADAPTER AUTOMATION SUPPORT KNOWLEDGE ORCHESTRATION LINEAR DISCORD CLI LOCALE MEMORY TEST OTHER }
enum ModuleState { STABLE EXPERIMENTAL DEPRECATED LEGACY PLANNED }
enum RiskLevel { LOW MEDIUM HIGH }
enum Scope { SMALL MEDIUM LARGE }
`;

// 아키텍처 레이어 추론
function inferLayer(modulePath: string): string {
  const segments = modulePath.split('/');
  const layerMap: Record<string, string> = {
    core: 'CORE',
    agents: 'AGENT',
    adapters: 'ADAPTER',
    automation: 'AUTOMATION',
    support: 'SUPPORT',
    knowledge: 'KNOWLEDGE',
    orchestration: 'ORCHESTRATION',
    linear: 'LINEAR',
    discord: 'DISCORD',
    cli: 'CLI',
    locale: 'LOCALE',
    memory: 'MEMORY',
    runners: 'CLI',
    taskState: 'CORE',
    __tests__: 'TEST',
  };
  for (const seg of segments) {
    if (layerMap[seg]) return layerMap[seg];
  }
  return 'OTHER';
}

// 리스크 계산
function computeRisk(node: GraphNode, hasTests: boolean, dependentCount: number): string {
  const churn = node.gitInfo?.churnScore ?? 0;
  const loc = node.metrics?.loc ?? 0;
  if ((churn > 0.5 && !hasTests) || (dependentCount >= 5 && !hasTests)) return 'HIGH';
  if (churn > 0.3 || dependentCount >= 3 || (loc > 200 && !hasTests)) return 'MEDIUM';
  return 'LOW';
}

// 순환 의존성 탐지
function detectCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const importEdges = edges.filter(e => e.type === 'imports');
  const adj = new Map<string, string[]>();
  for (const e of importEdges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const next of adj.get(node) ?? []) {
      dfs(next);
    }

    path.pop();
    stack.delete(node);
  }

  for (const node of adj.keys()) {
    dfs(node);
  }

  // 중복 사이클 제거 (정규화: 사전순 최소 시작)
  const seen = new Set<string>();
  return cycles.filter(cycle => {
    const minIdx = cycle.indexOf(cycle.slice().sort()[0]);
    const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)].join('→');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

// 진입점 탐지 (아무도 import하지 않는 모듈)
function findEntrypoints(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const imported = new Set(edges.filter(e => e.type === 'imports').map(e => e.target));
  const entrypoints = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'module' && !imported.has(node.id)) {
      entrypoints.add(node.id);
    }
  }
  return entrypoints;
}

function buildFilteredSummary(moduleNodes: GraphNode[], testEdges: GraphEdge[]): RepoSnapshot['project']['summary'] & {
  totalModules: number;
  totalTestFiles: number;
} {
  const modules = moduleNodes.filter(n => n.type === 'module');
  const testFiles = moduleNodes.filter(n => n.type === 'test_file');
  const testedModuleIds = new Set(testEdges.map(e => e.target));
  const churnScores = modules
    .map(m => m.gitInfo?.churnScore ?? 0)
    .filter(score => score > 0);
  const avgChurnScore = churnScores.length > 0
    ? churnScores.reduce((sum, score) => sum + score, 0) / churnScores.length
    : 0;

  return {
    totalModules: modules.length,
    totalTestFiles: testFiles.length,
    avgChurnScore: Math.round(avgChurnScore * 1000) / 1000,
    hotModules: modules
      .filter(m => m.gitInfo?.churnScore !== undefined)
      .sort((a, b) => (b.gitInfo?.churnScore ?? 0) - (a.gitInfo?.churnScore ?? 0))
      .slice(0, 5)
      .map(m => m.id),
    untestedModules: modules
      .filter(m => !testedModuleIds.has(m.id))
      .map(m => m.id),
    stableCount: modules.filter(m => m.metadata?.state === 'stable').length,
    experimentalCount: modules.filter(m => m.metadata?.state === 'experimental').length,
    deprecatedCount: modules.filter(m => m.metadata?.state === 'deprecated').length,
  };
}

function toGraphQLEnum(value: string | undefined): string | null {
  return value ? value.toUpperCase() : null;
}

export interface RepoSnapshot {
  schemaVersion: 1;
  projectName: string;
  projectPath: string;
  scannedAt: string;

  project: {
    totalModules: number;
    totalTests: number;
    languages: { language: string; count: number; loc: number }[];
    layers: { layer: string; count: number; modules: string[] }[];
    summary: {
      avgChurnScore: number;
      hotModules: string[];
      untestedModules: string[];
      stableCount: number;
      experimentalCount: number;
      deprecatedCount: number;
    };
  };

  modules: {
    id: string;
    path: string;
    name: string;
    type: string;
    layer: string;
    language: string;
    loc: number;
    exports: number;
    imports: number;
    dependsOn: string[];
    dependedBy: string[];
    tests: string[];
    churnScore: number | null;
    commitCount30d: number | null;
    lastCommitDate: string | null;
    state: string | null;
    techDebt: number | null;
    isEntrypoint: boolean;
    isHotspot: boolean;
    risk: string;
  }[];

  circularDeps: { modules: string[]; length: number }[];
}

export function buildSnapshot(graph: KnowledgeGraph, projectPath: string): RepoSnapshot {
  const allNodes = graph.getAllNodes();
  const allEdges = graph.getAllEdges();

  // Only include source files (src/, lib/, app/, etc.) — exclude node_modules artifacts, cache, models
  const SOURCE_PREFIXES = ['src/', 'lib/', 'app/', 'packages/', 'test/', 'tests/', 'scripts/'];
  const isSourceFile = (path: string) => SOURCE_PREFIXES.some(p => path.startsWith(p)) || !path.includes('/');
  const moduleNodes = allNodes.filter((n: GraphNode) =>
    (n.type === 'module' || n.type === 'test_file') && isSourceFile(n.path)
  );
  const moduleIds = new Set(moduleNodes.map(n => n.id));
  const importEdges = allEdges.filter((e: GraphEdge) =>
    e.type === 'imports' && moduleIds.has(e.source) && moduleIds.has(e.target)
  );
  const testEdges = allEdges.filter((e: GraphEdge) =>
    e.type === 'tests' && moduleIds.has(e.source) && moduleIds.has(e.target)
  );
  const summary = buildFilteredSummary(moduleNodes, testEdges);

  // 의존성 맵 구축
  const dependsOnMap = new Map<string, string[]>();
  const dependedByMap = new Map<string, string[]>();
  for (const e of importEdges) {
    if (!dependsOnMap.has(e.source)) dependsOnMap.set(e.source, []);
    dependsOnMap.get(e.source)!.push(e.target);
    if (!dependedByMap.has(e.target)) dependedByMap.set(e.target, []);
    dependedByMap.get(e.target)!.push(e.source);
  }

  // 테스트 맵
  const testsMap = new Map<string, string[]>();
  for (const e of testEdges) {
    if (!testsMap.has(e.target)) testsMap.set(e.target, []);
    testsMap.get(e.target)!.push(e.source);
  }

  const entrypoints = findEntrypoints(moduleNodes, importEdges);
  const hotModulesSet = new Set(summary.hotModules);
  const cycles = detectCycles(moduleNodes, importEdges);

  // 언어 통계
  const langStats = new Map<string, { count: number; loc: number }>();
  for (const n of moduleNodes as GraphNode[]) {
    const lang = (n.metrics?.language ?? 'other').toUpperCase();
    const cur = langStats.get(lang) ?? { count: 0, loc: 0 };
    cur.count++;
    cur.loc += n.metrics?.loc ?? 0;
    langStats.set(lang, cur);
  }

  // 레이어 통계
  const layerStats = new Map<string, { count: number; modules: string[] }>();
  for (const n of moduleNodes as GraphNode[]) {
    const layer = inferLayer(n.path);
    const cur = layerStats.get(layer) ?? { count: 0, modules: [] };
    cur.count++;
    cur.modules.push(n.id);
    layerStats.set(layer, cur);
  }

  const projectName = projectPath.split('/').pop() ?? 'unknown';

  return {
    schemaVersion: 1,
    projectName,
    projectPath,
    scannedAt: new Date(graph.scannedAt).toISOString(),

    project: {
      totalModules: summary.totalModules,
      totalTests: summary.totalTestFiles,
      languages: Array.from(langStats.entries()).map(([language, stats]) => ({
        language, ...stats,
      })),
      layers: Array.from(layerStats.entries()).map(([layer, stats]) => ({
        layer, count: stats.count, modules: stats.modules,
      })),
      summary: {
        avgChurnScore: summary.avgChurnScore,
        hotModules: summary.hotModules,
        untestedModules: summary.untestedModules,
        stableCount: summary.stableCount,
        experimentalCount: summary.experimentalCount,
        deprecatedCount: summary.deprecatedCount,
      },
    },

    modules: moduleNodes.map(n => {
      const deps = dependsOnMap.get(n.id) ?? [];
      const depBy = dependedByMap.get(n.id) ?? [];
      const tests = testsMap.get(n.id) ?? [];
      return {
        id: n.id,
        path: n.path,
        name: n.name,
        type: n.type.toUpperCase(),
        layer: inferLayer(n.path),
        language: (n.metrics?.language ?? 'other').toUpperCase(),
        loc: n.metrics?.loc ?? 0,
        exports: n.metrics?.exportCount ?? 0,
        imports: n.metrics?.importCount ?? 0,
        dependsOn: deps.filter(d => !d.startsWith('pkg:')),
        dependedBy: depBy,
        tests,
        churnScore: n.gitInfo?.churnScore ?? null,
        commitCount30d: n.gitInfo?.commitCount30d ?? null,
        lastCommitDate: n.gitInfo?.lastCommitDate
          ? new Date(n.gitInfo.lastCommitDate).toISOString()
          : null,
        state: toGraphQLEnum(n.metadata?.state),
        techDebt: n.metadata?.techDebt ?? null,
        isEntrypoint: entrypoints.has(n.id),
        isHotspot: hotModulesSet.has(n.id),
        risk: computeRisk(n, tests.length > 0, depBy.length),
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
  if (!existsSync(dir)) {
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
