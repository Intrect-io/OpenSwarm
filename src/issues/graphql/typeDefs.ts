// ============================================
// OpenSwarm - Issue Tracker GraphQL Type Definitions
// Created: 2026-04-03
// Purpose: GraphQL schema definition
// ============================================

export const typeDefs = /* GraphQL */ `
  type Query {
    # 이슈
    issue(id: ID!): Issue
    issues(filter: IssueFilterInput): IssueConnection!

    # 라벨 & 마일스톤
    labels: [Label!]!
    milestones: [Milestone!]!

    # 이벤트 로그
    issueEvents(issueId: ID!, limit: Int): [IssueEvent!]!
    recentEvents(limit: Int): [IssueEvent!]!

    # 통계
    issueStats(projectId: String): IssueStats!

    # 메모리 연동
    linkedMemories(issueId: ID!): [String!]!
    issueContext(issueId: ID!): IssueContext!
  }

  type Mutation {
    # 이슈 CRUD
    createIssue(input: CreateIssueInput!): Issue!
    updateIssue(id: ID!, input: UpdateIssueInput!): Issue
    deleteIssue(id: ID!): Boolean!

    # 상태 전이
    changeIssueStatus(id: ID!, status: IssueStatus!, actor: String): Issue

    # 이벤트
    addComment(issueId: ID!, content: String!, actor: String): IssueEvent!

    # 라벨
    createLabel(name: String!, color: String, description: String): Label!
    deleteLabel(id: ID!): Boolean!

    # 마일스톤
    createMilestone(name: String!, description: String, dueDate: String): Milestone!

    # 메모리 연동
    linkMemory(issueId: ID!, memoryId: String!): Boolean!
    autoLinkMemories(issueId: ID!): [String!]!
  }

  # ---- Types ----

  type Issue {
    id: ID!
    projectId: String!
    title: String!
    description: String!
    status: IssueStatus!
    priority: IssuePriority!
    source: IssueSource!
    labels: [String!]!
    assignee: String
    milestone: String
    relevantFiles: [String!]!
    acceptanceCriteria: [String!]!
    estimateMinutes: Int
    complexity: Complexity
    dependencies: [String!]!
    parentId: String
    childIds: [String!]!
    linearId: String
    linearIdentifier: String
    linearUrl: String
    memoryIds: [String!]!
    createdAt: String!
    updatedAt: String!
    closedAt: String
  }

  type IssueConnection {
    issues: [Issue!]!
    total: Int!
  }

  type IssueEvent {
    id: ID!
    issueId: String!
    type: IssueEventType!
    oldValue: String
    newValue: String
    content: String
    memoryId: String
    actor: String!
    createdAt: String!
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    description: String
  }

  type Milestone {
    id: ID!
    name: String!
    description: String
    dueDate: String
    status: String!
    createdAt: String!
  }

  type IssueStats {
    total: Int!
    byStatus: [StatusCount!]!
    byPriority: [PriorityCount!]!
    byProject: [ProjectCount!]!
    recentlyCreated: Int!
    recentlyClosed: Int!
  }

  type StatusCount {
    status: String!
    count: Int!
  }

  type PriorityCount {
    priority: String!
    count: Int!
  }

  type ProjectCount {
    projectId: String!
    count: Int!
  }

  type IssueContext {
    linkedMemories: [MemoryRef!]!
    similarIssues: [Issue!]!
  }

  type MemoryRef {
    id: String!
    content: String!
    score: Float!
  }

  # ---- Enums ----

  enum IssueStatus {
    backlog
    todo
    in_progress
    in_review
    done
    cancelled
  }

  enum IssuePriority {
    urgent
    high
    medium
    low
    none
  }

  enum IssueSource {
    local
    linear
    github
    discord
  }

  enum Complexity {
    simple
    moderate
    complex
    very_complex
  }

  enum IssueEventType {
    created
    status_changed
    priority_changed
    assigned
    commented
    labeled
    linked
    memory_linked
    closed
    reopened
  }

  # ---- Inputs ----

  input CreateIssueInput {
    projectId: String!
    title: String!
    description: String
    status: IssueStatus
    priority: IssuePriority
    source: IssueSource
    labels: [String!]
    assignee: String
    milestone: String
    relevantFiles: [String!]
    acceptanceCriteria: [String!]
    estimateMinutes: Int
    complexity: Complexity
    dependencies: [String!]
    parentId: String
    linearId: String
    linearIdentifier: String
    linearUrl: String
  }

  input UpdateIssueInput {
    title: String
    description: String
    priority: IssuePriority
    labels: [String!]
    assignee: String
    milestone: String
    relevantFiles: [String!]
    acceptanceCriteria: [String!]
    estimateMinutes: Int
    complexity: Complexity
    dependencies: [String!]
    parentId: String
  }

  input IssueFilterInput {
    projectId: String
    status: [IssueStatus!]
    priority: [IssuePriority!]
    labels: [String!]
    assignee: String
    source: IssueSource
    parentId: String
    search: String
    limit: Int
    offset: Int
  }
`;
