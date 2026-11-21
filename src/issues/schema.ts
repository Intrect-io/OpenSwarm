// ============================================
// OpenSwarm - Issue Tracker Schema
// Created: 2026-04-03
// Purpose: Zod schemas + type definitions (local issue tracker)
// ============================================

import { z } from 'zod';

// Issue status (Linear-compatible + local extensions)
export const IssueStatusSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);

export const IssuePrioritySchema = z.enum([
  'urgent',   // P0
  'high',     // P1
  'medium',   // P2
  'low',      // P3
  'none',     // P4
]);

// Issue source: locally created vs synced from Linear
export const IssueSourceSchema = z.enum([
  'local',
  'linear',
  'github',
  'discord',
]);

// Issue event types (history tracking + memory integration)
export const IssueEventTypeSchema = z.enum([
  'created',
  'status_changed',
  'priority_changed',
  'assigned',
  'commented',
  'labeled',
  'linked',         // 다른 이슈/PR 연결
  'memory_linked',  // 장기 기억 연동
  'closed',
  'reopened',
]);

// Issue event log (for memory system integration)
export const IssueEventSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  type: IssueEventTypeSchema,
  // Before/after on a state change
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  // Comment
  content: z.string().optional(),
  // Memory integration
  memoryId: z.string().optional(),
  // Meta
  actor: z.string().default('system'),
  createdAt: z.string(),
});

// Main issue schema
export const IssueSchema = z.object({
  id: z.string(),
  projectId: z.string(),          // config.yaml 프로젝트 매핑
  title: z.string().min(1),
  description: z.string().default(''),
  status: IssueStatusSchema.default('backlog'),
  priority: IssuePrioritySchema.default('medium'),
  source: IssueSourceSchema.default('local'),

  // Classification
  labels: z.array(z.string()).default([]),
  assignee: z.string().optional(),
  milestone: z.string().optional(),

  // AI metadata
  relevantFiles: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  estimateMinutes: z.number().optional(),
  complexity: z.enum(['simple', 'moderate', 'complex', 'very_complex']).optional(),

  // Dependencies
  dependencies: z.array(z.string()).default([]),  // 선행 이슈 IDs
  parentId: z.string().optional(),                 // 부모 이슈 (서브태스크)
  childIds: z.array(z.string()).default([]),       // 하위 이슈

  // Linear integration (optional)
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),

  // Memory integration
  memoryIds: z.array(z.string()).default([]),      // 관련 장기 기억 IDs

  // Tracking
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});

// Label schema
export const LabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  color: z.string().default('#6B7280'),  // 기본 gray
  description: z.string().optional(),
});

// Milestone schema
export const MilestoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.enum(['active', 'closed']).default('active'),
  createdAt: z.string(),
});

// Issue filter options
export const IssueFilterSchema = z.object({
  projectId: z.string().optional(),
  status: z.array(IssueStatusSchema).optional(),
  priority: z.array(IssuePrioritySchema).optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  source: IssueSourceSchema.optional(),
  parentId: z.string().optional(),
  search: z.string().optional(),           // FTS5 전문검색
  limit: z.number().default(50),
  offset: z.number().default(0),
});

// Type exports
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;
export type IssueSource = z.infer<typeof IssueSourceSchema>;
export type IssueEventType = z.infer<typeof IssueEventTypeSchema>;
export type IssueEvent = z.infer<typeof IssueEventSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type IssueFilter = z.infer<typeof IssueFilterSchema>;
