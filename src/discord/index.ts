// ============================================
// OpenSwarm - Discord Bot
//
// Barrel re-export: preserves existing import paths
// - discordCore.ts: init, router, history, config, events, messenger
// - discordHandlers.ts: all general handlers + OpenSwarm chat
// - discordPair.ts: Worker/Reviewer pair system
// ============================================
export * from './discordCore.js';
export * from './discordHandlers.js';
export * from './discordPair.js';
