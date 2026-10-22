// ============================================
// OpenSwarm - Which adapters may run unattended (AGT-4444)
// ============================================
//
// The refusal is only worth having if it covers every place the daemon can pick
// an adapter. Each surface below is checked on its own: a policy that looked at
// `defaultRoles` but not `adapterRouting.fallbacks` would pass the first test
// and still route unattended work to a CLI that has no fences.

import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import {
  DELEGATED_ADAPTERS,
  assertUnattendedAdapters,
  collectUnattendedAdapterViolations,
  providerSwitchViolation,
  unattendedAdapterViolation,
  type UnattendedAdapterConfig,
} from './unattendedPolicy.js';
import { ADAPTER_NAMES } from '../core/adapterNames.js';

const safe = (autonomous: NonNullable<UnattendedAdapterConfig['autonomous']> = {}): UnattendedAdapterConfig => ({
  adapter: 'codex-responses',
  autonomous,
});

describe('unattendedAdapterViolation', () => {
  it('refuses exactly the adapters whose CLI owns the tool loop', () => {
    for (const name of DELEGATED_ADAPTERS) expect(unattendedAdapterViolation(name)).toContain(`'${name}'`);
    const inProcess = ADAPTER_NAMES.filter((name) => !(DELEGATED_ADAPTERS as readonly string[]).includes(name));
    expect(inProcess.length).toBeGreaterThan(0);
    for (const name of inProcess) expect(unattendedAdapterViolation(name), name).toBeNull();
  });

  it('only names adapters that exist, so a rename cannot silently empty the list', () => {
    for (const name of DELEGATED_ADAPTERS) expect(ADAPTER_NAMES).toContain(name);
  });
});

describe('collectUnattendedAdapterViolations', () => {
  it('is quiet for a config that stays on OpenSwarm\'s own loop', () => {
    expect(collectUnattendedAdapterViolations(safe({
      defaultRoles: { worker: { adapter: 'openrouter', enabled: true }, reviewer: { adapter: 'codex-responses' } },
      adapterRouting: { primary: 'codex-responses', fallbacks: ['cc-router', 'codex-responses'] },
    }))).toEqual([]);
  });

  it('is quiet when there is no autonomous section — an interactive CLI is attended', () => {
    expect(collectUnattendedAdapterViolations({ adapter: 'claude' })).toEqual([]);
  });

  it.each([
    ['the top-level adapter', { adapter: 'claude', autonomous: {} }, 'adapter:'],
    ['a default role', safe({ defaultRoles: { worker: { adapter: 'cursor', enabled: true } } }), 'autonomous.defaultRoles.worker.adapter'],
    ['a project role override', safe({ projectAgents: [{ projectPath: '/p', roles: { reviewer: { adapter: 'codex' } } }] }), 'autonomous.projectAgents[/p].roles.reviewer.adapter'],
    ['the routing primary', safe({ adapterRouting: { primary: 'claude' } }), 'autonomous.adapterRouting.primary'],
    ['a routing fallback', safe({ adapterRouting: { fallbacks: ['cc-router', 'cursor'] } }), 'autonomous.adapterRouting.fallbacks[1]'],
    ['the orchestrator', safe({ orchestrator: { adapter: 'codex' } }), 'autonomous.orchestrator.adapter'],
    ['the loop advisor', safe({ loopAdvisor: { adapter: 'claude' } }), 'autonomous.loopAdvisor.adapter'],
  ] as const)('catches a delegated adapter in %s', (_label, config, where) => {
    const violations = collectUnattendedAdapterViolations(config as UnattendedAdapterConfig);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(where);
  });

  it('reports every offending setting, not just the first', () => {
    const violations = collectUnattendedAdapterViolations({
      adapter: 'claude',
      autonomous: {
        defaultRoles: { worker: { adapter: 'cursor' } },
        adapterRouting: { fallbacks: ['codex'] },
      },
    });
    expect(violations).toHaveLength(3);
  });

  it('skips a role the operator switched off, which never runs', () => {
    expect(collectUnattendedAdapterViolations(safe({
      defaultRoles: { advisor: { adapter: 'claude', enabled: false } },
    }))).toEqual([]);
  });

  it('accepts everything once the operator opts in', () => {
    expect(collectUnattendedAdapterViolations({
      adapter: 'claude',
      autonomous: { allowDelegatedAdapters: true, defaultRoles: { worker: { adapter: 'cursor' } } },
    })).toEqual([]);
  });

  it('treats only an explicit true as an opt-in', () => {
    for (const value of [false, undefined]) {
      expect(collectUnattendedAdapterViolations({ adapter: 'claude', autonomous: { allowDelegatedAdapters: value } })).toHaveLength(1);
    }
  });
});

