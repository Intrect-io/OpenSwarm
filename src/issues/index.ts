// ============================================
// OpenSwarm - Issue Tracker Module Index
// Created: 2026-04-03
// Purpose: Public API of the issue tracker
// ============================================

export { getIssueStore, closeIssueStore, SqliteIssueStore } from './sqliteStore.js';
export type { IIssueStore, CreateIssueInput, EventData, IssueStats } from './sqliteStore.js';
export type {
  Issue, IssueEvent, IssueFilter, IssueStatus, IssuePriority,
  IssueSource, IssueEventType, Label, Milestone,
} from './schema.js';
export {
  IssueSchema, IssueEventSchema, IssueFilterSchema,
  IssueStatusSchema, IssuePrioritySchema, LabelSchema, MilestoneSchema,
} from './schema.js';
export {
  autoLinkMemories, saveCompletionInsight,
  saveBlockingConstraint, enrichIssueContext, digestRecentEvents,
} from './memoryBridge.js';
export { handleGraphQL, isGraphQLRequest } from './graphql/server.js';
export {
  initLinearBridge, syncFromLinear, pushToLinear,
  syncStatusToLinear, isLinearBridgeReady,
} from './linearBridge.js';
