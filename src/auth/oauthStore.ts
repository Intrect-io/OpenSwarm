// ============================================
// OpenSwarm - OAuth Token Store
// Persistent storage + auto-refresh for OAuth tokens
// ============================================

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { withFileLock, withFileLockSync } from '../support/fileLock.js';
import { parseTokenResponse } from './tokenResponse.js';

// Types

export interface AuthProfile {
  /**
   * oauth: short-lived access_token + refresh_token (e.g. ChatGPT Codex)
   * apiKey: long-lived bearer token, no refresh flow (e.g. OpenRouter sk-or-*)
   */
  type: 'oauth' | 'apiKey';
  provider: string;
  access: string;
  /** Empty string when `type === 'apiKey'` (no refresh available). */
  refresh: string;
  /**
   * ms timestamp at which `access` expires.
   * For `type === 'apiKey'` this is set to Number.MAX_SAFE_INTEGER (never expires).
   */
  expires: number;
  /** OAuth client_id for the issuer. Empty string for plain API keys. */
  clientId: string;
  accountId?: string;
}

interface AuthProfileFile {
  version: 1;
  profiles: Record<string, AuthProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthProfile(value: unknown): value is AuthProfile {
  if (!isRecord(value)) return false;
  if (value.type !== 'oauth' && value.type !== 'apiKey') return false;
  return (
    typeof value.provider === 'string' &&
    typeof value.access === 'string' &&
    typeof value.refresh === 'string' &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires) &&
    typeof value.clientId === 'string' &&
    (value.accountId === undefined || typeof value.accountId === 'string')
  );
}

// The old all-or-nothing file validator lived here. It is gone deliberately:
// requiring every profile to be valid is what let one bad entry quarantine the
// whole store. load() now checks the envelope and each profile separately.

// Constants

const STORE_PATH = join(homedir(), '.openswarm', 'auth-profiles.json');
const STORE_LOCK = `${STORE_PATH}.lock`;
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5분 전에 갱신
const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

/** OAuth refresh token endpoints by provider. */
const TOKEN_ENDPOINTS: Record<string, string> = {
  'openai-gpt': OPENAI_TOKEN_ENDPOINT,
  linear: LINEAR_TOKEN_ENDPOINT,
};

// AuthProfileStore

export class AuthProfileStore {
  private data: AuthProfileFile;
  /** Keys this instance changed, so save() only applies those onto the file. */
  private readonly touched = new Set<string>();

  constructor() {
    this.data = this.load();
  }

  /**
   * Read the store, keeping whatever is still usable.
   *
   * A single malformed profile used to fail the whole-file check, which
   * quarantined the file and logged the user out of *every* provider — one bad
   * Linear response cost them their GPT credentials too. Individual profiles
   * that no longer validate are now dropped with a warning and the rest are
   * kept. The file is only quarantined when it cannot be parsed at all, where
   * there is genuinely nothing to salvage.
   */
  private load(): AuthProfileFile {
    if (!existsSync(STORE_PATH)) {
      return { version: 1, profiles: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    } catch (error) {
      const corruptPath = `${STORE_PATH}.corrupt-${Date.now()}`;
      try { renameSync(STORE_PATH, corruptPath); } catch { /* preserve original read error */ }
      throw new Error(`Auth profile store is corrupt; preserved at ${corruptPath}`, { cause: error });
    }

    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.profiles)) {
      const corruptPath = `${STORE_PATH}.corrupt-${Date.now()}`;
      try { renameSync(STORE_PATH, corruptPath); } catch { /* preserve original read error */ }
      throw new Error(`Auth profile store is corrupt; preserved at ${corruptPath}`);
    }

