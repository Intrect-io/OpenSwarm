// Persist the dashboard's provider toggle across daemon restarts.
//
// switchProvider() only mutates the in-memory config, so every daemon restart reloads config.yaml
// (adapter: …) and silently reverts the choice — "I pressed Codex again but it's back to the old
// provider". We record the last toggle in a small JSON file next to config.yaml and re-apply it on
// boot. config.yaml itself (with its hand-written comments) is never rewritten.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterName } from '../adapters/types.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';

const OVERRIDE_DIR = join(homedir(), '.config', 'openswarm');
const OVERRIDE_PATH = join(OVERRIDE_DIR, 'provider-override.json');
// `claude` WAS excluded (a stale claude pin with no credits hangs the loop), but that guard also
// made an operator's EXPLICIT switch silently no-op — the daemon stayed on the old provider with
// zero feedback (observed 2026-07-05: override={"provider":"claude"} → no switch, no log). Honor
// the operator's choice; the startup mismatch warning still prints loudly, and a credit-less pin
// surfaces as visible worker failures rather than a silent revert.
const VALID: readonly AdapterName[] = ['claude', 'codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'cc-router', 'cursor'];
const VALID_SET = new Set<AdapterName>(VALID);

/** The provider the user last selected via the dashboard, or undefined if never toggled. */
export function readProviderOverride(): AdapterName | undefined {
  try {
    if (!existsSync(OVERRIDE_PATH)) return undefined;
    const { provider } = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf8')) as { provider?: string };
    return VALID_SET.has(provider as AdapterName) ? (provider as AdapterName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the loud startup warning shown when provider-override.json disagrees with
 * config.yaml's `adapter`. The override still wins (that is the documented toggle
 * behaviour) — this only makes the otherwise-silent divergence visible so an operator
 * does not waste time wondering why the daemon runs a different provider than
 * config.yaml declares (e.g. a stale `codex` pin masking `codex-responses`). Pure —
 * safe to unit-test. (INT-2408)
 */
export function formatProviderOverrideMismatchWarning(
  override: AdapterName,
  configAdapter: AdapterName,
): string {
  return (
    `⚠️ [Service] provider-override.json forces "${override}" — overriding config.yaml ` +
    `adapter "${configAdapter}". Delete ${OVERRIDE_PATH} to use the config value.`
  );
}

/** Record the user's provider choice so it survives a restart. Best-effort — never blocks the toggle. */
export function writeProviderOverride(provider: AdapterName): void {
  try {
    atomicWriteFileSync(OVERRIDE_PATH, `${JSON.stringify({ provider }, null, 2)}\n`, 0o600);
  } catch {
    /* persistence is an optimization — a failed write must not break the switch */
  }
}
