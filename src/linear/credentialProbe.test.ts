import { describe, expect, it } from 'vitest';
import { probeCondemnsKey, probeLinearApiKey } from './credentialProbe.js';

const respond = (status: number, body: string) =>
  (async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

describe('probeLinearApiKey (AGT-4028)', () => {
  it('sends the key as the raw Authorization value and reads the viewer back', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ data: { viewer: { name: 'Heewon Oh' } } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await probeLinearApiKey('lin_api_x', fetchImpl)).toEqual({ ok: true, viewer: 'Heewon Oh' });
    expect((seen!.headers as Record<string, string>).Authorization).toBe('lin_api_x');
  });

  it('condemns a key Linear rejects (401 / 400 bearer misuse) but not a probe that never reached Linear', async () => {
    const rejected = await probeLinearApiKey('dead', respond(401, '{"errors":[{"message":"Authentication required, not authenticated"}]}'));
    expect(rejected.ok).toBe(false);
    expect(probeCondemnsKey(rejected)).toBe(true);

    const bearer = await probeLinearApiKey('oauth', respond(400, '{"errors":[{"message":"trying to use an API key as a Bearer token"}]}'));
    expect(probeCondemnsKey(bearer)).toBe(true);

    const offline = await probeLinearApiKey('maybe-good', (async () => { throw new Error('ENOTFOUND api.linear.app'); }) as unknown as typeof fetch);
    expect(offline).toMatchObject({ ok: false, reason: expect.stringContaining('probe did not complete') });
    expect(probeCondemnsKey(offline)).toBe(false);

    const outage = await probeLinearApiKey('maybe-good', respond(503, 'upstream'));
    expect(probeCondemnsKey(outage)).toBe(false);
  });
});