    const profiles: Record<string, AuthProfile> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(parsed.profiles)) {
      if (isAuthProfile(value)) profiles[key] = value;
      else dropped.push(key);
    }
    if (dropped.length > 0) {
      console.warn(
        `[Auth] Ignoring unusable auth profile(s): ${dropped.join(', ')}. ` +
          `Re-run auth login for those providers; other providers are unaffected.`,
      );
    }
    return { version: 1, profiles };
  }

  /**
   * Persist the store, merging onto whatever is on disk right now.
   *
   * The in-memory map is a snapshot from construction, so writing it wholesale
   * lets a second process (CLI alongside daemon, or two overlapping refreshes)
   * roll back the other's refresh_token rotation — and a rolled-back refresh
   * token fails the next refresh with invalid_grant. Only the keys this
   * instance actually touched are applied on top of the current file.
   *
   * Same-key concurrent writers are serialized by {@link STORE_LOCK} around
   * this merge+write (and around refresh in {@link ensureValidToken}).
   */
  save(): void {
    withFileLockSync(STORE_LOCK, () => {
      this.saveUnlocked();
    });
  }

  /**
   * Merge touched keys onto disk and write. Caller must hold {@link STORE_LOCK}
   * (or accept a race). Used by {@link save} and by refresh under an async lock.
   */
  saveUnlocked(): void {
    const onDisk = existsSync(STORE_PATH) ? this.readProfilesQuietly() : {};
    for (const key of this.touched) {
      const profile = this.data.profiles[key];
      if (profile) onDisk[key] = profile;
      else delete onDisk[key];
    }
    this.data = { version: 1, profiles: { ...onDisk } };
    this.touched.clear();
    atomicWriteFileSync(STORE_PATH, `${JSON.stringify(this.data, null, 2)}\n`, 0o600);
  }

  /**
   * Re-read `key` from disk into memory. Used under lock before deciding to refresh
   * so a concurrent refresh that already completed is visible.
   */
  reloadProfileFromDisk(key: string): AuthProfile | null {
    const onDisk = this.readProfilesQuietly()[key];
    if (onDisk) {
      this.data.profiles[key] = onDisk;
      return onDisk;
    }
    return this.data.profiles[key] ?? null;
  }

  /**
   * Like {@link setProfile}, but does not acquire {@link STORE_LOCK}.
   * Caller must already hold the lock (e.g. refresh inside {@link withFileLock}).
   */
  setProfileUnlocked(key: string, profile: AuthProfile): void {
    if (!isAuthProfile(profile)) {
      throw new Error(
        `Refusing to store an invalid auth profile for "${key}" — it would make the store unloadable.`,
      );
    }
    this.data.profiles[key] = profile;
    this.touched.add(key);
    this.saveUnlocked();
  }

  /** Current on-disk profiles, or an empty map if the file is unreadable. */
  private readProfilesQuietly(): Record<string, AuthProfile> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      if (!isRecord(parsed) || !isRecord(parsed.profiles)) return {};
      const profiles: Record<string, AuthProfile> = {};
      for (const [key, value] of Object.entries(parsed.profiles)) {
        if (isAuthProfile(value)) profiles[key] = value;
      }
      return profiles;
    } catch {
      // A merge is best-effort: falling back to this instance's own view is
      // better than refusing to persist a freshly obtained token.
      return {};
    }
  }

  getProfile(key: string): AuthProfile | null {
    return this.data.profiles[key] ?? null;
  }

  /**
   * Store a profile.
   *
   * Validated before it is written: this is the last point at which a profile
   * that would fail the load-time check can be stopped, and letting one through
   * used to cost every other provider's credentials.
   */
  setProfile(key: string, profile: AuthProfile): void {
    if (!isAuthProfile(profile)) {
      throw new Error(
        `Refusing to store an invalid auth profile for "${key}" — it would make the store unloadable.`,
      );
    }
    this.data.profiles[key] = profile;
    this.touched.add(key);
    this.save();
  }

  /**
   * Mark a key's token expired, based on the current on-disk profile rather
   * than this instance's snapshot.
   *
   * A caller holding a long-lived store — the adapters build one when a run
   * starts and can hit a 401 hours later — would otherwise write its whole
   * stale profile back through `setProfile`, and `save()` puts the touched key
   * over the disk value. If another process refreshed in the meantime and the
   * provider rotated the refresh token, that write restores the dead one and
   * every later run fails with invalid_grant until the user logs in again. Only
   * `expires` is ours to change here.
   */
  expireProfile(key: string): boolean {
    const current = this.readProfilesQuietly()[key] ?? this.data.profiles[key];
    if (!current) return false;
    this.data.profiles[key] = { ...current, expires: 0 };
    this.touched.add(key);
    this.save();
    return true;
  }

  deleteProfile(key: string): boolean {
    if (!(key in this.data.profiles)) return false;
    delete this.data.profiles[key];
    this.touched.add(key);
    this.save();
    return true;
  }

  listProfiles(): Record<string, AuthProfile> {
    return { ...this.data.profiles };
  }
}

