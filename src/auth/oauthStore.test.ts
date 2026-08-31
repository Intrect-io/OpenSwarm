// ============================================
// OpenSwarm - auth profile store tests
// ============================================
//
// The store keeps every provider's credentials in one file, which made its
// failure modes shared: a malformed profile written by one provider used to
// fail the whole-file check and quarantine the file, logging the user out of
// every other provider too. These tests pin the blast radius.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

/** Load a fresh copy of the module with homedir() pointed at a temp directory. */
async function loadModule() {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
  });
  return await import('./oauthStore.js');
}

const storePath = () => join(home, '.openswarm', 'auth-profiles.json');

const validProfile = (over: Record<string, unknown> = {}) => ({
  type: 'oauth',
  provider: 'openai-gpt',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 4_000_000_000_000,
  clientId: 'client',
  ...over,
});

function writeStore(profiles: Record<string, unknown>, version: unknown = 1): void {
  mkdirSync(join(home, '.openswarm'), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ version, profiles }, null, 2));
}

function readStore(): { profiles: Record<string, { access: string; refresh: string }> } {
  return JSON.parse(readFileSync(storePath(), 'utf-8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openswarm-auth-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.doUnmock('node:os');
  vi.restoreAllMocks();
});

describe('AuthProfileStore.load', () => {
  it('reads back the profiles it was given', async () => {
    writeStore({ 'gpt:default': validProfile() });
    const { AuthProfileStore } = await loadModule();
    expect(new AuthProfileStore().getProfile('gpt:default')).toMatchObject({ access: 'access-token' });
  });

  // The regression this whole change is about: one provider's malformed entry
  // must not cost the user their other providers' credentials.
  it('keeps the good profiles when one is malformed', async () => {
    writeStore({
      'gpt:default': validProfile(),
      // What an unvalidated token response used to persist.
      'linear:default': validProfile({ provider: 'linear', access: undefined, expires: Number.NaN }),
    });
    const { AuthProfileStore } = await loadModule();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new AuthProfileStore();

    expect(store.getProfile('gpt:default')).toMatchObject({ access: 'access-token' });
    expect(store.getProfile('linear:default')).toBeNull();
    expect(existsSync(storePath())).toBe(true);
    expect(readdirSync(join(home, '.openswarm')).filter((f) => f.includes('.corrupt-'))).toEqual([]);
  });

  it('says which profiles it dropped so the user can re-auth just those', async () => {
    writeStore({ 'gpt:default': validProfile(), 'linear:default': { provider: 'linear' } });
    const { AuthProfileStore } = await loadModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new AuthProfileStore();

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('linear:default');
  });

  // Quarantine is still right when there is genuinely nothing to salvage.
  it.each([
    ['unparseable JSON', () => { mkdirSync(join(home, '.openswarm'), { recursive: true }); writeFileSync(storePath(), '{ not json'); }],
    ['a wrong schema version', () => writeStore({ 'gpt:default': validProfile() }, 2)],
  ])('quarantines the file on %s', async (_label, corrupt) => {
    corrupt();
    const { AuthProfileStore } = await loadModule();

    expect(() => new AuthProfileStore()).toThrow(/corrupt/);
    expect(readdirSync(join(home, '.openswarm')).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('starts empty when the store does not exist yet', async () => {
    const { AuthProfileStore } = await loadModule();
    expect(new AuthProfileStore().listProfiles()).toEqual({});
  });
});

describe('AuthProfileStore.setProfile', () => {
  // Last line of defence: nothing that would fail the load check may reach disk.
  it('refuses a profile that would make the store unloadable', async () => {
    const { AuthProfileStore } = await loadModule();
    const store = new AuthProfileStore();

    expect(() =>
      store.setProfile('linear:default', validProfile({ access: undefined }) as never),
    ).toThrow(/invalid auth profile/i);
    expect(existsSync(storePath())).toBe(false);
  });

  it('stores a valid profile', async () => {
    const { AuthProfileStore } = await loadModule();
    const store = new AuthProfileStore();
    store.setProfile('gpt:default', validProfile() as never);
    expect(readStore().profiles['gpt:default'].access).toBe('access-token');
  });
});

describe('AuthProfileStore.save concurrency', () => {
  // Two processes — CLI beside daemon, or two overlapping refreshes — each hold
  // a snapshot from construction. Writing that snapshot wholesale rolled back
  // the other's refresh_token rotation, and a rolled-back refresh token fails
  // the next refresh with invalid_grant.
  it('does not roll back another writer rotation of a different provider', async () => {
    writeStore({ 'gpt:default': validProfile(), 'linear:default': validProfile({ provider: 'linear' }) });
    const { AuthProfileStore } = await loadModule();

    const first = new AuthProfileStore();
    const second = new AuthProfileStore();

    // `second` rotates linear while `first` still holds the pre-rotation view.
    second.setProfile('linear:default', validProfile({ provider: 'linear', refresh: 'rotated-by-second' }) as never);
    // `first` then writes its own provider.
    first.setProfile('gpt:default', validProfile({ refresh: 'rotated-by-first' }) as never);

    const onDisk = readStore().profiles;
    expect(onDisk['gpt:default'].refresh).toBe('rotated-by-first');
    expect(onDisk['linear:default'].refresh).toBe('rotated-by-second');
  });

  it('expireProfile keeps the same-key rotation another writer just made', async () => {
    // The case setProfile could not cover, and the one that actually bites: an
    // adapter builds a store when a run starts and hits a 401 hours later. It
    // only wants to force a refresh, but writing its snapshot back restores the
    // pre-rotation refresh token, and a dead refresh token fails every later
    // run with invalid_grant until the user logs in again. (INT-2961)
    writeStore({ 'gpt:default': validProfile({ refresh: 'original' }) });
    const { AuthProfileStore } = await loadModule();

    const stale = new AuthProfileStore();           // snapshot: refresh=original
    const other = new AuthProfileStore();
    other.setProfile('gpt:default', validProfile({ refresh: 'rotated-by-other' }) as never);

    expect(stale.expireProfile('gpt:default')).toBe(true);

    const onDisk = readStore().profiles['gpt:default'];
    expect(onDisk.refresh).toBe('rotated-by-other');
    expect(onDisk.expires).toBe(0);
  });

  it('expireProfile reports an absent key rather than inventing one', async () => {
    writeStore({});
    const { AuthProfileStore } = await loadModule();
    expect(new AuthProfileStore().expireProfile('gpt:default')).toBe(false);
  });

  it('still applies a delete against the current file', async () => {
    writeStore({ 'gpt:default': validProfile(), 'linear:default': validProfile({ provider: 'linear' }) });
    const { AuthProfileStore } = await loadModule();

    const first = new AuthProfileStore();
    const second = new AuthProfileStore();

    second.setProfile('linear:default', validProfile({ provider: 'linear', refresh: 'rotated' }) as never);
    expect(first.deleteProfile('gpt:default')).toBe(true);

    const onDisk = readStore().profiles;
    expect(onDisk['gpt:default']).toBeUndefined();
    expect(onDisk['linear:default'].refresh).toBe('rotated');
  });
});

describe('ensureValidToken', () => {
  const expiring = () => validProfile({ expires: Date.now() + 1_000 }); // inside the refresh buffer

  function mockTokenEndpoint(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      })) as never,
    );
  }

  it('returns the existing token when it is not close to expiry', async () => {
    writeStore({ 'gpt:default': validProfile() });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('must not be called'); }) as never);

    await expect(ensureValidToken(new AuthProfileStore(), 'gpt:default')).resolves.toBe('access-token');
  });

  it('stores a refreshed token', async () => {
    writeStore({ 'gpt:default': expiring() });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTokenEndpoint(200, { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });

    await expect(ensureValidToken(new AuthProfileStore(), 'gpt:default')).resolves.toBe('fresh');
    expect(readStore().profiles['gpt:default']).toMatchObject({ access: 'fresh', refresh: 'rotated' });
  });

  // The path that used to poison the store: a 200 whose body is not a token.
  // Casting it wrote access=undefined and expires=NaN, and the next load then
  // quarantined the file and took every other provider with it.
  it.each([
    ['an error body', { error: 'invalid_grant' }],
    ['an empty body', {}],
    ['a body with no expiry', { access_token: 'fresh' }],
  ])('refuses to persist %s returned with 200', async (_label, body) => {
    writeStore({ 'gpt:default': expiring(), 'linear:default': validProfile({ provider: 'linear' }) });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTokenEndpoint(200, body);

    await expect(ensureValidToken(new AuthProfileStore(), 'gpt:default')).rejects.toThrow();

    // The old token is still there, and the unrelated provider is untouched.
    const onDisk = readStore().profiles;
    expect(onDisk['gpt:default'].access).toBe('access-token');
    expect(onDisk['linear:default'].access).toBe('access-token');
  });

  // setProfile's guard also stops a bad refresh from reaching disk, so "it
  // throws" alone cannot tell the two layers apart. The difference is *when*:
  // validating the response first leaves the in-memory profile intact, whereas
  // assigning from a cast response corrupts the live object before the write is
  // refused — and getProfile hands that same object to the next caller for the
  // rest of the process.
  it('leaves the in-memory profile usable after a bad refresh', async () => {
    writeStore({ 'gpt:default': expiring() });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTokenEndpoint(200, { error: 'invalid_grant' });
    const store = new AuthProfileStore();

    await expect(ensureValidToken(store, 'gpt:default')).rejects.toThrow();

    const after = store.getProfile('gpt:default');
    expect(after?.access).toBe('access-token');
    expect(Number.isFinite(after?.expires)).toBe(true);
  });

  it('keeps the existing refresh token when the provider omits it', async () => {
    writeStore({ 'gpt:default': expiring() });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTokenEndpoint(200, { access_token: 'fresh', expires_in: 3600 });

    await expect(ensureValidToken(new AuthProfileStore(), 'gpt:default')).resolves.toBe('fresh');
    expect(readStore().profiles['gpt:default'].refresh).toBe('refresh-token');
  });

  it('tells the user how to re-auth when the endpoint rejects the refresh', async () => {
    writeStore({ 'gpt:default': expiring() });
    const { AuthProfileStore, ensureValidToken } = await loadModule();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTokenEndpoint(400, 'invalid_grant');

    await expect(ensureValidToken(new AuthProfileStore(), 'gpt:default')).rejects.toThrow(/auth login/);
  });
});

