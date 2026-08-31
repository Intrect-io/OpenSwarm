import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readProviderOverrideMock = vi.hoisted(() => vi.fn());
const writeProviderOverrideMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../core/providerOverride.js', () => ({
  readProviderOverride: readProviderOverrideMock,
  writeProviderOverride: writeProviderOverrideMock,
}));
vi.mock('../core/config.js', () => ({ loadConfig: loadConfigMock }));

const selectMock = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select: selectMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/** Run the command as if attached to a terminal, then restore the real flag. */
async function withTty<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  }
}

function statsResponse(adapters: unknown) {
  return { ok: true, json: async () => ({ adapters }) };
}

describe('provider command helpers', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    selectMock.mockReset();
    readProviderOverrideMock.mockReset();
    writeProviderOverrideMock.mockReset();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({ adapter: 'codex-responses' });
  });

  describe('getProviderStatus', () => {
    it('prefers the live daemon and reports its enabled roles', async () => {
      fetchMock.mockResolvedValue(statsResponse({
        defaultAdapter: 'claude',
        worker: { adapter: 'claude', model: 'sonnet', enabled: true },
        reviewer: { adapter: 'claude', model: 'sonnet', enabled: true },
        tester: { adapter: 'claude', enabled: false },
      }));

      const { getProviderStatus } = await import('./providerCommand.js');
      const status = await getProviderStatus();

      expect(status).toMatchObject({ active: 'claude', source: 'daemon', daemonRunning: true });
      // A disabled role is not part of what the daemon is actually running.
      expect(status.roles).toEqual([
        { role: 'worker', adapter: 'claude', model: 'sonnet' },
        { role: 'reviewer', adapter: 'claude', model: 'sonnet' },
      ]);
      expect(readProviderOverrideMock).not.toHaveBeenCalled();
    });

    it('falls back to the persisted override when no daemon answers', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue('claude');

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toEqual({
        active: 'claude', source: 'override', daemonRunning: false, roles: [],
      });
    });

    it('falls back to config.yaml when there is neither a daemon nor an override', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue(undefined);

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'codex-responses', source: 'config' });
    });

    it('ignores an unknown daemon adapter name rather than reporting it as active', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'retired-provider' }));
      readProviderOverrideMock.mockReturnValue('gpt');

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'gpt', source: 'override' });
    });

    it('uses the registry default when the config is unreadable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue(undefined);
      loadConfigMock.mockImplementation(() => { throw new Error('no config.yaml'); });

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'codex', source: 'config' });
    });
  });

  describe('applyProvider', () => {
    it('switches a running daemon in place and persists the choice', async () => {
      fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ok":true}' });

      const { applyProvider } = await import('./providerCommand.js');
      const result = await applyProvider('claude');

      expect(result).toEqual({ live: true });
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/api/provider');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ provider: 'claude' });
    });

    it('persists nothing when a reachable daemon rejects the switch', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid provider' });

      const { applyProvider } = await import('./providerCommand.js');
      const result = await applyProvider('claude');

      // A written override here would describe a provider the live process is not using.
      expect(result.live).toBe(false);
      expect(result.error).toContain('400');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
    });

    it('records the override for the next boot when no daemon is reachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const { applyProvider } = await import('./providerCommand.js');

      expect(await applyProvider('claude')).toEqual({ live: false });
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
    });
  });

  describe('runProviderCommand', () => {
    it('rejects an unknown provider name against the live registry', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue('codex');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('not-a-provider')).toBe(1);
      expect(error.mock.calls[0]?.[0]).toContain('Unknown provider');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('is a no-op when the daemon already runs the requested provider', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('claude')).toBe(0);
      expect(log.mock.calls[0]?.[0]).toContain('Already running');
      // Only the status probe ran — no switch was attempted.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('switches to the provider chosen in the interactive picker', async () => {
      fetchMock
        .mockResolvedValueOnce(statsResponse({ defaultAdapter: 'codex-responses' }))
        .mockResolvedValueOnce({ ok: true, text: async () => '{"ok":true}' });
      selectMock.mockResolvedValue('claude');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');
      const code = await withTty(() => runProviderCommand(undefined));

      expect(code).toBe(0);
      // The picker offers the live registry, with the running provider preselected.
      const options = selectMock.mock.calls[0][0] as { default: string; choices: Array<{ value: string }> };
      expect(options.default).toBe('codex-responses');
      expect(options.choices.map(c => c.value)).toContain('claude');
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('running daemon is using it now');
      log.mockRestore();
    });

    it('leaves the provider untouched when the picker is cancelled', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'codex-responses' }));
      // @inquirer throws ExitPromptError on Ctrl+C rather than resolving.
      selectMock.mockRejectedValue(new Error('User force closed the prompt'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');
      const code = await withTty(() => runProviderCommand(undefined));

      expect(code).toBe(0);
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('Cancelled');
      log.mockRestore();
    });

    it('reports a no-op when the picker selects the provider already running', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));
      selectMock.mockResolvedValue('claude');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await withTty(() => runProviderCommand(undefined))).toBe(0);
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('Already running');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('fails with a nonzero code when a live daemon refuses the switch', async () => {
      fetchMock
        .mockResolvedValueOnce(statsResponse({ defaultAdapter: 'codex' }))
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Invalid provider' });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('claude')).toBe(1);
      expect(error.mock.calls[0]?.[0]).toContain('Provider switch failed');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('says the choice applies on the next start when no daemon is running', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue('codex');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('claude')).toBe(0);
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('applies on the next start');
      log.mockRestore();
    });

    it('prints status instead of prompting when stdin is not a TTY', async () => {
      fetchMock.mockResolvedValue(statsResponse({
        defaultAdapter: 'claude',
        worker: { adapter: 'claude', model: 'sonnet', enabled: true },
      }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const isTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const { runProviderCommand } = await import('./providerCommand.js');
      const code = await runProviderCommand(undefined);

      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      expect(code).toBe(0);
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('Provider: claude');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });
});

// A secured remote daemon rejects an unauthenticated read, which this command
// swallows into "no daemon" — so it would misreport the live provider and
// refuse a switch while OPENSWARM_DAEMON_TOKEN was correctly set. Every other
// CLI daemon call got the token; this one was missed until the PR-level review
// saw the whole diff.
describe('providerCommand daemon auth', () => {
  afterEach(() => {
    delete process.env.OPENSWARM_DAEMON_TOKEN;
  });

  it('presents the daemon token when reading the live provider', async () => {
    process.env.OPENSWARM_DAEMON_TOKEN = 's3cret';
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));

    const { getProviderStatus } = await import('./providerCommand.js');
    await getProviderStatus();

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-openswarm-token': 's3cret' });
  });

  it('presents the daemon token when switching the live provider', async () => {
    process.env.OPENSWARM_DAEMON_TOKEN = 's3cret';
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));

    const { applyProvider } = await import('./providerCommand.js');
    await applyProvider('claude');

    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ 'x-openswarm-token': 's3cret' });
    }
  });

  it('sends no token header when none is configured', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));

    const { getProviderStatus } = await import('./providerCommand.js');
    await getProviderStatus();

    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
});
