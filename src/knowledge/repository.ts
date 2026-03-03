// ============================================
// OpenSwarm - Repository Knowledge Manager
// Module state, issues tracking, development stage management
// ============================================

import type { KnowledgeGraph } from './graph.js';
import type {
  ModuleState,
  DevelopmentStage,
  IssueReference,
  ModuleMetadata,
  GraphNode,
  ProjectSummary,
} from './types.js';
import { saveGraph } from './store.js';

// ============================================
// Issue Linking
// ============================================

/**
 * Link an issue to a module
 */
export function linkIssueToModule(
  graph: KnowledgeGraph,
  moduleId: string,
  issue: IssueReference
): boolean {
  const node = graph.getNode(moduleId);
  if (!node || node.type !== 'module') {
    console.warn(`[KnowledgeGraph] Module not found: ${moduleId}`);
    return false;
  }

  // Initialize metadata if missing
  if (!node.metadata) {
    node.metadata = {};
  }

  // Initialize relatedIssues if missing
  if (!node.metadata.relatedIssues) {
    node.metadata.relatedIssues = [];
  }

  // Check if issue already linked
  const existing = node.metadata.relatedIssues.find((i: IssueReference) => i.issueId === issue.issueId);
  if (existing) {
    // Update existing issue
    Object.assign(existing, issue);
    console.log(`[KnowledgeGraph] Updated issue ${issue.issueIdentifier} for ${moduleId}`);
  } else {
    // Add new issue
    node.metadata.relatedIssues.push(issue);
    console.log(`[KnowledgeGraph] Linked issue ${issue.issueIdentifier} to ${moduleId}`);
  }

  return true;
}

/**
 * Unlink an issue from a module
 */
export function unlinkIssueFromModule(
  graph: KnowledgeGraph,
  moduleId: string,
  issueId: string
): boolean {
  const node = graph.getNode(moduleId);
  if (!node?.metadata?.relatedIssues) {
    return false;
  }

  const initialLength = node.metadata.relatedIssues.length;
  node.metadata.relatedIssues = node.metadata.relatedIssues.filter((i: IssueReference) => i.issueId !== issueId);

  const removed = initialLength !== node.metadata.relatedIssues.length;
  if (removed) {
    console.log(`[KnowledgeGraph] Unlinked issue ${issueId} from ${moduleId}`);
  }

  return removed;
}

/**
 * Get all modules linked to an issue
 */
export function getModulesByIssue(
  graph: KnowledgeGraph,
  issueId: string
): GraphNode[] {
  return graph.getNodesByType('module')
    .filter(node =>
      node.metadata?.relatedIssues?.some((i: IssueReference) => i.issueId === issueId)
    );
}

/**
 * Get all issues linked to a module
 */
export function getIssuesByModule(
  graph: KnowledgeGraph,
  moduleId: string
): IssueReference[] {
  const node = graph.getNode(moduleId);
  return node?.metadata?.relatedIssues ?? [];
}

// ============================================
// Module State Management
// ============================================

/**
 * Update module state
 */
export function updateModuleState(
  graph: KnowledgeGraph,
  moduleId: string,
  state: ModuleState
): boolean {
  const node = graph.getNode(moduleId);
  if (!node || node.type !== 'module') {
    console.warn(`[KnowledgeGraph] Module not found: ${moduleId}`);
    return false;
  }

  if (!node.metadata) {
    node.metadata = {};
  }

  node.metadata.state = state;
  console.log(`[KnowledgeGraph] Updated ${moduleId} state: ${state}`);
  return true;
}

/**
 * Update development stage
 */
export function updateDevelopmentStage(
  graph: KnowledgeGraph,
  moduleId: string,
  stage: DevelopmentStage
): boolean {
  const node = graph.getNode(moduleId);
  if (!node || node.type !== 'module') {
    console.warn(`[KnowledgeGraph] Module not found: ${moduleId}`);
    return false;
  }

  if (!node.metadata) {
    node.metadata = {};
  }

  node.metadata.developmentStage = stage;
  console.log(`[KnowledgeGraph] Updated ${moduleId} stage: ${stage}`);
  return true;
}

/**
 * Update tech debt score
 */
export function updateTechDebt(
  graph: KnowledgeGraph,
  moduleId: string,
  score: number
): boolean {
  if (score < 0 || score > 10) {
    console.warn(`[KnowledgeGraph] Invalid tech debt score: ${score} (must be 0-10)`);
    return false;
  }

  const node = graph.getNode(moduleId);
  if (!node || node.type !== 'module') {
    console.warn(`[KnowledgeGraph] Module not found: ${moduleId}`);
    return false;
  }

  if (!node.metadata) {
    node.metadata = {};
  }

  node.metadata.techDebt = score;
  console.log(`[KnowledgeGraph] Updated ${moduleId} tech debt: ${score}/10`);
  return true;
}

/**
 * Update module metadata (bulk update)
 */
