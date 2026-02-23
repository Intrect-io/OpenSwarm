// ============================================
// OpenSwarm - Knowledge Graph Public API
// 싱글턴 캐시 + 스캔 쓰로틀
// ============================================

import { KnowledgeGraph } from './graph.js';
import { scanProject, incrementalUpdate } from './scanner.js';
import { saveGraph, loadGraph, listGraphs } from './store.js';
import { enrichWithGitInfo, getRecentlyChangedFiles } from './gitInfo.js';
import { analyzeIssueImpact, getProjectHealth, suggestReviewFocus, getModuleHealth } from './analyzer.js';
import type { ImpactAnalysis, ProjectSummary } from './types.js';
import { saveCognitiveMemory } from '../memory/index.js';

// Re-exports
export { KnowledgeGraph } from './graph.js';
export { scanProject, incrementalUpdate } from './scanner.js';
export { saveGraph, loadGraph, listGraphs, deleteGraph, loadGraphSummary } from './store.js';
export { enrichWithGitInfo, getRecentlyChangedFiles } from './gitInfo.js';
export { analyzeIssueImpact, getProjectHealth, suggestReviewFocus, getModuleHealth } from './analyzer.js';
export type { ModuleHealth, ReviewFocus } from './analyzer.js';
export type { ImpactAnalysis, ProjectSummary } from './types.js';
export type * from './types.js';

// ============================================
// Singleton Cache
// ============================================

const graphCache = new Map<string, {
  graph: KnowledgeGraph;
  loadedAt: number;
}>();

// 스캔 쓰로틀: 프로젝트당 최소 30분 간격
const FULL_SCAN_THROTTLE_MS = 30 * 60 * 1000;
const lastFullScan = new Map<string, number>();

/**
 * 프로젝트 슬러그 생성 (경로 → 식별자)
 */
