// ============================================
// OpenSwarm - Which adapters may run unattended (AGT-4444)
// ============================================
//
// Four of the worker's safeguards live in OpenSwarm's own tool loop: the
// publication fence, protected files, the role tool allow/deny list and (since
// AGT-4783/4798) the credential-free, loopback-only shell. The delegated CLI
// adapters hand the whole turn loop to another program (`claude`, `codex`,
// `cursor`), so none of those reach it — `base.ts` can only log that they were
// dropped. A daemon that routes unattended work there has no fence at all;
// `claude` even runs with `--permission-mode bypassPermissions`.
//
// Unattended means the daemon: any configured `autonomous` section, heartbeat
// on or off, because an explicit dispatch runs the same workers. The refusal is
// at startup, where it is loud, rather than at the first run, where it is a
// warning in a log nobody reads. `autonomous.allowDelegatedAdapters: true` is
// the operator's explicit acceptance of the missing fences.

/** Adapters whose CLI owns the tool loop; OpenSwarm's fences do not apply to them. */
export const DELEGATED_ADAPTERS = ['claude', 'codex', 'cursor'] as const;

/** Why `name` may not run unattended, or null when it runs OpenSwarm's own loop. */
export function unattendedAdapterViolation(name: string): string | null {
  if (!(DELEGATED_ADAPTERS as readonly string[]).includes(name)) return null;
  return `'${name}' delegates the tool loop to its own CLI, so the publication fence, protected files, `
    + 'role tool limits and the credential-free sandboxed shell do not apply to it';
}

/**
 * Why the unattended runner may not be pointed at `adapter` after startup, or null.
 *
 * `assertUnattendedAdapters` reads config.yaml once, at boot. Three things re-point every role
 * afterwards without going through it: the persisted provider override (re-applied right after the
 * assertion), `POST /api/provider` (the dashboard toggle) and `openswarm provider`. Each of them
 * has to meet the same policy, with the same opt-in, or one click undoes the refusal. (AGT-4444)
 */
export function providerSwitchViolation(
  adapter: string,
  allowDelegatedAdapters: boolean | undefined,
): string | null {
  return allowDelegatedAdapters === true ? null : unattendedAdapterViolation(adapter);
}

interface RoleLike {
  adapter?: string;
  enabled?: boolean;
  /** Worker fan-out: in `execute` mode every candidate runs a worker on its own adapter (`workerFanout.ts`). */
  fanout?: { enabled?: boolean; mode?: string; candidates?: ReadonlyArray<{ adapter?: string }> };
}
type RolesLike = Partial<Record<string, RoleLike | undefined>>;

/** The part of `SwarmConfig` that decides which adapters unattended runs can reach. */
export interface UnattendedAdapterConfig {
  adapter?: string;
  autonomous?: {
    allowDelegatedAdapters?: boolean;
    defaultRoles?: RolesLike;
    projectAgents?: Array<{ projectPath: string; roles?: RolesLike }>;
    adapterRouting?: { primary?: string; fallbacks?: readonly string[] };
    orchestrator?: { adapter?: string };
    loopAdvisor?: { adapter?: string };
  };
}

function* roleAdapters(roles: RolesLike | undefined, where: string): Generator<[string, string]> {
  for (const [role, value] of Object.entries(roles ?? {})) {
    // A role the operator switched off never runs, so neither its adapter nor its fan-out is reachable.
    if (!value || value.enabled === false) continue;
    if (value.adapter) yield [`${where}.${role}.adapter`, value.adapter];
    // A role can have no adapter of its own and still fan out. In `execute` mode each candidate runs an
    // unattended worker on its own adapter, which the role's adapter check never sees; in `report` mode
    // the gate only decides and nothing runs, so it is not reachable. (workerFanoutGate.ts)
    const fanout = value.fanout;
    if (fanout && fanout.enabled !== false && fanout.mode === 'execute') {
      for (const [i, candidate] of (fanout.candidates ?? []).entries()) {
        if (candidate.adapter) yield [`${where}.${role}.fanout.candidates[${i}].adapter`, candidate.adapter];
      }
    }
  }
}

/**
 * Every place a delegated adapter is named for unattended work, as
 * `<config path>: <reason>` lines. Empty when the operator opted in. A role that
 * names no adapter inherits the top-level one, which is checked on its own.
 */
export function collectUnattendedAdapterViolations(config: UnattendedAdapterConfig): string[] {
  const autonomous = config.autonomous;
  if (!autonomous || autonomous.allowDelegatedAdapters === true) return [];

  const named: Array<[string, string | undefined]> = [
    ['adapter', config.adapter],
    ['autonomous.adapterRouting.primary', autonomous.adapterRouting?.primary],
    ['autonomous.orchestrator.adapter', autonomous.orchestrator?.adapter],
    ['autonomous.loopAdvisor.adapter', autonomous.loopAdvisor?.adapter],
    ...(autonomous.adapterRouting?.fallbacks ?? []).map((name, i): [string, string] => [`autonomous.adapterRouting.fallbacks[${i}]`, name]),
    ...roleAdapters(autonomous.defaultRoles, 'autonomous.defaultRoles'),
    ...(autonomous.projectAgents ?? []).flatMap((agent) =>
      [...roleAdapters(agent.roles, `autonomous.projectAgents[${agent.projectPath}].roles`)]),
  ];

  const violations: string[] = [];
  for (const [where, name] of named) {
    const reason = name ? unattendedAdapterViolation(name) : null;
    if (reason) violations.push(`${where}: ${reason}`);
  }
  return violations;
}

/** Throw, naming every offending setting and the opt-out, when the daemon would route unattended work to a delegated CLI. */
export function assertUnattendedAdapters(config: UnattendedAdapterConfig): void {
  const violations = collectUnattendedAdapterViolations(config);
  if (violations.length === 0) return;
  throw new Error(
    'Refusing to start the autonomous runner on adapters that cannot be fenced:\n  - '
    + `${violations.join('\n  - ')}\n`
    + 'Use an adapter that runs OpenSwarm\'s own loop (codex-responses, openrouter, gpt, atlascloud, lmstudio, local, '
    + 'cc-router, ollama-cloud), or set autonomous.allowDelegatedAdapters: true to run unattended without those fences.',
  );
}
