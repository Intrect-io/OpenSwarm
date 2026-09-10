// ============================================
// OpenSwarm — adapter names, with nothing attached (AGT-4292)
// ============================================
//
// Its own module because the two obvious homes both cost more than a string
// list should. `adapters/index.ts` imports every adapter, and `codex.ts` calls
// `promisify(execFile)` at module scope — so validating one name there breaks
// any test that mocks `node:child_process`. `core/config.ts` is lighter but is
// widely mocked, and a new export on it makes every one of those mocks
// incomplete.
//
// A leaf with no imports is mockable by nobody and breaks nothing.

/** Adapter names as configuration and the CLI accept them. */
export const ADAPTER_NAMES = [
  'codex', 'codex-responses', 'gpt', 'local', 'lmstudio',
  'openrouter', 'atlascloud', 'claude', 'cc-router', 'cursor',
] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];

/** True when `name` is an adapter configuration would accept. */
export function isConfiguredAdapterName(name: string): name is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(name);
}