export function toProjectSlug(projectPath: string): string {
  return projectPath
    .replace(/^~/, '')
    .replace(process.env.HOME || '', '')
    .replace(/^\/+/, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .toLowerCase();
}

/**
 * 캐시된 그래프 가져오기 (없으면 디스크에서 로드)
 */
export async function getGraph(projectSlug: string): Promise<KnowledgeGraph | null> {
  const cached = graphCache.get(projectSlug);
  if (cached) return cached.graph;

  const graph = await loadGraph(projectSlug);
  if (graph) {
    graphCache.set(projectSlug, { graph, loadedAt: Date.now() });
  }
  return graph;
}

/**
 * 프로젝트 전체 스캔 (쓰로틀 적용)
 *
 * @returns 스캔된 그래프 또는 쓰로틀된 경우 캐시된 그래프
 */
export async function scanAndCache(
  projectPath: string,
  options: { force?: boolean } = {},
): Promise<KnowledgeGraph> {
  const slug = toProjectSlug(projectPath);

  // 쓰로틀 체크
  if (!options.force) {
    const lastScan = lastFullScan.get(slug) ?? 0;
    if (Date.now() - lastScan < FULL_SCAN_THROTTLE_MS) {
      const cached = await getGraph(slug);
      if (cached) {
        console.log(`[Knowledge] Throttled: ${slug} (last scan ${Math.round((Date.now() - lastScan) / 1000)}s ago)`);
        return cached;
      }
    }
  }

  console.log(`[Knowledge] Full scan starting: ${slug} → ${projectPath}`);
  const startMs = Date.now();

  try {
    const graph = await scanProject(projectPath, slug);

    // Git 정보 추가
    await enrichWithGitInfo(graph, projectPath);

    // 저장
    await saveGraph(graph);

    // 캐시
    graphCache.set(slug, { graph, loadedAt: Date.now() });
    lastFullScan.set(slug, Date.now());

    const elapsed = Date.now() - startMs;
    console.log(`[Knowledge] Scan complete: ${slug} (${graph.nodeCount} nodes, ${graph.edgeCount} edges, ${elapsed}ms)`);

    // 인사이트를 인지 메모리로 저장 (비동기, 실패해도 무시)
    saveGraphInsights(projectPath).catch((e) => console.warn(`[Knowledge] Failed to save graph insights for ${slug}:`, e));

    return graph;
  } catch (err) {
    console.error(`[Knowledge] Scan failed: ${slug}`, err);
    // 실패 시 캐시된 그래프 반환 시도
    const cached = await getGraph(slug);
    if (cached) return cached;
    throw err;
  }
}

/**
 * 증분 업데이트 (heartbeat에서 호출)
 * 마지막 스캔 이후 변경된 파일만 재스캔
 */
export async function refreshGraph(projectPath: string): Promise<KnowledgeGraph | null> {
  const slug = toProjectSlug(projectPath);
  const cached = await getGraph(slug);

  if (!cached) {
    // 기존 그래프 없으면 전체 스캔
    return scanAndCache(projectPath);
  }

  try {
    // 마지막 스캔 이후 변경된 파일 조회
    const changedFiles = await getRecentlyChangedFiles(projectPath, cached.scannedAt);

    if (changedFiles.length === 0) {
      return cached;
    }

    console.log(`[Knowledge] Incremental update: ${slug} (${changedFiles.length} files changed)`);
    await incrementalUpdate(cached, projectPath, changedFiles);
    await enrichWithGitInfo(cached, projectPath);
    await saveGraph(cached);

    return cached;
  } catch (err) {
    console.warn(`[Knowledge] Incremental update failed: ${slug}`, err);
    return cached;
  }
}

/**
 * 이슈 기반 영향 분석 (convenience wrapper)
 */
export async function analyzeIssue(
  projectPath: string,
  issueTitle: string,
  issueDescription?: string,
): Promise<ImpactAnalysis | null> {
  const slug = toProjectSlug(projectPath);
  const graph = await getGraph(slug);
  if (!graph) return null;

  return analyzeIssueImpact(graph, issueTitle, issueDescription);
}

/**
 * 캐시 무효화
 */
export function invalidateCache(projectSlug?: string): void {
  if (projectSlug) {
    graphCache.delete(projectSlug);
    lastFullScan.delete(projectSlug);
  } else {
    graphCache.clear();
    lastFullScan.clear();
  }
}

/**
 * 그래프 인사이트를 인지 메모리(system_pattern)로 저장
 * 스캔 결과에서 주목할 패턴을 추출하여 LanceDB에 기록
 */
export async function saveGraphInsights(projectPath: string): Promise<void> {
  const slug = toProjectSlug(projectPath);
  const graph = await getGraph(slug);
  if (!graph) return;

  const { summary, riskModules } = getProjectHealth(graph);

  // Hot modules 인사이트
  if (summary.hotModules.length > 0) {
    const hotList = summary.hotModules.slice(0, 3).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] 최근 빈번하게 변경되는 모듈: ${hotList}. 변경 영향도 주의 필요.`,
        { confidence: 0.8, importance: 0.6, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }

  // 고위험 모듈 인사이트
  const highRisk = riskModules.filter(m => m.risk === 'high');
  if (highRisk.length > 0) {
    const riskList = highRisk.slice(0, 3).map(m => m.moduleId).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] 고위험 모듈 (테스트 부재 + 높은 변경 빈도): ${riskList}. 테스트 추가 권장.`,
        { confidence: 0.85, importance: 0.7, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }

  // 테스트 커버리지 인사이트
  if (summary.untestedModules.length > 0 && summary.totalModules > 0) {
    const coverage = Math.round((1 - summary.untestedModules.length / summary.totalModules) * 100);
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] 테스트 커버리지: ${coverage}% (${summary.totalTestFiles}개 테스트 / ${summary.totalModules}개 모듈). 미테스트 ${summary.untestedModules.length}개.`,
        { confidence: 0.9, importance: 0.5, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }
}

/**
 * 모든 캐시된 그래프의 요약 정보
 */
export function getCachedGraphsSummary(): Array<{
  slug: string;
  nodeCount: number;
  edgeCount: number;
  scannedAt: number;
  summary: ProjectSummary;
}> {
  const result = [];
  for (const [slug, { graph }] of graphCache) {
    result.push({
      slug,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      scannedAt: graph.scannedAt,
      summary: graph.buildSummary(),
    });
  }
  return result;
}