// The CLI classifies a dead credential by the *shape* ensureValidToken throws:
// name 'TokenRefreshError' plus a numeric HTTP status. Those classifier tests
// build that shape by hand, so without this the two halves of the contract could
// drift apart silently. (AGT-4148)
describe('ensureValidToken refresh failures', () => {
  const expiredProfile = () =>
    validProfile({ provider: 'linear', expires: Date.now() - 60_000 });

  async function refreshWith(status: number, body: string) {
    writeStore({ 'linear:default': expiredProfile() });
    const { AuthProfileStore, ensureValidToken, TokenRefreshError } = await loadModule();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );
    return { store: new AuthProfileStore(), ensureValidToken, TokenRefreshError };
  }

  it('rejects a non-2xx refresh with TokenRefreshError carrying the status', async () => {
    const { store, ensureValidToken, TokenRefreshError } = await refreshWith(
      400,
      '{"error":"invalid_request","error_description":"Refresh token revoked"}',
    );
    const err = await ensureValidToken(store, 'linear:default').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as InstanceType<typeof TokenRefreshError>).status).toBe(400);
    // The shape the CLI classifier matches on, asserted independently of the class.
    expect((err as Error).name).toBe('TokenRefreshError');
    expect((err as Error).message).toContain('Refresh token revoked');
  });

  it('preserves a 429 status rather than flattening every failure to one kind', async () => {
    const { store, ensureValidToken } = await refreshWith(429, 'Too Many Requests');
    const err = await ensureValidToken(store, 'linear:default').catch((e: unknown) => e);
    expect((err as Error & { status: number }).status).toBe(429);
  });

  it('leaves the stored profile untouched when the refresh is rejected', async () => {
    const { store, ensureValidToken } = await refreshWith(400, 'nope');
    await ensureValidToken(store, 'linear:default').catch(() => undefined);
    expect(readStore().profiles['linear:default'].refresh).toBe('refresh-token');
  });
});
