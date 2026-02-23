/**
 * Persistent Cognitive Memory Module v2.0
 *
 * Barrel re-export: preserves existing import paths
 * - memoryCore.ts: types, embedding, distillation, DB, save, search
 * - memoryOps.ts: revision, formatting, background, stats, legacy
 */
export * from './codex.js';
export * from './memoryCore.js';
export * from './memoryOps.js';
