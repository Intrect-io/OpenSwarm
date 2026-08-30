import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendDiscordWebhook, sendWebhook, type WebhookPayload } from './pairWebhook.js';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';
import type { PairSession } from './agentPair.js';

// These suites cover parsing and backend selection, not the socket layer, so
// route publicFetch onto the global fetch they stub. The real implementation —
// including the undici dispatcher contract — is covered by outboundUrl.test.ts.
vi.mock('../support/outboundUrl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/outboundUrl.js')>();
  return { ...actual, publicFetch: (url: string | URL, init?: RequestInit) => fetch(String(url), init) };
});


afterEach(() => {
  resetHumanSurfaceReadOnlyForTests();
  vi.unstubAllGlobals();
});

const payload: WebhookPayload = {
  event: 'pair_started',
  timestamp: '2026-07-22T00:00:00.000Z',
  session: { id: 's', taskId: 't', taskTitle: 'task', status: 'running', attempts: 1, maxAttempts: 2, durationMs: 0 },
};

describe('sendWebhook', () => {
  it('passes a bounded signal and cancels an unread response body', async () => {
    const cancel = vi.fn(async () => {});
    const response = { ok: false, status: 500, statusText: 'bad', body: { cancel } } as unknown as Response;
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendWebhook('https://example.com/hook', payload)).resolves.toMatchObject({ success: false, statusCode: 500 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not call generic or Discord webhooks in strict mode', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    enableHumanSurfaceReadOnly();

    await expect(sendWebhook('https://example.com/hook', payload))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
    await expect(sendDiscordWebhook('https://discord.com/api/webhooks/1/x', {
      id: 's', taskId: 't', taskTitle: 'task', status: 'running',
      worker: { attempts: 1, maxAttempts: 2 }, reviewer: {},
    } as PairSession, 'blocked', 0))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
