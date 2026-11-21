// ============================================
// OpenSwarm - OAuth 2.1 PKCE Flow
// Browser-based OpenAI OAuth login
// ============================================
//
// Decision (AGT-3467): the PKCE callback listeners (OpenAI, Linear, OpenRouter)
// bind the IPv4 loopback 127.0.0.1 only and are not extended to IPv6 ::1; the
// callback host they are built around is 127.0.0.1, and browsers fall back to it
// when a `localhost` redirect_uri also resolves to ::1.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { AuthProfileStore, type AuthProfile } from './oauthStore.js';
import { openBrowser } from './openBrowser.js';
import { endSupersededCallback, PkceSettlement, TOKEN_EXCHANGE_TIMEOUT_MS } from './pkceSettlement.js';
import { parseTokenResponse } from './tokenResponse.js';

// Constants

const OPENAI_AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_SCOPES = 'openid profile email offline_access';
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes
const PROFILE_KEY = 'openai-gpt:default';

// Public OAuth client_id used by the official @openai/codex CLI.
// Reusing it lets `openswarm auth login --provider gpt` work out of the box for
// any ChatGPT Plus/Pro/Team user without provisioning a custom OAuth app.
// Override with `--client-id` or the OPENAI_CLIENT_ID env var if needed.
export const DEFAULT_OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_ORIGINATOR = 'openswarm';

/**
 * Accept only the advertised loopback callback forms: IPv4 127.0.0.1 and IPv6
 * ::1 (including the IPv4-mapped ::ffff:127.0.0.1 form Node reports when a
 * dual-stack socket receives an IPv4 connection). Any other remote address is
 * rejected so the callback server cannot be driven from off-host.
 *
 * The OpenAI redirect_uri stays `http://localhost:<port>/auth/callback` (the
 * registered client value); browsers may still connect via ::1 or 127.0.0.1.
 */
export function isLoopbackRemote(address: string | undefined): boolean {
  if (!address) return false;
  const family = isIP(address);
  if (family === 4) return address === '127.0.0.1';
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower === '::ffff:127.0.0.1';
  }
  return false;
}

// PKCE helpers

function generateCodeVerifier(): string {
  // Random string of 43-128 base64url-safe characters
  return randomBytes(96).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(32).toString('hex');
}

// OAuth flow result

export interface OAuthFlowResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accountId?: string;
}

export interface OAuthFlowOptions {
  clientId?: string;
  port?: number;
  scopes?: string;
  /** Login timeout; defaults to two minutes. Tests shorten it. */
  timeoutMs?: number;
}

/**
 * Run the OAuth 2.1 PKCE flow.
 * Receives the callback on a local HTTP server, exchanges the token, and stores it.
 */
