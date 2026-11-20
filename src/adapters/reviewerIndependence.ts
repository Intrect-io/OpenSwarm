// ============================================
// OpenSwarm - The reviewer must not share the worker's model family (AGT-4806)
// ============================================
//
// A reviewer from the worker's own model family shares its blind spots: the
// same training data, the same habits, the same things it does not notice. A
// pair from one family can agree with itself and call that review. So in
// unattended runs the reviewer's resolved model family must differ from the
// worker's, checked where the daemon starts, next to the adapter policy
// (`unattendedPolicy.ts`), so a mismatch is loud before anything runs.
//
// "Resolved" means what would actually run: the role's own model, else the
// default model of the role's adapter, else of the top-level adapter. The
// worker's escalation model counts as a worker model, and the reviewer's as a
// reviewer model — escalation is the moment the pair matters most.
//
// A family the table below cannot name is UNKNOWN, and unknown fails like the
// same family: independence has to be shown, not assumed. An operator who runs
// a single provider on purpose sets `autonomous.allowSameFamilyReview: true`.

/** Model-id fragments → family. Order matters only where fragments overlap. */
const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|anthropic|^(?:sonnet|opus|haiku)(?:[-.@]|$)/i, 'anthropic'],
  [/(?:^|\/)(?:gpt|chatgpt|o[1-9](?:-|$)|codex)|openai/i, 'openai'],
  [/gemini|gemma|(?:^|\/)google\//i, 'google'],
  [/deepseek/i, 'deepseek'],
  [/qwen|qwq|alibaba/i, 'qwen'],
  [/llama|meta-llama/i, 'meta'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/i, 'mistral'],
  [/grok|(?:^|\/)x-ai\//i, 'xai'],
  [/kimi|moonshot/i, 'moonshot'],
  [/(?:^|[/-])glm|zhipu|(?:^|\/)z-ai\//i, 'zhipu'],
  [/minimax/i, 'minimax'],
];

/**
 * Each adapter's default model when a role names none. Kept as literals so
 * this module imports no adapter (several start processes at import time);
 * `reviewerIndependence.test.ts` pins every entry to the adapter's exported
 * constant, so a changed default fails a test instead of drifting here.
 * `lmstudio`, `cc-router` and `cursor` have no fixed default: unknown.
 */
export const ADAPTER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  claude: 'sonnet',
  codex: 'gpt-5-codex',
  'codex-responses': 'gpt-5.6-terra',
  gpt: 'gpt-5.6-terra',
  openrouter: 'deepseek/deepseek-v4-flash',
  atlascloud: 'deepseek-ai/deepseek-v4-pro',
  local: 'gemma3:4b',
  'ollama-cloud': 'deepseek-v4.1-flash',
};

/** The adapter the config falls back to when it names none (config.ts). */
const DEFAULT_ADAPTER = 'codex-responses';

/**
 * Adapters whose default is not a fixed id: `local` runs whatever model its
 * server reports first. Their default counts as unknown. (#886 review)
 */
const VARIABLE_DEFAULT_ADAPTERS: ReadonlySet<string> = new Set(['local']);

/** The worker's built-in second opinion (workerEscalation.ts), applied even with no escalateModel set. */
export const IMPLICIT_WORKER_ESCALATION: Readonly<Record<string, string>> = {
  'deepseek/deepseek-v4-flash': 'z-ai/glm-5.3-flash',
};

/**
 * The model an adapter will actually run for a configured id, mirroring
 * modelCompat's mapModelForProvider: an id the adapter cannot run is dropped
 * and the adapter's default runs instead. The test pins this mirror to
 * mapModelForProvider. (#886 review: `adapter: codex-responses` with a
 * reviewer of `anthropic/claude-sonnet-4` read as independent, then ran the
 * worker's gpt default.)
 */
export function compatibleModel(adapter: string, model: string | undefined): string | undefined {
  const current = (model ?? '').trim();
  if (!current) return undefined;
  if (adapter === 'codex' || adapter === 'codex-responses' || adapter === 'cc-router') return current.startsWith('gpt-') ? current : undefined;
  if (adapter === 'cursor') return undefined;
  if (adapter === 'claude') return /^(?:claude-|sonnet|opus|haiku)/i.test(current) ? current : undefined;
  return current;
}

function resolvedModel(adapter: string, model: string | undefined): string {
  return compatibleModel(adapter, model)
    ?? (VARIABLE_DEFAULT_ADAPTERS.has(adapter) ? undefined : ADAPTER_DEFAULT_MODELS[adapter])
    ?? `${adapter} default model`;
}

/** The model family of a model id, or null when the table cannot name it. */
export function modelFamily(model: string | undefined): string | null {
  if (!model) return null;
  for (const [pattern, family] of MODEL_FAMILIES) {
    if (pattern.test(model)) return family;
  }
  return null;
}

interface RoleLike {
  enabled?: boolean;
  adapter?: string;
  model?: string;
  escalateModel?: string;
  /** Fan-out candidates run as the worker in execute mode. */
  fanout?: { enabled?: boolean; mode?: string; candidates?: Array<{ adapter?: string; model?: string }> };
}
type RolesLike = { worker?: RoleLike; reviewer?: RoleLike } & Record<string, unknown>;

/** The part of `SwarmConfig` that decides which models the worker and reviewer resolve to. */
export interface ReviewerIndependenceConfig {
  adapter?: string;
  autonomous?: {
    allowSameFamilyReview?: boolean;
    /** Adapters the worker falls back to on quota/infra/capability failures. */
    adapterRouting?: { fallbacks?: readonly string[] };
    defaultRoles?: RolesLike;
    projectAgents?: Array<{ projectPath: string; roles?: RolesLike }>;
    models?: { worker?: string; reviewer?: string };
    jobProfiles?: Array<{ name: string; roles?: Partial<Record<string, string>> }>;
  };
}

interface ResolvedPair {
  where: string;
  worker: RoleLike;
  reviewer: RoleLike;
}

/** What the runner resolves for one scope; mirrors `getRolesForProject`'s merge. */
function pairs(config: ReviewerIndependenceConfig): ResolvedPair[] {
  const autonomous = config.autonomous ?? {};
  const base: { worker: RoleLike; reviewer: RoleLike } = autonomous.defaultRoles
    ? { worker: autonomous.defaultRoles.worker ?? {}, reviewer: autonomous.defaultRoles.reviewer ?? {} }
    // Legacy `models:` block, as getRolesForProject converts it.
    : { worker: { model: autonomous.models?.worker }, reviewer: { model: autonomous.models?.reviewer } };
  const out: ResolvedPair[] = [{ where: autonomous.defaultRoles ? 'autonomous.defaultRoles' : 'autonomous (default roles)', ...base }];
  // Per-project roles merge onto defaultRoles; without defaultRoles the runner
  // merges them onto roles with no model (the adapter default), not onto the
  // legacy `models:` block (getRolesForProject). (#886 review)
  const projectBase = autonomous.defaultRoles ? base : { worker: {}, reviewer: {} };
  for (const agent of autonomous.projectAgents ?? []) {
    if (!agent.roles?.worker && !agent.roles?.reviewer) continue;
    out.push({
      where: `autonomous.projectAgents[${agent.projectPath}].roles`,
      worker: { ...projectBase.worker, ...agent.roles.worker },
      reviewer: { ...projectBase.reviewer, ...agent.roles.reviewer },
    });
  }
  // A job profile replaces the stage MODEL only; the adapter stays the role's.
  for (const profile of autonomous.jobProfiles ?? []) {
    const worker = profile.roles?.worker;
    const reviewer = profile.roles?.reviewer;
    if (!worker && !reviewer) continue;
    out.push({
      where: `autonomous.jobProfiles[${profile.name}]`,
      worker: worker ? { ...base.worker, model: worker, escalateModel: undefined } : base.worker,
      reviewer: reviewer ? { ...base.reviewer, model: reviewer, escalateModel: undefined } : base.reviewer,
    });
  }
  return out;
}

/**
 * Every model a role can run: its model as its adapter runs it (or the adapter's
 * default), its escalation model, and — for the worker — the built-in
 * escalation, the routing fallbacks and the execute-mode fan-out candidates.
 */
function roleModels(role: RoleLike, topAdapter: string | undefined, worker?: { fallbacks?: readonly string[] }): string[] {
  const adapter = role.adapter ?? topAdapter ?? DEFAULT_ADAPTER;
  const primary = resolvedModel(adapter, role.model);
  const models = [primary];
  const escalate = role.escalateModel ?? (worker ? IMPLICIT_WORKER_ESCALATION[primary] : undefined);
  if (escalate) models.push(resolvedModel(adapter, escalate));
  if (worker) {
    for (const fallback of worker.fallbacks ?? []) models.push(resolvedModel(fallback, role.model));
    if (role.fanout?.enabled !== false && role.fanout?.mode === 'execute') {
      for (const candidate of role.fanout.candidates ?? []) {
        models.push(resolvedModel(candidate.adapter ?? adapter, candidate.model ?? role.model));
      }
    }
  }
  return [...new Set(models)];
}

function describeModel(model: string): string {
  return `'${model}' (${modelFamily(model) ?? 'unknown family'})`;
}

/**
 * Every scope where the reviewer could run on the worker's model family, as
 * `<config path>: <reason>` lines. Empty when the operator opted out.
 */
export function collectReviewerFamilyViolations(config: ReviewerIndependenceConfig): string[] {
  const autonomous = config.autonomous;
  if (!autonomous || autonomous.allowSameFamilyReview === true) return [];
  const violations: string[] = [];
  for (const { where, worker, reviewer } of pairs(config)) {
    // A disabled reviewer ROLE still reviews: the PR-time fresh review, on by
    // default for every repository, runs on the reviewer role's adapter and
    // model whatever its `enabled` says (publicationReviewBudget.ts). Only a
    // disabled worker means nothing in this scope is produced to review.
    if (worker.enabled === false) continue;
    const workerModels = roleModels(worker, config.adapter, { fallbacks: autonomous.adapterRouting?.fallbacks ?? [] });
    const reviewerModels = roleModels(reviewer, config.adapter);
    for (const reviewerModel of reviewerModels) {
      const reviewerFamily = modelFamily(reviewerModel);
      for (const workerModel of workerModels) {
        const workerFamily = modelFamily(workerModel);
        if (reviewerFamily && workerFamily && reviewerFamily !== workerFamily) continue;
        const why = !reviewerFamily || !workerFamily
          ? 'cannot be shown to be a different model family'
          : 'is the same model family';
        violations.push(`${where}: reviewer ${describeModel(reviewerModel)} ${why} as worker ${describeModel(workerModel)}`);
      }
    }
  }
  return violations;
}

/** Throw, naming every offending scope and the opt-out, when a reviewer would review its own family's work. */
export function assertIndependentReviewer(config: ReviewerIndependenceConfig): void {
  const violations = collectReviewerFamilyViolations(config);
  if (violations.length === 0) return;
  throw new Error(
    'Refusing to start the autonomous runner with a reviewer from the worker\'s model family (AGT-4806):\n  - '
    + `${violations.join('\n  - ')}\n`
    + 'Give the reviewer a model from another family (set defaultRoles.reviewer.adapter/model, e.g. an openrouter '
    + 'model of another vendor), or set autonomous.allowSameFamilyReview: true to accept a same-family review.',
  );
}

/**
 * The same check for the roles a provider switch would produce: the switch
 * re-points every role to `adapter` and keeps only models that adapter runs
 * (autonomousRunner.applyProviderConfig). A persisted override is applied after
 * the startup check, and the dashboard toggle at any time, so both are checked
 * here. (#886 review)
 */
export function reviewerFamilyViolationsForProvider(config: ReviewerIndependenceConfig, adapter: string): string[] {
  const autonomous = config.autonomous;
  if (!autonomous) return [];
  const repoint = (roles: RolesLike | undefined): RolesLike | undefined => roles && {
    ...roles,
    ...(roles.worker ? { worker: { ...roles.worker, adapter } } : {}),
    ...(roles.reviewer ? { reviewer: { ...roles.reviewer, adapter } } : {}),
  };
  return collectReviewerFamilyViolations({
    adapter,
    autonomous: {
      ...autonomous,
      defaultRoles: repoint(autonomous.defaultRoles),
      projectAgents: autonomous.projectAgents?.map((agent) => ({ ...agent, roles: repoint(agent.roles) })),
    },
  });
}

let registered: ReviewerIndependenceConfig | null = null;

/** The daemon registers its config once at start, for checks that run later (a provider switch). */
export function registerReviewerIndependenceConfig(config: ReviewerIndependenceConfig | null): void {
  registered = config;
}

/** Why switching the autonomous runner to `adapter` would break reviewer independence, or null. */
export function providerSwitchFamilyViolation(adapter: string, config: ReviewerIndependenceConfig | null = registered): string | null {
  if (!config) return null;
  const violations = reviewerFamilyViolationsForProvider(config, adapter);
  return violations.length > 0
    ? `the reviewer would share the worker's model family (AGT-4806): ${violations.join('; ')}`
    : null;
}
