// ============================================
// OpenSwarm — provider/model compatibility
// ============================================
//
// One source of truth for "does this model id belong to that adapter?". Used
// by the provider switch (role/jobProfile/planner remapping) and the planner's
// model guard, so a config pinned for one provider never leaks an incompatible
// id into another provider's CLI/API. Observed failure without this:
// decomposition.plannerModel 'gpt-5.5' reaching `claude -p --model gpt-5.5`
// → API 404 on every decomposition attempt. (INT-2510)

import type { AdapterName } from './types.js';
import { ATLASCLOUD_CURATED_MODELS } from './atlascloud.js';
import { readCachedCatalog } from './modelCatalog.js';

/** Version-agnostic aliases the claude CLI resolves natively. */
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

/**
 * Synchronous default-model lookup for the discard warning. The real default is
 * resolved async via the adapter's getDefaultModel() (which may consult a live
 * catalog), so this is only the static fallback constant each adapter ships
 * with — enough to tell the operator what a rejected model is being replaced
 * by. Kept in sync with the adapter modules' exported DEFAULT_MODEL constants.
 */
/**
 * Roles a model can be resolved for.
 *
 * Declared here rather than imported from core/types so this module stays free
 * of a dependency cycle; `PipelineStage` must remain assignable to it, and the
 * call in pipelineRoleSelection.ts is what enforces that — a stage added there
 * without a home here is a compile error, not a silent fall to the bulk model.
 */
export type ModelRole =
  | 'worker' | 'reviewer' | 'tester' | 'documenter' | 'auditor' | 'skill-documenter'
  | 'planner' | 'orchestrator' | 'escalate';

// Verified against `cursor-agent --list-models` (2026.09.08, vela, 2026-09-10):
// all three ids are present. They are hardcoded because cursor's catalogue
// shares no id with any other provider, so nothing in the config can name them.
const CURSOR_BULK_MODEL = 'auto';
const CURSOR_JUDGE_MODEL = 'cursor-grok-4.6-high';
// A reviewer escalation has to actually escalate. Keyed separately from
// `reviewer` because a tier that resolves to the same model as the tier it
// escalates FROM is a log line claiming work that did not happen.
const CURSOR_ESCALATE_MODEL = 'cursor-grok-4.6-xhigh';

const ADAPTER_DEFAULT_MODEL: Partial<Record<AdapterName, string>> = {
  'codex-responses': 'gpt-5.6-terra',
  codex: 'gpt-5-codex',
  openrouter: 'openai/gpt-5',
  claude: 'sonnet',
  gpt: 'gpt-5',
  local: 'gpt-5',
  lmstudio: 'gpt-5',
  atlascloud: 'atlascloud/default',
};

function isAtlasCloudModel(id: string): boolean {
  // Fast path: atlascloud models always start with 'atlascloud/'
  if (id.startsWith('atlascloud/')) return true;
  // Fallback: check against the curated model list (may be stale if catalog
  // has been refreshed, but good enough for a compatibility guard).
  if (ATLASCLOUD_CURATED_MODELS.includes(id)) return true;
  // Expensive path: consult the live catalog if available.
  const catalog = readCachedCatalog('atlascloud');
  // `models` is a string[] of ids — `readCachedCatalog` filters to strings on
  // read. Treating them as `{ id }` objects made every catalog lookup miss
  // silently, which is the same class of failure this change exists to fix.
  return catalog?.models?.includes(id) ?? false;
}

/**
 * What each role runs on cursor-agent after a switch onto it.
 *
 * Bulk implementation goes to `auto`: it is the cheap, high-concurrency half of
 * the pipeline, and cursor's own router picks for it. The roles that JUDGE that
 * work get a named model, because a corrector that has silently become the same
 * model as the worker is not a corrector.
 */
const CURSOR_ROLE_MODEL: Readonly<Record<ModelRole, string>> = {
  worker: CURSOR_BULK_MODEL,
  tester: CURSOR_BULK_MODEL,
  documenter: CURSOR_BULK_MODEL,
  'skill-documenter': CURSOR_BULK_MODEL,
  reviewer: CURSOR_JUDGE_MODEL,
  auditor: CURSOR_JUDGE_MODEL,
  planner: CURSOR_JUDGE_MODEL,
  orchestrator: CURSOR_JUDGE_MODEL,
  escalate: CURSOR_ESCALATE_MODEL,
};

/** Prefixes no other provider uses, so an id pinned FOR cursor survives a switch. */
const CURSOR_OWN_ID = /^(?:auto$|(?:cursor|composer|muse)-)/;

/**
 * Ids already reported as re-routed, so a daemon running dozens of stages does
 * not repeat one line per stage. Bounded by the distinct (role, id) pairs a
 * config names, which is a handful.
 */