export function updateModuleMetadata(
  graph: KnowledgeGraph,
  moduleId: string,
  metadata: Partial<ModuleMetadata>
): boolean {
  const node = graph.getNode(moduleId);
  if (!node || node.type !== 'module') {
    console.warn(`[KnowledgeGraph] Module not found: ${moduleId}`);
    return false;
  }

  if (!node.metadata) {
    node.metadata = {};
  }

  Object.assign(node.metadata, metadata);
  console.log(`[KnowledgeGraph] Updated ${moduleId} metadata`);
  return true;
}

// ============================================
// Query Functions
// ============================================

/**
 * Get modules by state
 */
export function getModulesByState(
  graph: KnowledgeGraph,
  state: ModuleState
): GraphNode[] {
  return graph.getNodesByType('module')
    .filter(node => node.metadata?.state === state);
}

/**
 * Get modules by development stage
 */
export function getModulesByStage(
  graph: KnowledgeGraph,
  stage: DevelopmentStage
): GraphNode[] {
  return graph.getNodesByType('module')
    .filter(node => node.metadata?.developmentStage === stage);
}

/**
 * Get modules with high tech debt (>= threshold)
 */
export function getHighTechDebtModules(
  graph: KnowledgeGraph,
  threshold: number = 7
): GraphNode[] {
  return graph.getNodesByType('module')
    .filter(node => (node.metadata?.techDebt ?? 0) >= threshold)
    .sort((a, b) => (b.metadata?.techDebt ?? 0) - (a.metadata?.techDebt ?? 0));
}

/**
 * Get blocked modules (blocked development stage or has blocking issues)
 */
export function getBlockedModules(
  graph: KnowledgeGraph
): GraphNode[] {
  return graph.getNodesByType('module')
    .filter(node =>
      node.metadata?.developmentStage === 'blocked' ||
      node.metadata?.relatedIssues?.some(i => i.state === 'Blocked')
    );
}

/**
 * Get modules without tests
 */
export function getUntestedModules(
  graph: KnowledgeGraph
): GraphNode[] {
  const modules = graph.getNodesByType('module');
  const modulesThatHaveTests = new Set<string>();

  // Find all test files
  const testFiles = graph.getNodesByType('test_file');

  // Find modules that are tested by test files
  for (const testFile of testFiles) {
    const testedModules = graph.getTestedModules(testFile.id);
    for (const mod of testedModules) {
      modulesThatHaveTests.add(mod.id);
    }
  }

  // Return modules without tests
  return modules.filter(mod => !modulesThatHaveTests.has(mod.id));
}

// ============================================
// Project Summary Generation
// ============================================

/**
 * Generate comprehensive project summary
 */
export function generateProjectSummary(
  graph: KnowledgeGraph
): ProjectSummary {
  const modules = graph.getNodesByType('module');
  const testFiles = graph.getNodesByType('test_file');

  // Basic counts
  const totalModules = modules.length;
  const totalTestFiles = testFiles.length;

  // Untested modules
  const untestedModules = getUntestedModules(graph).map(m => m.id);

  // Hot modules (top 5 by churn score)
  const hotModules = modules
    .filter(m => m.gitInfo?.churnScore)
    .sort((a, b) => (b.gitInfo?.churnScore ?? 0) - (a.gitInfo?.churnScore ?? 0))
    .slice(0, 5)
    .map(m => m.id);

  // Average churn score
  const modulesWithChurn = modules.filter(m => m.gitInfo?.churnScore);
  const avgChurnScore = modulesWithChurn.length > 0
    ? modulesWithChurn.reduce((sum, m) => sum + (m.gitInfo?.churnScore ?? 0), 0) / modulesWithChurn.length
    : 0;

  // Extended summary
  const stableModules = getModulesByState(graph, 'stable').length;
  const experimentalModules = getModulesByState(graph, 'experimental').length;
  const deprecatedModules = getModulesByState(graph, 'deprecated').length;

  // Active issues count (across all modules)
  const activeIssues = new Set<string>();
  for (const mod of modules) {
    if (mod.metadata?.relatedIssues) {
      for (const issue of mod.metadata.relatedIssues) {
        if (issue.state !== 'Done' && issue.state !== 'Canceled') {
          activeIssues.add(issue.issueId);
        }
      }
    }
  }

  const blockedModules = getBlockedModules(graph).map(m => m.id);
  const highTechDebtModules = getHighTechDebtModules(graph, 7).map(m => m.id);

  return {
    totalModules,
    totalTestFiles,
    hotModules,
    untestedModules,
    avgChurnScore,

    // Extended
    stableModules,
    experimentalModules,
    deprecatedModules,
    activeIssues: activeIssues.size,
    blockedModules,
    highTechDebtModules,
  };
}

// ============================================
// Persistence Helpers
// ============================================

/**
 * Save graph after updates
 * Note: Call generateProjectSummary() to get summary before saving
 */
export async function saveGraphWithSummary(
  graph: KnowledgeGraph
): Promise<void> {
  await saveGraph(graph);
  console.log(`[KnowledgeGraph] Saved graph for ${graph.projectSlug}`);
}
