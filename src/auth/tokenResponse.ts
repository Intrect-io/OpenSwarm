// ============================================
// OpenSwarm - OAuth token response validation
// ============================================
//
// A token endpoint can answer 200 with a body that is not a token: an error
// object, an HTML error page from a proxy, a truncated response. Casting that
// to the expected shape puts `undefined` into the access token and `NaN` into
// the expiry, and a profile in that state is written to disk like any other.
//
// The consequence is not local. AuthProfileStore validates the whole file on
// load, so one malformed profile made every other provider's credentials
// unloadable — a bad Linear response would log the user out of GPT. Validating
// at the boundary keeps a bad response from ever reaching disk.

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface ParseTokenResponseOptions {
  /** Label used in error messages, e.g. 'Linear'. */
  provider: string;
  /**
   * Whether a refresh token must be present.
   *
   * True for an authorization-code exchange, which is the only chance to obtain
   * one. False for a refresh, where providers may legitimately omit it and keep
   * the existing token valid — requiring it there would reject good responses.
   */
  requireRefreshToken: boolean;
}

/** Validate an OAuth token response, or throw explaining what is missing. */
export function parseTokenResponse(
  value: unknown,
  { provider, requireRefreshToken }: ParseTokenResponseOptions,
): ParsedTokenResponse {
  if (!value || typeof value !== 'object') {
    throw new Error(`${provider} token response is not an object`);
  }
  const tokens = value as Record<string, unknown>;

  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error(`${provider} token response missing access_token`);
  }
  if (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error(`${provider} token response has invalid expires_in`);
  }

  const hasRefresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
  if (requireRefreshToken && !hasRefresh) {
    throw new Error(`${provider} token response missing refresh_token`);
  }
  // A present-but-wrong refresh_token is rejected either way: silently dropping
  // it would leave the profile pointing at a token the provider has rotated.
  if (!hasRefresh && tokens.refresh_token !== undefined) {
    throw new Error(`${provider} token response has invalid refresh_token`);
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: hasRefresh ? (tokens.refresh_token as string) : undefined,
    expiresIn: tokens.expires_in,
  };
}
