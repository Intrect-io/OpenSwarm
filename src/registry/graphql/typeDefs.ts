// ============================================
// OpenSwarm - Code Registry GraphQL Type Definitions
// Created: 2026-04-10
// Purpose: GraphQL schema for the code entity registry
// ============================================

export const registryTypeDefs = /* GraphQL */ `
  extend type Query {
    # 엔티티 조회
    codeEntity(id: ID!): CodeEntity
    codeEntityByName(qualifiedName: String!, projectId: String): CodeEntity
    codeEntities(filter: CodeEntityFilterInput): CodeEntityConnection!

    # 원샷 브리핑 (에이전트 핵심 사용 사례)
    fileBrief(filePath: String!, projectId: String): FileBrief!
    registryStats(projectId: String): RegistryStats!

    # 특화 쿼리
    deprecatedEntities(projectId: String, limit: Int, offset: Int): [CodeEntity!]!
    untestedEntities(projectId: String, limit: Int, offset: Int): [CodeEntity!]!
    highRiskEntities(projectId: String, limit: Int, offset: Int): [CodeEntity!]!
    entitiesByTag(tag: String!, value: String, projectId: String, limit: Int, offset: Int): [CodeEntity!]!
    entityWarnings(severity: WarningSeverity, projectId: String, limit: Int, offset: Int): [EntityWarning!]!

    # 전문검색
    searchEntities(query: String!, projectId: String, limit: Int): [CodeEntity!]!
  }

  extend type Mutation {
    # 엔티티 CRUD
    registerEntity(input: RegisterEntityInput!): CodeEntity!
    # 최대 100개
    bulkRegisterEntities(input: [RegisterEntityInput!]!): [CodeEntity!]!
    updateEntity(id: ID!, input: UpdateEntityInput!): CodeEntity
    removeEntity(id: ID!): Boolean!

    # 상태 관리
    deprecateEntity(id: ID!, reason: String): CodeEntity
    changeEntityStatus(id: ID!, status: EntityStatus!, actor: String): CodeEntity

    # 태그
    addEntityTag(entityId: ID!, tag: String!, value: String): CodeEntity
    removeEntityTag(entityId: ID!, tag: String!): CodeEntity

    # 경고
    addEntityWarning(entityId: ID!, severity: WarningSeverity!, category: WarningCategory!, message: String!): EntityWarning!
    resolveWarning(warningId: ID!): Boolean!

    # 관계
    addEntityRelation(sourceId: ID!, targetId: ID!, relationType: RelationType!): Boolean!
    removeEntityRelation(sourceId: ID!, targetId: ID!, relationType: RelationType!): Boolean!

    # 이슈 연결
    linkEntityToIssue(entityId: ID!, issueId: ID!): Boolean!
    unlinkEntityFromIssue(entityId: ID!, issueId: ID!): Boolean!

    # 메모리 연결
    linkEntityToMemory(entityId: ID!, memoryId: String!): Boolean!

    # 노트
    addEntityNote(entityId: ID!, content: String!, actor: String): EntityEvent!
  }

  # ---- Types ----

  type CodeEntity {
    id: ID!
    projectId: String!
    kind: EntityKind!
    name: String!
    qualifiedName: String!
    filePath: String!
    lineStart: Int
    lineEnd: Int
    signature: String
    status: EntityStatus!
    deprecatedAt: String
    deprecatedReason: String
    hasTests: Boolean!
    testFile: String
    author: String
    maintainer: String
    complexityScore: Int
    riskLevel: RiskLevel!
    description: String!
    notes: String!
    knowledgeNodeId: String
    tags: [EntityTag!]!
    warnings: [EntityWarning!]!
    relations: [EntityRelation!]!
    linkedIssueIds: [String!]!
    linkedMemoryIds: [String!]!
    events(limit: Int): [EntityEvent!]!
    createdAt: String!
    updatedAt: String!
  }

  type CodeEntityConnection {
    entities: [CodeEntity!]!
    total: Int!
  }

  type EntityTag {
    tag: String!
    value: String
  }

  type EntityWarning {
    id: ID!
    entityId: String!
    severity: WarningSeverity!
    category: WarningCategory!
    message: String!
    resolved: Boolean!
    resolvedAt: String
    createdAt: String!
  }

  type EntityRelation {
    targetId: String!
    targetName: String!
    relationType: RelationType!
  }

  type EntityEvent {
    id: ID!
    entityId: String!
    type: EntityEventType!
    oldValue: String
    newValue: String
    content: String
    actor: String!
    createdAt: String!
  }

  type FileBrief {
    filePath: String!
    summary: String!
    entities: [CodeEntity!]!
  }

  type RegistryStats {
    total: Int!
    byKind: [KindCount!]!
    byStatus: [RegistryStatusCount!]!
    deprecated: Int!
    untested: Int!
    highRisk: Int!
    withWarnings: Int!
  }

  type KindCount {
    kind: String!
    count: Int!
  }

  type RegistryStatusCount {
    status: String!
    count: Int!
  }

  # ---- Enums ----

  enum EntityKind {
    function
    class
    module
    type
    constant
  }

  enum EntityStatus {
    active
    deprecated
    experimental
    planned
    broken
  }

  enum RiskLevel {
    low
    medium
    high
  }

  enum WarningSeverity {
    info
    warning
    error
    critical
  }

  enum WarningCategory {
    security
    performance
    correctness
    style
  }

  enum RelationType {
    calls
    extends
    implements
    uses
    overrides
  }

  enum EntityEventType {
    created
    updated
    deprecated
    status_changed
    warning_added
    warning_resolved
    tag_added
    tag_removed
    issue_linked
    memory_linked
    note_added
  }

  # ---- Inputs ----

  input RegisterEntityInput {
    projectId: String!
    kind: EntityKind!
    name: String!
    filePath: String!
    lineStart: Int
    lineEnd: Int
    signature: String
    status: EntityStatus
    hasTests: Boolean
    testFile: String
    author: String
    maintainer: String
    complexityScore: Int
    riskLevel: RiskLevel
    description: String
    notes: String
    knowledgeNodeId: String
    tags: [TagInput!]
  }

  input UpdateEntityInput {
    name: String
    lineStart: Int
    lineEnd: Int
    signature: String
    hasTests: Boolean
    testFile: String
    maintainer: String
    complexityScore: Int
    riskLevel: RiskLevel
    description: String
    notes: String
  }

  input CodeEntityFilterInput {
    projectId: String
    kind: [EntityKind!]
    status: [EntityStatus!]
    filePath: String
    hasTests: Boolean
    riskLevel: [RiskLevel!]
    tags: [String!]
    author: String
    search: String
    limit: Int
    offset: Int
  }

  input TagInput {
    tag: String!
    value: String
  }
`;
