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
}
type RolesLike = { worker?: RoleLike; reviewer?: RoleLike } & Record<string, unknown>;

/** The part of `SwarmConfig` that decides which models the worker and reviewer resolve to. */
export interface ReviewerIndependenceConfig {
  adapter?: string;
  autonomous?: {
    allowSameFamilyReview?: boolean;
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
  for (const agent of autonomous.projectAgents ?? []) {
    if (!agent.roles?.worker && !agent.roles?.reviewer) continue;
    out.push({
      where: `autonomous.projectAgents[${agent.projectPath}].roles`,
      worker: { ...base.worker, ...agent.roles.worker },
      reviewer: { ...base.reviewer, ...agent.roles.reviewer },
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

/** Every model a role can run: its model (or its adapter's default) and its escalation model. */
function roleModels(role: RoleLike, topAdapter: string | undefined): string[] {
  const adapter = role.adapter ?? topAdapter ?? DEFAULT_ADAPTER;
  const primary = role.model ?? ADAPTER_DEFAULT_MODELS[adapter] ?? `${adapter} default model`;
  return role.escalateModel ? [primary, role.escalateModel] : [primary];
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
    const workerModels = roleModels(worker, config.adapter);
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
