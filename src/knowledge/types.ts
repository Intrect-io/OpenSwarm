// ============================================
// OpenSwarm - Knowledge Graph Types
// Code structure awareness graph type definitions
// ============================================

import { z } from 'zod';

// ============================================
// Node Types
// ============================================

export const NodeTypeSchema = z.enum(['project', 'directory', 'module', 'test_file']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.enum(['contains', 'imports', 'tests', 'depends_on']);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

export const LanguageSchema = z.enum(['typescript', 'python', 'other']);
export type Language = z.infer<typeof LanguageSchema>;

// ============================================
// Module State & Development Stage
// ============================================

export const ModuleStateSchema = z.enum([
  'stable',        // Production-ready, well-tested
  'experimental',  // Under active development, API may change
  'deprecated',    // Scheduled for removal
  'legacy',        // Old code, needs refactoring
  'planned',       // Not yet implemented
]);
export type ModuleState = z.infer<typeof ModuleStateSchema>;

export const DevelopmentStageSchema = z.enum([
  'planning',      // Design phase
  'in_progress',   // Active development
  'testing',       // QA/testing phase
  'reviewing',     // Code review
  'deployed',      // In production
  'blocked',       // Blocked by dependencies or issues
]);
export type DevelopmentStage = z.infer<typeof DevelopmentStageSchema>;

// ============================================
// Issue Tracking
// ============================================

export const IssueReferenceSchema = z.object({
  issueId: z.string(),           // Linear issue ID
  issueIdentifier: z.string(),   // Human-readable identifier (e.g., "INT-123")
  title: z.string(),
  state: z.string(),             // Linear state (Todo, In Progress, Done, etc.)
  priority: z.number().optional(), // 0-4 (0=none, 1=urgent, 4=low)
  assigneeId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type IssueReference = z.infer<typeof IssueReferenceSchema>;

// ============================================
// Module Metadata (Extended)
// ============================================

export const ModuleMetadataSchema = z.object({
  state: ModuleStateSchema.optional(),
  developmentStage: DevelopmentStageSchema.optional(),
  relatedIssues: z.array(IssueReferenceSchema).optional(),  // Issues affecting this module
  dependencies: z.array(z.string()).optional(),              // Module IDs this depends on
  dependents: z.array(z.string()).optional(),                // Module IDs that depend on this
  maintainer: z.string().optional(),                         // Primary owner/maintainer
  lastReviewedAt: z.number().optional(),                     // Last code review timestamp
  techDebt: z.number().optional(),                           // 0-10 scale (subjective)
  notes: z.string().optional(),                              // Free-form notes
});
export type ModuleMetadata = z.infer<typeof ModuleMetadataSchema>;

// ============================================
// Module Metrics
// ============================================

export const ModuleMetricsSchema = z.object({
  loc: z.number(),
  exportCount: z.number(),
  importCount: z.number(),
  language: LanguageSchema,
});
export type ModuleMetrics = z.infer<typeof ModuleMetricsSchema>;

// ============================================
// Git Info
// ============================================

export const GitInfoSchema = z.object({
  lastCommitDate: z.number(),
  commitCount30d: z.number(),
  churnScore: z.number(), // 0-1, normalized change frequency
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

// ============================================
// Graph Node
// ============================================

export const GraphNodeSchema = z.object({
  id: z.string(),           // Unique ID based on relative path (e.g., "src/core/service.ts")
  type: NodeTypeSchema,
  name: z.string(),          // Filename or directory name
  path: z.string(),          // Relative path from project root
  metrics: ModuleMetricsSchema.optional(),
  gitInfo: GitInfoSchema.optional(),
  metadata: ModuleMetadataSchema.optional(),  // Extended metadata (state, stage, issues)
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ============================================
// Graph Edge
// ============================================

export const GraphEdgeSchema = z.object({
  source: z.string(),       // Source node ID
  target: z.string(),       // Target node ID
  type: EdgeTypeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ============================================
// Project Summary
// ============================================

export const ProjectSummarySchema = z.object({
  totalModules: z.number(),
  totalTestFiles: z.number(),
  hotModules: z.array(z.string()),         // Top 5 most changed modules in last 30 days
  untestedModules: z.array(z.string()),    // Modules without tests
  avgChurnScore: z.number(),

  // Extended summary (state & issues)
  stableModules: z.number().optional(),      // Count of stable modules
  experimentalModules: z.number().optional(), // Count of experimental modules
  deprecatedModules: z.number().optional(),   // Count of deprecated modules
  activeIssues: z.number().optional(),        // Count of open issues
  blockedModules: z.array(z.string()).optional(), // Modules in blocked state
  highTechDebtModules: z.array(z.string()).optional(), // Modules with tech debt >= 7
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// ============================================
// Impact Analysis
// ============================================

export const ImpactAnalysisSchema = z.object({
  directModules: z.array(z.string()),      // Modules referenced in issue text
  dependentModules: z.array(z.string()),   // Modules that import direct modules
  testFiles: z.array(z.string()),          // Tests that should be run
  estimatedScope: z.enum(['small', 'medium', 'large']),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;

// ============================================
// Serialized Graph (JSON persistence)
// ============================================

export const SerializedGraphSchema = z.object({
  version: z.literal(1),
  projectSlug: z.string(),
  projectPath: z.string(),
  scannedAt: z.number(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  summary: ProjectSummarySchema.optional(),
});
export type SerializedGraph = z.infer<typeof SerializedGraphSchema>;
