import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendWebhook, type WebhookPayload } from './pairWebhook.js';

// These suites cover parsing and backend selection, not the socket layer, so
// route publicFetch onto the global fetch they stub. The real implementation —
// including the undici dispatcher contract — is covered by outboundUrl.test.ts.
vi.mock('../support/outboundUrl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/outboundUrl.js')>();
  return { ...actual, publicFetch: (url: string | URL, init?: RequestInit) => fetch(String(url), init) };
});


afterEach(() => vi.unstubAllGlobals());

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
});
