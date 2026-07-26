// ============================================
// OpenSwarm - OAuth Token Store
// Persistent storage + auto-refresh for OAuth tokens
// ============================================

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../support/atomicFile.js';
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
   * This narrows the race rather than removing it: two writers rotating the
   * *same* key concurrently still read-then-write, so the later one can land on
   * a snapshot taken before the earlier write. Closing that needs a lock around
   * read-modify-write, which is a larger change than this fix. Different keys —
   * the common CLI-beside-daemon case, and the one that used to lose unrelated
   * providers' credentials — are now safe.
   */
  save(): void {
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
 * 유효한 access token 반환. 만료 임박 시 자동 refresh.
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

  const now = Date.now();
  if (now < profile.expires - REFRESH_BUFFER_MS) {
    return profile.access;
  }

  // Token 갱신
  console.log(`[Auth] Refreshing token for ${profileKey}...`);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: profile.refresh,
    client_id: profile.clientId,
  });

  const endpoint = TOKEN_ENDPOINTS[profile.provider];
  if (!endpoint) {
    throw new Error(`Unknown OAuth provider "${profile.provider}" for auth profile "${profileKey}". Re-run auth login for this provider.`);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const reauth = profile.provider === 'linear' ? 'linear' : 'gpt';
    throw new Error(
      `Token refresh failed (${res.status}): ${errText.slice(0, 200)}. Run: openswarm auth login --provider ${reauth}`,
    );
  }

  // Validated, not cast. A 200 carrying an error body — or a proxy's HTML —
  // would otherwise put `undefined` into access and `NaN` into expires, and
  // that profile gets written to disk like any other, where it fails the
  // whole-file schema check on the next load and takes every other provider's
  // credentials down with it. refresh_token stays optional here: providers may
  // legitimately keep the existing one on a refresh.
  const tokens = parseTokenResponse(await res.json(), {
    provider: profile.provider,
    requireRefreshToken: false,
  });

  profile.access = tokens.accessToken;
  if (tokens.refreshToken) {
    profile.refresh = tokens.refreshToken;
  }
  profile.expires = Date.now() + tokens.expiresIn * 1000;

  store.setProfile(profileKey, profile);
  console.log(`[Auth] Token refreshed successfully.`);

  return profile.access;
}