// Token refresh

/**
 * A refresh the provider answered and rejected. `status` is carried structurally
 * so callers can separate a dead credential (4xx — only re-auth recovers it)
 * from a provider fault (5xx — worth retrying) without parsing the message.
 * A transport failure never becomes one of these; it propagates as the
 * underlying fetch error, which is itself the signal that nothing was answered.
 */
export class TokenRefreshError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TokenRefreshError';
    this.status = status;
  }
}

/**
 * 유효한 access token 반환. 만료 임박 시 자동 refresh.
 *
 * Concurrent refreshes of the same key serialize on {@link STORE_LOCK}: the
 * second waiter re-reads disk under the lock and returns the already-rotated
 * access token instead of refreshing again (which would invalidate the first
 * writer's refresh_token).
 */
export async function ensureValidToken(store: AuthProfileStore, profileKey: string): Promise<string> {
  const profile = store.getProfile(profileKey);
  if (!profile) {
    throw new Error(`Auth profile "${profileKey}" not found. Run: openswarm auth login --provider gpt`);
  }

  // API keys never expire and have no refresh flow.
  if (profile.type === 'apiKey') {
    return profile.access;
  }

  if (Date.now() < profile.expires - REFRESH_BUFFER_MS) {
    return profile.access;
  }

  return withFileLock(STORE_LOCK, async () => {
    // Re-check under lock — another process may have refreshed already.
    const fresh = store.reloadProfileFromDisk(profileKey);
    if (!fresh) {
      throw new Error(`Auth profile "${profileKey}" not found. Run: openswarm auth login --provider gpt`);
    }
    if (fresh.type === 'apiKey') {
      return fresh.access;
    }
    if (Date.now() < fresh.expires - REFRESH_BUFFER_MS) {
      return fresh.access;
    }

    console.log(`[Auth] Refreshing token for ${profileKey}...`);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: fresh.refresh,
      client_id: fresh.clientId,
    });

    const endpoint = TOKEN_ENDPOINTS[fresh.provider];
    if (!endpoint) {
      throw new Error(`Unknown OAuth provider "${fresh.provider}" for auth profile "${profileKey}". Re-run auth login for this provider.`);
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const reauth = fresh.provider === 'linear' ? 'linear' : 'gpt';
      throw new TokenRefreshError(
        `Token refresh failed (${res.status}): ${errText.slice(0, 200)}. Run: openswarm auth login --provider ${reauth}`,
        res.status,
      );
    }

    // Validated, not cast. A 200 carrying an error body — or a proxy's HTML —
    // would otherwise put `undefined` into access and `NaN` into expires, and
    // that profile gets written to disk like any other, where it fails the
    // whole-file schema check on the next load and takes every other provider's
    // credentials down with it. refresh_token stays optional here: providers may
    // legitimately keep the existing one on a refresh.
    const tokens = parseTokenResponse(await res.json(), {
      provider: fresh.provider,
      requireRefreshToken: false,
    });

    const updated: AuthProfile = {
      ...fresh,
      access: tokens.accessToken,
      refresh: tokens.refreshToken ?? fresh.refresh,
      expires: Date.now() + tokens.expiresIn * 1000,
    };

    // save() would re-enter STORE_LOCK and deadlock; persist under the held lock.
    store.setProfileUnlocked(profileKey, updated);
    console.log(`[Auth] Token refreshed successfully.`);

    return updated.access;
  }, { timeoutMs: 30_000 });
}
