// ============================================
// OpenSwarm - Code Registry Module
// Created: 2026-04-10
// Purpose: Public API of the code entity registry
// ============================================

// Store
export {
  SqliteRegistryStore,
  getRegistryStore,
  closeRegistryStore,
} from './sqliteStore.js';
export type { RegisterEntityInput, UpdateEntityInput } from './sqliteStore.js';

// Types
export type {
  EntityKind, EntityStatus, RiskLevel,
  WarningSeverity, WarningCategory, RelationType,
  EntityEventType, EntityTag, EntityWarning, EntityRelation,
  EntityEvent, CodeEntity, CodeEntityFilter,
  FileBrief, RegistryStats,
} from './schema.js';

// GraphQL
export { registryTypeDefs } from './graphql/typeDefs.js';
export { registryResolvers } from './graphql/resolvers.js';

// Scanner
export { scanRepository, extractEntities } from './entityScanner.js';
export type { ScanResult, ExtractedEntity } from './entityScanner.js';

// BS Detector
export { scanRepository as scanBs, scanFile as scanFileForBs, scanFileContent, aggregateResults } from './bsDetector.js';
export type { BsIssue, BsScanResult, BsSeverity } from './bsDetector.js';

// Bridges
export { onEntityDeprecated, onEntityWarningAdded } from './memoryBridge.js';
export { getEntitiesForIssue } from './issueBridge.js';
