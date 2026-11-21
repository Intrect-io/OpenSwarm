// ============================================
// OpenSwarm - Code Registry Schema
// Created: 2026-04-10
// Purpose: Zod schemas + type definitions (code entity registry)
// ============================================

import { z } from 'zod';

// Entity kinds
export const EntityKindSchema = z.enum([
  'function',
  'class',
  'module',
  'type',
  'constant',
]);

// Entity states
export const EntityStatusSchema = z.enum([
  'active',
  'deprecated',
  'experimental',
  'planned',
  'broken',
]);

// Risk levels
export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);

// Warning severity
export const WarningSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);

// Warning categories
export const WarningCategorySchema = z.enum(['security', 'performance', 'correctness', 'style']);

// Relation types between entities
export const RelationTypeSchema = z.enum(['calls', 'extends', 'implements', 'uses', 'overrides']);

// Event types
export const EntityEventTypeSchema = z.enum([
  'created',
  'updated',
  'deprecated',
  'status_changed',
  'warning_added',
  'warning_resolved',
  'tag_added',
  'tag_removed',
  'issue_linked',
  'memory_linked',
  'note_added',
]);

// Tags
export const EntityTagSchema = z.object({
  tag: z.string().min(1),
  value: z.string().optional(),
});

// Warnings
export const EntityWarningSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  severity: WarningSeveritySchema,
  category: WarningCategorySchema,
  message: z.string().min(1),
  resolved: z.boolean().default(false),
  resolvedAt: z.string().optional(),
  createdAt: z.string(),
});

// Relations
export const EntityRelationSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  relationType: RelationTypeSchema,
});

// Events
export const EntityEventSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  type: EntityEventTypeSchema,
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  content: z.string().optional(),
  actor: z.string().default('system'),
  createdAt: z.string(),
});

// Main code entity schema
export const CodeEntitySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: EntityKindSchema,
  name: z.string().min(1),
  qualifiedName: z.string(), // file_path::name
  filePath: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  signature: z.string().optional(),
  status: EntityStatusSchema.default('active'),
  deprecatedAt: z.string().optional(),
  deprecatedReason: z.string().optional(),
  hasTests: z.boolean().default(false),
  testFile: z.string().optional(),
  author: z.string().optional(),
  maintainer: z.string().optional(),
  complexityScore: z.number().min(0).max(10).optional(),
  riskLevel: RiskLevelSchema.default('low'),
  description: z.string().default(''),
  notes: z.string().default(''),
  knowledgeNodeId: z.string().optional(),

  // Fields populated by joins at runtime
  tags: z.array(EntityTagSchema).default([]),
  warnings: z.array(EntityWarningSchema).default([]),
  linkedIssueIds: z.array(z.string()).default([]),
  linkedMemoryIds: z.array(z.string()).default([]),

  createdAt: z.string(),
  updatedAt: z.string(),
});

// Entity filter
export const CodeEntityFilterSchema = z.object({
  projectId: z.string().optional(),
  kind: z.array(EntityKindSchema).optional(),
  status: z.array(EntityStatusSchema).optional(),
  filePath: z.string().optional(),
  hasTests: z.boolean().optional(),
  riskLevel: z.array(RiskLevelSchema).optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().default(50),
  offset: z.number().default(0),
});

// File briefing
export const FileBriefSchema = z.object({
  filePath: z.string(),
  summary: z.string(),
  entities: z.array(CodeEntitySchema),
});

// Registry statistics
export const RegistryStatsSchema = z.object({
  total: z.number(),
  byKind: z.array(z.object({ kind: z.string(), count: z.number() })),
  byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
  deprecated: z.number(),
  untested: z.number(),
  highRisk: z.number(),
  withWarnings: z.number(),
});

// Type exports
export type EntityKind = z.infer<typeof EntityKindSchema>;
export type EntityStatus = z.infer<typeof EntityStatusSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type WarningSeverity = z.infer<typeof WarningSeveritySchema>;
export type WarningCategory = z.infer<typeof WarningCategorySchema>;
export type RelationType = z.infer<typeof RelationTypeSchema>;
export type EntityEventType = z.infer<typeof EntityEventTypeSchema>;
export type EntityTag = z.infer<typeof EntityTagSchema>;
export type EntityWarning = z.infer<typeof EntityWarningSchema>;
export type EntityRelation = z.infer<typeof EntityRelationSchema>;
export type EntityEvent = z.infer<typeof EntityEventSchema>;
export type CodeEntity = z.infer<typeof CodeEntitySchema>;
export type CodeEntityFilter = z.infer<typeof CodeEntityFilterSchema>;
export type FileBrief = z.infer<typeof FileBriefSchema>;
export type RegistryStats = z.infer<typeof RegistryStatsSchema>;