const announcedCursorRoutes = new Set<string>();

/** Tests need the once-per-route memory back at its initial state. */
export function resetCursorRouteNoticesForTests(): void {
  announcedCursorRoutes.clear();
}

function cursorModelForRole(current: string, role: ModelRole | undefined): string {
  // An id the operator pinned for cursor is kept: re-routing it would overwrite
  // a deliberate choice with a default.
  if (CURSOR_OWN_ID.test(current)) return current;
  // Deliberately NOT consulting the persisted cursor catalogue. "cursor-agent
  // lists it" is not "this role should run it": `gpt-5.3-codex` IS listed, so a
  // catalogue lookup would keep one config id for worker and reviewer alike and
  // collapse them again — the defect this function exists to remove, re-entering
  // through a file outside the repository that decides routing differently on
  // every machine. An id pinned FOR cursor is recognised by its prefix above,
  // which needs no ambient state.
  // `role` is always a ModelRole here, so the fallback is the `undefined` case
  // only — not a lookup miss, which `Record<ModelRole, string>` rules out.
  const routed = (role && CURSOR_ROLE_MODEL[role]) || CURSOR_BULK_MODEL;
  // Say it. Neither layer could otherwise: this returns a value, so the
  // rejection warning below never fires, and CursorCliAdapter receives an id it
  // recognises, so its own substitution notice never fires either. An operator
  // who pinned a bare id cursor-agent actually accepts would have watched it
  // become something else in complete silence — the very complaint this whole
  // change was written to answer, reproduced by the change.
  const key = `${role ?? '-'}:${current}`;
  if (!announcedCursorRoutes.has(key)) {
    announcedCursorRoutes.add(key);
    console.log(
      `[modelCompat] cursor has no id in common with other providers; `
      + `${role ?? 'unnamed role'} model ${current} routed to ${routed}`,
    );
  }
  return routed;
}

/**
 * Keep `model` only if it clearly belongs to `adapter`; otherwise return
 * undefined so the target adapter resolves its own default via
 * getDefaultModel(). No hardcoded per-provider model ids beyond stable
 * prefixes/aliases.
 *
 * When a model is rejected, logs a warning with the role (if provided),
 * the rejected model id, the adapter name, and the replacement default so the
 * operator can see what happened instead of discovering it silently at runtime.
 */
export function mapModelForProvider(
  adapter: AdapterName,
  model: string | undefined,
  role?: ModelRole,
): string | undefined {
  const current = (model || '').trim();
  if (!current) return undefined;

  const accepted = ((): string | undefined => {
    if (adapter === 'codex' || adapter === 'codex-responses' || adapter === 'cc-router') {
      // ChatGPT-account Codex only runs gpt-* slugs; anything else → adapter default.
      return current.startsWith('gpt-') ? current : undefined;
    }
    if (adapter === 'cursor') {
      // cursor-agent accepts only ids from its own catalogue. Measured on vela
      // 2026-09-10 against cursor-agent 2026.09.08: `deepseek/deepseek-v4-flash`
      // and `gpt-5-codex` abort the run outright ("Cannot use this model"), and
      // `sonnet` silently resolves to Claude Sonnet 4 — two generations behind
      // what the config asked for. Carrying the id over was never an option; it
      // only looked like one because CursorCliAdapter rewrote every id to
      // `auto` further down, so worker and reviewer collapsed onto one model
      // with nothing said anywhere. Route by role instead.
      return cursorModelForRole(current, role);
    }
    if (adapter === 'claude') {
      // The claude CLI accepts claude-* ids and version-agnostic aliases.
      return current.startsWith('claude-') || CLAUDE_ALIASES.has(current) ? current : undefined;
    }
    if (adapter === 'atlascloud') {
      // Unlike gpt-*/claude-*, Atlas ids have no shared prefix — check membership
      // against its own catalog instead.
      return isAtlasCloudModel(current) ? current : undefined;
    }
    // openrouter/gpt/local/lmstudio: a namespaced id ("vendor/model") may carry
    // over; a bare id from another provider usually won't — drop to the default.
    // Exclude ids that are recognizably Atlas Cloud's own namespace so a switch
    // away from atlascloud doesn't leak its id into these instead.
    return current.includes('/') && !isAtlasCloudModel(current) ? current : undefined;
  })();

  if (accepted === undefined) {
    const tag = role ? `Role ${role} ` : '';
    const replacement = ADAPTER_DEFAULT_MODEL[adapter] ?? 'adapter default';
    console.log(
      `[modelCompat] ${tag}model ${current} rejected for ${adapter}, using default ${replacement}`,
    );
  }

  return accepted;
}