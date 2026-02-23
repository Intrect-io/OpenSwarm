// ============================================
// OpenSwarm - Knowledge Graph Types
// 코드 구조 인식 그래프 타입 정의
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
  churnScore: z.number(), // 0-1, 변경 빈도 정규화
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

// ============================================
// Graph Node
// ============================================

export const GraphNodeSchema = z.object({
  id: z.string(),           // 상대 경로 기반 고유 ID (e.g., "src/core/service.ts")
  type: NodeTypeSchema,
  name: z.string(),          // 파일명 또는 디렉토리명
  path: z.string(),          // 프로젝트 루트 기준 상대 경로
  metrics: ModuleMetricsSchema.optional(),
  gitInfo: GitInfoSchema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ============================================
// Graph Edge
// ============================================

export const GraphEdgeSchema = z.object({
  source: z.string(),       // 소스 노드 ID
  target: z.string(),       // 타겟 노드 ID
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
  hotModules: z.array(z.string()),         // 최근 30일 가장 많이 변경된 모듈 Top5
  untestedModules: z.array(z.string()),    // 테스트 없는 모듈
  avgChurnScore: z.number(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// ============================================
// Impact Analysis
// ============================================

export const ImpactAnalysisSchema = z.object({
  directModules: z.array(z.string()),      // 이슈 텍스트에서 참조된 모듈
  dependentModules: z.array(z.string()),   // direct를 import하는 모듈들
  testFiles: z.array(z.string()),          // 실행해야 할 테스트
  estimatedScope: z.enum(['small', 'medium', 'large']),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;

// ============================================
// Serialized Graph (JSON 영속화)
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