describe('worker fan-out candidates', () => {
  // `candidates[].adapter` accepts any adapter. In `execute` mode runWorkerFanout runs each candidate as an
  // unattended worker on that adapter, so a delegated CLI there is the same hole as `role.adapter`.
  const fanout = (over: Record<string, unknown> = {}) => ({
    mode: 'execute', candidates: [{ adapter: 'openrouter' }, { adapter: 'claude' }], ...over,
  });

  it('refuses a delegated candidate in execute mode, naming the candidate, for a default and a project role', () => {
    const viaDefault = collectUnattendedAdapterViolations(safe({ defaultRoles: { worker: { fanout: fanout() } } }));
    expect(viaDefault).toHaveLength(1);
    expect(viaDefault[0]).toContain('autonomous.defaultRoles.worker.fanout.candidates[1].adapter');
    const viaProject = collectUnattendedAdapterViolations(safe({
      projectAgents: [{ projectPath: '/repo', roles: { worker: { fanout: fanout() } } }],
    }));
    expect(viaProject[0]).toContain('autonomous.projectAgents[/repo].roles.worker.fanout.candidates[1].adapter');
  });

  it('still checks a role that names no adapter of its own', () => {
    // The role-level check skipped any role without `adapter`, which is where a fan-out-only role lives.
    const violations = collectUnattendedAdapterViolations(safe({
      defaultRoles: { worker: { adapter: undefined, fanout: fanout({ candidates: [{ adapter: 'cursor' }] }) } },
    }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'cursor'");
  });

  it('lets through what cannot run: report mode, a disabled fan-out, a disabled role, or in-process candidates', () => {
    expect(collectUnattendedAdapterViolations(safe({ defaultRoles: { worker: { fanout: fanout({ mode: 'report' }) } } }))).toEqual([]);
    expect(collectUnattendedAdapterViolations(safe({ defaultRoles: { worker: { fanout: fanout({ enabled: false }) } } }))).toEqual([]);
    expect(collectUnattendedAdapterViolations(safe({ defaultRoles: { worker: { enabled: false, fanout: fanout() } } }))).toEqual([]);
    expect(collectUnattendedAdapterViolations(safe({
      defaultRoles: { worker: { fanout: fanout({ candidates: [{ adapter: 'openrouter' }, { adapter: 'codex-responses' }, {}] }) } },
    }))).toEqual([]);
  });

  it('honours the opt-in', () => {
    expect(collectUnattendedAdapterViolations(safe({ allowDelegatedAdapters: true, defaultRoles: { worker: { fanout: fanout() } } }))).toEqual([]);
  });
});

describe('providerSwitchViolation', () => {
  // assertUnattendedAdapters reads config.yaml once, at boot. The provider override, the dashboard toggle
  // and `openswarm provider` re-point every role afterwards, so they meet the same policy and opt-in.
  it('refuses a delegated CLI and lets an in-process adapter through, unless the operator opted in', () => {
    for (const name of DELEGATED_ADAPTERS) {
      expect(providerSwitchViolation(name, false), name).toContain(`'${name}'`);
      expect(providerSwitchViolation(name, undefined), `${name} unset is not an opt-in`).not.toBeNull();
      expect(providerSwitchViolation(name, true), `${name} opted in`).toBeNull();
    }
    expect(providerSwitchViolation('codex-responses', false)).toBeNull();
    expect(providerSwitchViolation('openrouter', undefined)).toBeNull();
  });
});

describe('the shipped example config', () => {
  it('passes the policy it ships next to', () => {
    // `cp config.example.yaml config.yaml` is the documented install (README, docker-compose). Its
    // adapterRouting once listed `cursor` as a fallback, which this policy refuses, so a deployment
    // copied from the example never came up. The refusal happens only after the web server, Discord
    // and the scheduler have started, and nothing else loads the example through the policy.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = loadConfig(fileURLToPath(new URL('../../config.example.yaml', import.meta.url)));
      expect(config.autonomous).toBeDefined();
      expect(collectUnattendedAdapterViolations(config)).toEqual([]);
      expect(() => assertUnattendedAdapters(config)).not.toThrow();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('assertUnattendedAdapters', () => {
  it('does not throw for a safe config', () => {
    expect(() => assertUnattendedAdapters(safe())).not.toThrow();
  });

  it('throws naming each setting, the safe alternatives and the opt-out', () => {
    expect(() => assertUnattendedAdapters({ adapter: 'claude', autonomous: { adapterRouting: { fallbacks: ['cursor'] } } }))
      .toThrowError(/adapter: 'claude'[\s\S]*fallbacks\[0\]: 'cursor'[\s\S]*codex-responses[\s\S]*allowDelegatedAdapters: true/);
  });
});
