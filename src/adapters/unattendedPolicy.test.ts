// ============================================
// OpenSwarm - Which adapters may run unattended (AGT-4444)
// ============================================
//
// The refusal is only worth having if it covers every place the daemon can pick
// an adapter. Each surface below is checked on its own: a policy that looked at
// `defaultRoles` but not `adapterRouting.fallbacks` would pass the first test
// and still route unattended work to a CLI that has no fences.

import { describe, expect, it } from 'vitest';
import {
  DELEGATED_ADAPTERS,
  assertUnattendedAdapters,
  collectUnattendedAdapterViolations,
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

describe('assertUnattendedAdapters', () => {
  it('does not throw for a safe config', () => {
    expect(() => assertUnattendedAdapters(safe())).not.toThrow();
  });

  it('throws naming each setting, the safe alternatives and the opt-out', () => {
    expect(() => assertUnattendedAdapters({ adapter: 'claude', autonomous: { adapterRouting: { fallbacks: ['cursor'] } } }))
      .toThrowError(/adapter: 'claude'[\s\S]*fallbacks\[0\]: 'cursor'[\s\S]*codex-responses[\s\S]*allowDelegatedAdapters: true/);
  });
});
