// ============================================
// OpenSwarm - token response validation tests
// ============================================

import { describe, expect, it } from 'vitest';
import { parseTokenResponse } from './tokenResponse.js';

const exchange = { provider: 'Linear', requireRefreshToken: true } as const;
const refresh = { provider: 'openai-gpt', requireRefreshToken: false } as const;

describe('parseTokenResponse', () => {
  it('accepts a complete response', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, exchange)).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 3600,
    });
  });

  // The shape that caused the damage: a 200 whose body is not a token. Casting
  // it wrote `undefined` into access and `NaN` into expires.
  it.each([
    ['an error object', { error: 'invalid_grant', error_description: 'expired' }],
    ['an empty object', {}],
    ['an HTML error page', '<html>502 Bad Gateway</html>'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, body) => {
    expect(() => parseTokenResponse(body, refresh)).toThrow();
  });

  it.each([
    ['a blank access_token', { access_token: '', refresh_token: 'r', expires_in: 1 }, /access_token/],
    ['a non-string access_token', { access_token: 42, refresh_token: 'r', expires_in: 1 }, /access_token/],
    ['a missing expires_in', { access_token: 'a', refresh_token: 'r' }, /expires_in/],
    ['a NaN expires_in', { access_token: 'a', refresh_token: 'r', expires_in: Number.NaN }, /expires_in/],
    ['a zero expires_in', { access_token: 'a', refresh_token: 'r', expires_in: 0 }, /expires_in/],
    ['a negative expires_in', { access_token: 'a', refresh_token: 'r', expires_in: -1 }, /expires_in/],
  ])('rejects %s', (_label, body, pattern) => {
    expect(() => parseTokenResponse(body, exchange)).toThrow(pattern);
  });

  describe('refresh_token', () => {
    it('is required for an authorization-code exchange', () => {
      expect(() => parseTokenResponse({ access_token: 'a', expires_in: 1 }, exchange)).toThrow(/refresh_token/);
    });

    // A refresh may legitimately omit it — the existing token stays valid.
    // Requiring it here would reject good responses and block every refresh.
    it('is optional on a refresh', () => {
      expect(parseTokenResponse({ access_token: 'a', expires_in: 1 }, refresh)).toEqual({
        accessToken: 'a',
        refreshToken: undefined,
        expiresIn: 1,
      });
    });

    // Present-but-wrong is not the same as absent: silently dropping it would
    // leave the profile holding a token the provider has already rotated away.
    it.each([['a blank string', ''], ['a number', 7], ['null', null]])(
      'rejects %s even on a refresh',
      (_label, value) => {
        expect(() => parseTokenResponse({ access_token: 'a', refresh_token: value, expires_in: 1 }, refresh)).toThrow(
          /refresh_token/,
        );
      },
    );
  });

  it('names the provider in the error so the user knows what to re-auth', () => {
    expect(() => parseTokenResponse({}, { provider: 'linear', requireRefreshToken: false })).toThrow(/linear/);
  });
});
