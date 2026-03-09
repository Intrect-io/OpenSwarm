// ============================================
// OpenSwarm - Knowledge Graph Public API
// Singleton cache + scan throttle
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

// Risk-On analysis exports
export type { RiskOnAnalysis, RiskOnAnalyzerConfig, MarketSentiment } from './riskOnAnalyzer.js';
export { RiskOnAnalyzer, initRiskOnAnalyzer, getRiskOnAnalyzer } from './riskOnAnalyzer.js';

// CryptoQuant re-export (used by Risk-On)
export type { RiskOnSignal } from '../adapters/cryptoQuantAdapter.js';

// Repository knowledge management
export {
  linkIssueToModule,
  unlinkIssueFromModule,
  getModulesByIssue,
  getIssuesByModule,
  updateModuleState,
  updateDevelopmentStage,
  updateTechDebt,
  updateModuleMetadata,
  getModulesByState,
  getModulesByStage,
  getHighTechDebtModules,
  getBlockedModules,
  getUntestedModules,
  generateProjectSummary,
  saveGraphWithSummary,
} from './repository.js';

// ============================================
// Singleton Cache
// ============================================

const graphCache = new Map<string, {
  graph: KnowledgeGraph;
  loadedAt: number;
}>();

// Scan throttle: minimum 30 minutes between scans per project
const FULL_SCAN_THROTTLE_MS = 30 * 60 * 1000;
const lastFullScan = new Map<string, number>();

/**
 * Generate project slug (path → identifier)
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
 * Get cached graph (load from disk if not cached)
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
 * Full project scan (with throttle)
 *
 * @returns Scanned graph, or cached graph if throttled
 */
export async function scanAndCache(
  projectPath: string,
  options: { force?: boolean } = {},
): Promise<KnowledgeGraph> {
  const slug = toProjectSlug(projectPath);

  // Throttle check
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

    // Add git info
    await enrichWithGitInfo(graph, projectPath);

    // Save
    await saveGraph(graph);

    // Cache
    graphCache.set(slug, { graph, loadedAt: Date.now() });
    lastFullScan.set(slug, Date.now());

    const elapsed = Date.now() - startMs;
    console.log(`[Knowledge] Scan complete: ${slug} (${graph.nodeCount} nodes, ${graph.edgeCount} edges, ${elapsed}ms)`);

    // Save insights to cognitive memory (async, ignore failures)
    saveGraphInsights(projectPath).catch((e) => console.warn(`[Knowledge] Failed to save graph insights for ${slug}:`, e));

    return graph;
  } catch (err) {
    console.error(`[Knowledge] Scan failed: ${slug}`, err);
    // On failure, try returning cached graph
    const cached = await getGraph(slug);
    if (cached) return cached;
    throw err;
  }
}

/**
 * Incremental update (called from heartbeat)
 * Re-scan only files changed since last scan
 */
export async function refreshGraph(projectPath: string): Promise<KnowledgeGraph | null> {
  const slug = toProjectSlug(projectPath);
  const cached = await getGraph(slug);

  if (!cached) {
    // No existing graph, do full scan
    return scanAndCache(projectPath);
  }

  try {
    // Find files changed since last scan
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
 * Issue-based impact analysis (convenience wrapper)
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
 * Invalidate cache
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
 * Save graph insights to cognitive memory (system_pattern)
 * Extract notable patterns from scan results and record in LanceDB
 */
export async function saveGraphInsights(projectPath: string): Promise<void> {
  const slug = toProjectSlug(projectPath);
  const graph = await getGraph(slug);
  if (!graph) return;

  const { summary, riskModules } = getProjectHealth(graph);

  // Hot modules insight
  if (summary.hotModules.length > 0) {
    const hotList = summary.hotModules.slice(0, 3).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] Frequently changed modules: ${hotList}. Watch for change impact.`,
        { confidence: 0.8, importance: 0.6, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }

  // High risk modules insight
  const highRisk = riskModules.filter(m => m.risk === 'high');
  if (highRisk.length > 0) {
    const riskList = highRisk.slice(0, 3).map(m => m.moduleId).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] High-risk modules (no tests + high churn): ${riskList}. Adding tests recommended.`,
        { confidence: 0.85, importance: 0.7, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }

  // Test coverage insight
  if (summary.untestedModules.length > 0 && summary.totalModules > 0) {
    const coverage = Math.round((1 - summary.untestedModules.length / summary.totalModules) * 100);
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] Test coverage: ${coverage}% (${summary.totalTestFiles} tests / ${summary.totalModules} modules). ${summary.untestedModules.length} untested.`,
        { confidence: 0.9, importance: 0.5, derivedFrom: `knowledge-graph:${slug}` }
      );
    } catch {}
  }
}

/**
 * Summary info for all cached graphs
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
