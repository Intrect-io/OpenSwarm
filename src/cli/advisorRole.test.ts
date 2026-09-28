// ============================================
// OpenSwarm - `advisor` role resolution tests
// ============================================
//
// Two seams, because the module has two jobs and only one of them is visible in
// a return value. The role itself is injected (`deps.loadConfig`), the way
// `reviewAdvisor.test.ts` injects `spawnCli` — so every branch is a pure
// function of the returned role and no config file is needed. The module's
// other job is what it does to the process: `loadConfig` writes to stdout, and
// the caller may be assembling a `--json` document, so the console is stubbed
// here too. `vi.mock` supplies the default (no-args) path because that is the
// path the CLI wiring takes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));

vi.mock('../core/config.js', () => ({ loadConfig }));

import { resolveAdvisorRole } from './advisorRole.js';
import type { RoleConfig } from '../core/types.js';

/** A resolved (zod-defaulted) role, which is what `loadConfig` hands back. */
function role(over: Partial<RoleConfig> = {}): RoleConfig {
  return { enabled: true, model: 'z-ai/glm-5.2', timeoutMs: 45_000, ...over };
}

const withRole = (advisor?: RoleConfig) => () => ({ autonomous: { defaultRoles: { advisor } } });

describe('resolveAdvisorRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue(withRole(role())());
  });

  it('hands the review paths the configured model and timeout', async () => {
    expect(await resolveAdvisorRole({ loadConfig: withRole(role()) }))
      .toEqual({ model: 'z-ai/glm-5.2', timeoutMs: 45_000 });
  });

  it('resolves through the real config module when no loader is injected', async () => {
    expect(await resolveAdvisorRole()).toEqual({ model: 'z-ai/glm-5.2', timeoutMs: 45_000 });
    expect(loadConfig).toHaveBeenCalled();
  });

  it('is undefined when the operator left the advisor disabled — the pass costs nothing', async () => {
    expect(await resolveAdvisorRole({ loadConfig: withRole(role({ enabled: false })) })).toBeUndefined();
  });

  it('is undefined when the role is absent, so an unconfigured install pays no call', async () => {
    expect(await resolveAdvisorRole({ loadConfig: withRole(undefined) })).toBeUndefined();
  });

  it('is undefined rather than a throw when config cannot be read', async () => {
    const unreadable = () => { throw new Error('Config file not found'); };
    await expect(resolveAdvisorRole({ loadConfig: unreadable })).resolves.toBeUndefined();
  });
});

describe('resolveAdvisorRole — the console stays clean for `--json`', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('swallows the log lines loadConfig writes, which would break `openswarm review --json | jq`', async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const noise: string[] = [];
    console.log = (...args: unknown[]) => { noise.push(`log:${args.join(' ')}`); };
    console.warn = (...args: unknown[]) => { noise.push(`warn:${args.join(' ')}`); };

    try {
      // A loaded config announces itself before returning, exactly as the real one does.
      const noisy = () => {
        console.log('[Config] loading from /repo/config.yaml');
        console.warn('[Config] Discord credentials not set — disabling Discord integration');
        return withRole(role())();
      };
      expect(await resolveAdvisorRole({ loadConfig: noisy }))
        .toEqual({ model: 'z-ai/glm-5.2', timeoutMs: 45_000 });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(noise).toEqual([]);
  });

  it('restores both console methods on the failure path too', async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    // Silence has to be in force DURING the call and lifted after it, including
    // when the loader throws — otherwise a `--json` run that cannot read config
    // both prints the error's context and loses the operator's own log routing.
    let silencedDuringLoad = false;

    await resolveAdvisorRole({
      loadConfig: () => {
        silencedDuringLoad = console.log !== originalLog && console.warn !== originalWarn;
        throw new Error('unreadable');
      },
    });

    expect(silencedDuringLoad).toBe(true);
    expect(console.log).toBe(originalLog);
    expect(console.warn).toBe(originalWarn);
  });
});
