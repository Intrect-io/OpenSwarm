import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveOpenRouterApiKeyMock = vi.hoisted(() => vi.fn());
const loginAndSaveOpenRouterProfileMock = vi.hoisted(() => vi.fn());
const passwordMock = vi.hoisted(() => vi.fn());

vi.mock('../auth/openrouterPkce.js', () => ({
  saveOpenRouterApiKey: saveOpenRouterApiKeyMock,
  loginAndSaveOpenRouterProfile: loginAndSaveOpenRouterProfileMock,
}));
vi.mock('@inquirer/prompts', () => ({ password: passwordMock }));

import { handleAuthLogin, resolveOpenRouterLoginPath } from './authHandler.js';

const DESKTOP_ENV = { DISPLAY: ':0' } as NodeJS.ProcessEnv;

describe('resolveOpenRouterLoginPath', () => {
  it('prefers an env key over every other method', () => {
    expect(resolveOpenRouterLoginPath({ method: 'oauth' }, {
      ...DESKTOP_ENV,
      OPENROUTER_API_KEY: 'sk-or-env',
    })).toBe('env-key');
    expect(resolveOpenRouterLoginPath({ method: 'key' }, {
      OPENROUTER_API: 'sk-or-legacy',
    })).toBe('env-key');
  });

  it('uses a hidden key prompt when --method key is set', () => {
    expect(resolveOpenRouterLoginPath({ method: 'key' }, DESKTOP_ENV)).toBe('prompt-key');
  });

  it('uses PKCE when --method oauth is set even over SSH', () => {
    expect(resolveOpenRouterLoginPath({ method: 'oauth' }, {
      SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22',
    })).toBe('oauth');
  });

  it('defaults to a key prompt on SSH rather than waiting for a browser', () => {
    expect(resolveOpenRouterLoginPath({ method: 'auto' }, {
      SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22',
      DISPLAY: ':0',
    })).toBe('prompt-key');
  });

  it('defaults to PKCE on a graphical desktop', () => {
    if (process.platform !== 'linux') return;
    expect(resolveOpenRouterLoginPath({ method: 'auto' }, DESKTOP_ENV)).toBe('oauth');
  });
});

describe('handleAuthLogin openrouter', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    saveOpenRouterApiKeyMock.mockReset();
    loginAndSaveOpenRouterProfileMock.mockReset();
    passwordMock.mockReset();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    delete process.env.OPENSWARM_HEADLESS;
    process.env.DISPLAY = ':0';
    process.env.WAYLAND_DISPLAY = 'wayland-0';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it('stores OPENROUTER_API_KEY without starting PKCE', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-from-env';
    await handleAuthLogin('openrouter', { method: 'oauth' });
    expect(saveOpenRouterApiKeyMock).toHaveBeenCalledWith('sk-or-from-env');
    expect(loginAndSaveOpenRouterProfileMock).not.toHaveBeenCalled();
    expect(passwordMock).not.toHaveBeenCalled();
  });

  it('skips PKCE for --method key and prompts for a hidden key', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    passwordMock.mockResolvedValue('sk-or-pasted');
    await handleAuthLogin('openrouter', { method: 'key' });
    expect(loginAndSaveOpenRouterProfileMock).not.toHaveBeenCalled();
    expect(passwordMock).toHaveBeenCalled();
    expect(saveOpenRouterApiKeyMock).toHaveBeenCalledWith('sk-or-pasted');
  });

  it('skips PKCE on SSH auto login', async () => {
    process.env.SSH_CONNECTION = '10.0.0.1 22 10.0.0.2 22';
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    passwordMock.mockResolvedValue('sk-or-ssh');
    await handleAuthLogin('openrouter', { method: 'auto' });
    expect(loginAndSaveOpenRouterProfileMock).not.toHaveBeenCalled();
    expect(saveOpenRouterApiKeyMock).toHaveBeenCalledWith('sk-or-ssh');
  });
});
