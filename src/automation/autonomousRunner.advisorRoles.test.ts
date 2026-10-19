import { describe, expect, it } from 'vitest';
import { AutonomousRunner } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { DefaultRolesConfig } from '../core/types.js';

const resolve = (AutonomousRunner.prototype as unknown as {
  getRolesForProject(this: { config: Partial<AutonomousConfig> }, path: string): DefaultRolesConfig | undefined;
}).getRolesForProject;
const roles: DefaultRolesConfig = { worker: { enabled: true }, reviewer: { enabled: true },
  advisor: { enabled: false, model: 'global-advisor', adapter: 'codex-responses', timeoutMs: 45_000, escalateModel: 'independent-tier' } };

describe('project Recovery Advisor role resolution', () => {
  it('uses global defaults when no project override exists', () => {
    expect(resolve.call({ config: { defaultRoles: roles } }, '/repo')?.advisor).toEqual(roles.advisor);
  });

  it('merges a project advisor override with the global role policy', () => {
    const config = { defaultRoles: roles, projectAgents: [{ projectPath: '/repo', roles: { advisor: { model: 'project-advisor', adapter: 'openrouter' as const } } }] };
    expect(resolve.call({ config }, '/repo')?.advisor).toEqual({ ...roles.advisor, model: 'project-advisor', adapter: 'openrouter' });
  });

  it('retains the global advisor when another project role is overridden', () => {
    const config = { defaultRoles: roles, projectAgents: [{ projectPath: '/repo', roles: { worker: { model: 'project-worker' } } }] };
    expect(resolve.call({ config }, '/repo')?.advisor).toEqual(roles.advisor);
  });
});
