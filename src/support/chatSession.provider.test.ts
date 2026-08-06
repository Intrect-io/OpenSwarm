import { describe, it, expect, vi, beforeEach } from 'vitest';

const readProviderOverrideMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../core/providerOverride.js', () => ({
  readProviderOverride: readProviderOverrideMock,
}));

vi.mock('../core/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('./chatBackend.js', () => ({
  getDefaultChatModel: (p: string) => `default-${p}`,
  runChatCompletion: vi.fn(),
}));

import { loadDefaultProvider } from './chatSession.js';

describe('loadDefaultProvider (INT-3284)', () => {
  beforeEach(() => {
    readProviderOverrideMock.mockReset();
    loadConfigMock.mockReset();
  });

  it('prefers provider-override.json over config.yaml', () => {
    readProviderOverrideMock.mockReturnValue('claude');
    loadConfigMock.mockReturnValue({ adapter: 'codex-responses' });
    expect(loadDefaultProvider()).toBe('claude');
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it('falls back to config.yaml when no override exists', () => {
    readProviderOverrideMock.mockReturnValue(undefined);
    loadConfigMock.mockReturnValue({ adapter: 'openrouter' });
    expect(loadDefaultProvider()).toBe('openrouter');
  });
});
