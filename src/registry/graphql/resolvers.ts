// ============================================
// OpenSwarm - Code Registry GraphQL Resolvers
// Created: 2026-04-10
// Purpose: Query + Mutation 리졸버
// ============================================

import { getRegistryStore, type RegisterEntityInput, type UpdateEntityInput } from '../sqliteStore.js';
import { onEntityDeprecated, onEntityWarningAdded } from '../memoryBridge.js';
import type {
  CodeEntity, CodeEntityFilter, EntityStatus, WarningSeverity, WarningCategory, RelationType,
} from '../schema.js';

const DEFAULT_ENTITY_LIMIT = 50;
const MAX_ENTITY_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 200;
const MAX_BULK_REGISTER_ENTITIES = 100;
const MAX_ENTITY_WARNINGS_RESULTS = 200;

function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (limit === undefined || !Number.isInteger(limit)) return defaultLimit;
  return Math.min(Math.max(limit, 1), maxLimit);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset)) return 0;
  return Math.max(offset, 0);
}

function normalizeSearchText(search: string | undefined): string | undefined {
  const normalized = search
    ?.split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || undefined;
}

function normalizeEntityFilter(filter: CodeEntityFilter | undefined): CodeEntityFilter {
  return {
    ...filter,
    search: normalizeSearchText(filter?.search),
    limit: clampLimit(filter?.limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
    offset: clampOffset(filter?.offset),
  };
}

export const registryResolvers = {
  Query: {
    codeEntity: (_: unknown, { id }: { id: string }) => {
      return getRegistryStore().getEntity(id);
    },

    codeEntityByName: (_: unknown, { qualifiedName, projectId }: { qualifiedName: string; projectId?: string }) => {
      return getRegistryStore().getEntityByName(qualifiedName, projectId);
    },

    codeEntities: (_: unknown, { filter }: { filter?: CodeEntityFilter }) => {
      return getRegistryStore().listEntities(normalizeEntityFilter(filter));
    },

    fileBrief: (_: unknown, { filePath, projectId }: { filePath: string; projectId?: string }) => {
      return getRegistryStore().fileBrief(filePath, projectId);
    },

    registryStats: (_: unknown, { projectId }: { projectId?: string }) => {
      return getRegistryStore().getStats(projectId);
    },

    deprecatedEntities: (_: unknown, { projectId, limit, offset }: {
      projectId?: string; limit?: number; offset?: number;
    }) => {
      return getRegistryStore().listEntities({
        projectId,
        status: ['deprecated'],
        limit: clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
        offset: clampOffset(offset),
      }).entities;
    },

    untestedEntities: (_: unknown, { projectId, limit, offset }: {
      projectId?: string; limit?: number; offset?: number;
    }) => {
      return getRegistryStore().listEntities({
        projectId,
        status: ['active'],
        hasTests: false,
        limit: clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
        offset: clampOffset(offset),
      }).entities;
    },

    highRiskEntities: (_: unknown, { projectId, limit, offset }: {
      projectId?: string; limit?: number; offset?: number;
    }) => {
      return getRegistryStore().listEntities({
        projectId,
        riskLevel: ['high'],
        limit: clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
        offset: clampOffset(offset),
      }).entities;
    },

    entitiesByTag: (_: unknown, { tag, value, projectId, limit, offset }: {
      tag: string; value?: string | null; projectId?: string; limit?: number; offset?: number;
    }) => {
      if (value == null) {
        return getRegistryStore().listEntities({
          projectId,
          tags: [tag],
          limit: clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
          offset: clampOffset(offset),
        }).entities;
      }
      return getRegistryStore().entitiesByTag(
        tag,
        value,
        projectId,
        clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT),
        clampOffset(offset),
      );
    },

    entityWarnings: (_: unknown, { severity, projectId, limit, offset }: {
      severity?: WarningSeverity; projectId?: string; limit?: number; offset?: number;
    }) => {
      const offsetValue = clampOffset(offset);
      const pageSize = clampLimit(limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT);
      if (offsetValue + pageSize > MAX_ENTITY_WARNINGS_RESULTS) {
        throw new Error(
          `entityWarnings result window exceeds the request budget of ${MAX_ENTITY_WARNINGS_RESULTS} (offset ${offsetValue} + limit ${pageSize})`,
        );
      }
      return getRegistryStore().getUnresolvedWarnings(
        severity,
        projectId,
        pageSize,
        offsetValue,
      );
    },

    searchEntities: (_: unknown, { query, projectId, limit }: { query: string; projectId?: string; limit?: number }) => {
      const search = normalizeSearchText(query);
      if (!search) return [];
      const cappedLimit = clampLimit(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      return getRegistryStore().searchEntities(search, cappedLimit, projectId);
    },
  },

  Mutation: {
    registerEntity: (_: unknown, { input }: { input: RegisterEntityInput }) => {
      return getRegistryStore().registerEntity(input);
    },

    bulkRegisterEntities: (_: unknown, { input }: { input: RegisterEntityInput[] }) => {
      if (input.length > MAX_BULK_REGISTER_ENTITIES) {
        throw new Error(`bulkRegisterEntities input is limited to ${MAX_BULK_REGISTER_ENTITIES} entities`);
      }
      return getRegistryStore().bulkRegisterEntities(input);
    },

    updateEntity: (_: unknown, { id, input }: { id: string; input: UpdateEntityInput }) => {
      return getRegistryStore().updateEntity(id, input);
    },

    removeEntity: (_: unknown, { id }: { id: string }) => {
      return getRegistryStore().removeEntity(id);
    },

    deprecateEntity: (_: unknown, { id, reason }: { id: string; reason?: string }) => {
      const store = getRegistryStore();
      const entity = store.deprecateEntity(id, reason ?? undefined);
      if (entity) {
        onEntityDeprecated(entity).catch(err =>
          console.warn('[Registry] 메모리 브릿지 실패:', err)
        );
      }
      return entity;
    },

    changeEntityStatus: (_: unknown, { id, status, actor }: { id: string; status: EntityStatus; actor?: string }) => {
      return getRegistryStore().changeEntityStatus(id, status, actor ?? 'system');
    },

    addEntityTag: (_: unknown, { entityId, tag, value }: { entityId: string; tag: string; value?: string }) => {
      const store = getRegistryStore();
      store.addTag(entityId, tag, value ?? undefined);
      return store.getEntity(entityId);
    },

    removeEntityTag: (_: unknown, { entityId, tag }: { entityId: string; tag: string }) => {
      const store = getRegistryStore();
      store.removeTag(entityId, tag);
      return store.getEntity(entityId);
    },

    addEntityWarning: (_: unknown, { entityId, severity, category, message }: {
      entityId: string; severity: WarningSeverity; category: WarningCategory; message: string;
    }) => {
      const store = getRegistryStore();
      const warning = store.addWarning(entityId, severity, category, message);
      const entity = store.getEntity(entityId);
      if (entity) {
        onEntityWarningAdded(entity, warning).catch(err =>
          console.warn('[Registry] 메모리 브릿지 실패:', err)
        );
      }
      return warning;
    },

    resolveWarning: (_: unknown, { warningId }: { warningId: string }) => {
      return getRegistryStore().resolveWarning(warningId);
    },

    addEntityRelation: (_: unknown, { sourceId, targetId, relationType }: {
      sourceId: string; targetId: string; relationType: RelationType;
    }) => {
      const store = getRegistryStore();
      store.addRelation(sourceId, targetId, relationType);
      return store.getRelations(sourceId).some((rel) =>
        rel.targetId === targetId && rel.relationType === relationType
      );
    },

    removeEntityRelation: (_: unknown, { sourceId, targetId, relationType }: {
      sourceId: string; targetId: string; relationType: RelationType;
    }) => {
      const store = getRegistryStore();
      store.removeRelation(sourceId, targetId, relationType);
      return !store.getRelations(sourceId).some((rel) =>
        rel.targetId === targetId && rel.relationType === relationType
      );
    },

    linkEntityToIssue: (_: unknown, { entityId, issueId }: { entityId: string; issueId: string }) => {
      const store = getRegistryStore();
      store.linkIssue(entityId, issueId);
      return store.getEntity(entityId)?.linkedIssueIds.includes(issueId) ?? false;
    },

    unlinkEntityFromIssue: (_: unknown, { entityId, issueId }: { entityId: string; issueId: string }) => {
      const store = getRegistryStore();
      store.unlinkIssue(entityId, issueId);
      return !(store.getEntity(entityId)?.linkedIssueIds.includes(issueId) ?? false);
    },

    linkEntityToMemory: (_: unknown, { entityId, memoryId }: { entityId: string; memoryId: string }) => {
      const store = getRegistryStore();
      store.linkMemory(entityId, memoryId);
      return store.getEntity(entityId)?.linkedMemoryIds.includes(memoryId) ?? false;
    },

    addEntityNote: (_: unknown, { entityId, content, actor }: {
      entityId: string; content: string; actor?: string;
    }) => {
      return getRegistryStore().addEvent(entityId, 'note_added', {
        content,
        actor: actor ?? 'system',
      });
    },
  },

  // 필드 리졸버: CodeEntity.relations, CodeEntity.events
  CodeEntity: {
    relations: (entity: CodeEntity) => {
      return getRegistryStore().getRelations(entity.id);
    },
    events: (entity: CodeEntity, { limit }: { limit?: number }) => {
      return getRegistryStore().getEvents(entity.id, clampLimit(limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT));
    },
  },
};
