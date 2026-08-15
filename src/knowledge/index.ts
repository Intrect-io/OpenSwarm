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
import { saveCognitiveMemory, deleteMemoriesByDerivedFrom } from '../memory/index.js';
import { repoKey } from '../memory/repoKnowledge.js';
import { safeConsole } from '../support/safeLog.js';
import { exportRepoGraph, hasRepoSnapshot, loadRepoSnapshot, snapshotAgeMinutes } from './graphqlExporter.js';

// Re-exports
export { KnowledgeGraph } from './graph.js';
export { scanProject, incrementalUpdate } from './scanner.js';
export { saveGraph, loadGraph, listGraphs, deleteGraph, loadGraphSummary } from './store.js';
export { enrichWithGitInfo, getRecentlyChangedFiles } from './gitInfo.js';
export { analyzeIssueImpact, getProjectHealth, suggestReviewFocus, getModuleHealth } from './analyzer.js';
export type { ModuleHealth, ReviewFocus } from './analyzer.js';
export type { ImpactAnalysis, ProjectSummary } from './types.js';
export type * from './types.js';

// GraphQL exporter
export { exportRepoGraph, hasRepoSnapshot, loadRepoSnapshot, snapshotAgeMinutes } from './graphqlExporter.js';
export type { RepoSnapshot } from './graphqlExporter.js';

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
import { createHash } from 'node:crypto';
import { basename, resolve as resolvePath } from 'node:path';
import { realpathSync } from 'node:fs';

// Singleton Cache

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
  const expanded = projectPath.startsWith('~/')
    ? resolvePath(process.env.HOME || '', projectPath.slice(2))
    : resolvePath(projectPath);
  let canonical = expanded;
  try { canonical = realpathSync(expanded); } catch { /* path may not exist yet */ }
  const label = basename(canonical).replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase() || 'project';
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${label}-${digest}`;
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
        safeConsole.log(`[Knowledge] Throttled: ${slug} (last scan ${Math.round((Date.now() - lastScan) / 1000)}s ago)`);
        return cached;
      }
    }
  }

  safeConsole.log(`[Knowledge] Full scan starting: ${slug} → ${projectPath}`);
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
    safeConsole.log(`[Knowledge] Scan complete: ${slug} (${graph.nodeCount} nodes, ${graph.edgeCount} edges, ${elapsed}ms)`);

    // Export GraphQL schema + snapshot for agent consumption
    try {
      exportRepoGraph(graph, projectPath);
    } catch (e) {
      safeConsole.warn('[Knowledge] GraphQL export failed for %s:', slug, e);
    }

    // Save insights to cognitive memory (async, ignore failures)
    saveGraphInsights(projectPath).catch((e) => safeConsole.warn('[Knowledge] Failed to save graph insights for %s:', slug, e));

    return graph;
  } catch (err) {
    safeConsole.error('[Knowledge] Scan failed: %s', slug, err);
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

    safeConsole.log(`[Knowledge] Incremental update: ${slug} (${changedFiles.length} files changed)`);
    await incrementalUpdate(cached, projectPath, changedFiles);
    await enrichWithGitInfo(cached, projectPath);
    await saveGraph(cached);

    // Re-export snapshot with updated data
    try {
      exportRepoGraph(cached, projectPath);
    } catch (e) {
      safeConsole.warn('[Knowledge] GraphQL export failed for %s:', slug, e);
    }

    return cached;
  } catch (err) {
    safeConsole.warn('[Knowledge] Incremental update failed: %s', slug, err);
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

  // Scope insights to the canonical repo (not the default 'cognitive' bucket) and
  // tag them with a stable per-repo key so each scan REFRESHES them in place
  // instead of appending duplicates every run. (INT-1857)
  const repo = repoKey(projectPath);
  const insightKey = `knowledge-graph:${repo}`;
  await deleteMemoriesByDerivedFrom(insightKey).catch((err) =>
    safeConsole.warn('[Knowledge] insight refresh delete failed:', err instanceof Error ? err.message : err));
  const insightOpts = (importance: number, confidence: number) =>
    ({ confidence, importance, derivedFrom: insightKey, repo });

  // Hot modules insight
  if (summary.hotModules.length > 0) {
    const hotList = summary.hotModules.slice(0, 3).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] Frequently changed modules: ${hotList}. Watch for change impact.`,
        insightOpts(0.6, 0.8)
      );
    } catch (err) {
      safeConsole.warn(`[Knowledge] 메모리 저장 실패 (hot modules):`, err instanceof Error ? err.message : err);
    }
  }

  // High risk modules insight
  const highRisk = riskModules.filter(m => m.risk === 'high');
  if (highRisk.length > 0) {
    const riskList = highRisk.slice(0, 3).map(m => m.moduleId).join(', ');
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] High-risk modules (no tests + high churn): ${riskList}. Adding tests recommended.`,
        insightOpts(0.7, 0.85)
      );
    } catch (err) {
      safeConsole.warn(`[Knowledge] 메모리 저장 실패 (high risk):`, err instanceof Error ? err.message : err);
    }
  }

  // Test coverage insight
  if (summary.untestedModules.length > 0 && summary.totalModules > 0) {
    const coverage = Math.round((1 - summary.untestedModules.length / summary.totalModules) * 100);
    try {
      await saveCognitiveMemory('system_pattern',
        `[${slug}] Test coverage: ${coverage}% (${summary.totalTestFiles} tests / ${summary.totalModules} modules). ${summary.untestedModules.length} untested.`,
        insightOpts(0.5, 0.9)
      );
    } catch (err) {
      safeConsole.warn(`[Knowledge] 메모리 저장 실패 (coverage):`, err instanceof Error ? err.message : err);
    }
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