export async function runOAuthPkceFlow(options: OAuthFlowOptions = {}): Promise<OAuthFlowResult> {
  const {
    clientId = DEFAULT_OPENAI_CLIENT_ID,
    port = DEFAULT_CALLBACK_PORT,
    scopes = DEFAULT_SCOPES,
    timeoutMs = LOGIN_TIMEOUT_MS,
  } = options;
  // Must be exactly "http://localhost:1455/auth/callback" — this is the value
  // registered on the public Codex OAuth client. Using 127.0.0.1 instead
  // triggers Hydra's authorize_hydra_invalid_request error.
  const redirectUri = `http://localhost:${port}/auth/callback`;

  // 1. Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // 2. Build the Authorization URL.
  // The simplified_flow + id_token_add_organizations params mirror the official
  // codex CLI so the ChatGPT side recognises this as a first-party desktop login.
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: scopes,
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OAUTH_ORIGINATOR,
  });
  const authUrl = `${OPENAI_AUTH_ENDPOINT}?${authParams.toString()}`;

  // 3. Start the local HTTP server + wait for the callback
  return new Promise<OAuthFlowResult>((resolve, reject) => {
    const settlement = new PkceSettlement();
    const exchangeAbort = new AbortController();

    const timeout = setTimeout(() => {
      if (settlement.finish()) {
        exchangeAbort.abort(new Error('OAuth login timed out'));
        server.close();
        reject(new Error('OAuth login timed out (120s). 다시 시도하세요.'));
      }
    }, timeoutMs);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (settlement.settled) {
        res.writeHead(400);
        res.end();
        return;
      }

      if (!isLoopbackRemote(req.socket.remoteAddress)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (!settlement.tryClaim()) {
        res.writeHead(409);
        res.end('OAuth callback already being processed');
        return;
      }

      if (error) {
        settlement.finish();
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(error));
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        settlement.finish();
        clearTimeout(timeout);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Invalid callback parameters'));
        server.close();
        reject(new Error('Invalid OAuth callback: missing code or state mismatch'));
        return;
      }

      // 4. Token Exchange
      try {
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: clientId,
        });

        const tokenRes = await fetch(OPENAI_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
          signal: AbortSignal.any([exchangeAbort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '');
          throw new Error(`Token exchange failed (${tokenRes.status}): ${errText.slice(0, 300)}`);
        }

        // Validated before any of it reaches an AuthProfile: a 200 carrying an
        // error body would otherwise be stored with an undefined access token
        // and a NaN expiry, which fails the store's load-time check and used to
        // take every other provider's credentials with it. An exchange is the
        // only point a refresh token is issued, so it is required here.
        const raw: unknown = await tokenRes.json();
        const parsed = parseTokenResponse(raw, { provider: 'ChatGPT', requireRefreshToken: true });
        const tokens = {
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken as string,
          expires_in: parsed.expiresIn,
          id_token: (raw as { id_token?: unknown }).id_token as string | undefined,
        };

        // The Codex backend (/responses, /models) requires a `chatgpt-account-id` header.
        // That value is `chatgpt_account_id` inside the `https://api.openai.com/auth` claim
        // of the access_token JWT. (We used to store id_token.sub, but that is the IdP
        // subject — e.g. `google-oauth2|...` — so it is not the codex account_id.)
        // Prefer access_token, fall back to id_token if absent.
        let accountId: string | undefined;
        for (const jwt of [tokens.access_token, tokens.id_token]) {
          if (!jwt) continue;
          try {
            const payload = JSON.parse(
              Buffer.from(jwt.split('.')[1], 'base64url').toString(),
            ) as Record<string, unknown>;
            const authClaim = payload['https://api.openai.com/auth'];
            const candidate =
              authClaim && typeof authClaim === 'object'
                ? (authClaim as Record<string, unknown>).chatgpt_account_id
                : undefined;
            if (typeof candidate === 'string' && candidate) {
              accountId = candidate;
              break;
            }
          } catch {
            // JWT 파싱 실패는 무시 — accountId 없이 진행
          }
        }

        const result: OAuthFlowResult = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
          accountId,
        };

        if (!settlement.finish()) {
          endSupersededCallback(res);
          return;
        }
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());
        server.close();
        resolve(result);
      } catch (err) {
        if (!settlement.finish()) {
          endSupersededCallback(res);
          return;
        }
        clearTimeout(timeout);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(String(err)));
        server.close();
        reject(err);
      }
    });

    // Bound to the IPv4 loopback, not 'localhost': listen('localhost') resolves
    // the name ONCE and binds whichever family wins (measured on macOS: ::1
    // only, so 127.0.0.1 clients get ECONNREFUSED). isLoopbackRemote still
    // accepts the IPv6 and IPv4-mapped forms so a dual-stack bind stays correct.
    server.listen(port, '127.0.0.1', () => {
      console.log(`[Auth] Callback server listening on http://127.0.0.1:${port}`);
      console.log(`[Auth] 브라우저에서 OpenAI 로그인 페이지를 엽니다...`);
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      if (settlement.finish()) {
        exchangeAbort.abort(err);
        clearTimeout(timeout);
        reject(new Error(`Callback server error: ${err.message}`));
      }
    });
  });
}

/**
 * OAuth login → store the token (full onboarding flow)
 */
export async function loginAndSaveProfile(
  clientId: string = DEFAULT_OPENAI_CLIENT_ID,
  port?: number,
): Promise<void> {
  const result = await runOAuthPkceFlow({ clientId, port });

  const profile: AuthProfile = {
    type: 'oauth',
    provider: 'openai-gpt',
    access: result.accessToken,
    refresh: result.refreshToken,
    expires: Date.now() + result.expiresIn * 1000,
    clientId,
    accountId: result.accountId,
  };

  const store = new AuthProfileStore();
  store.setProfile(PROFILE_KEY, profile);

  console.log(`[Auth] GPT OAuth 인증 완료. 프로필 저장됨: ${PROFILE_KEY}`);
  if (result.accountId) {
    console.log(`[Auth] Account ID: ${result.accountId}`);
  }
}

// HTML templates

function successHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenSwarm Auth</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0fdf4}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#16a34a;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>✓ 인증 완료</h1><p>OpenSwarm에 GPT OAuth 인증이 완료되었습니다.<br>이 창을 닫아도 됩니다.</p></div></body></html>`;
}

function errorHtml(error: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenSwarm Auth Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fef2f2}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#dc2626;margin-bottom:0.5rem}p{color:#666}code{background:#f3f4f6;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.9rem}</style></head>
<body><div class="card"><h1>✗ 인증 실패</h1><p>${escapeHtml(error)}</p><p>터미널에서 다시 시도하세요.</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
