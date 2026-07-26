// ============================================
// OpenSwarm - Linear OAuth 2.0 PKCE Flow
// Browser-based login that exchanges an authorization code for a Linear
// access_token (+ refresh_token). PKCE → NO client_secret is used or stored.
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AuthProfileStore, type AuthProfile } from './oauthStore.js';
import { openBrowser } from './openBrowser.js';
import { PkceSettlement, TOKEN_EXCHANGE_TIMEOUT_MS } from './pkceSettlement.js';
import { parseTokenResponse } from './tokenResponse.js';

// ----- Constants -----

const LINEAR_AUTH_ENDPOINT = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';
const DEFAULT_CALLBACK_PORT = 1457; // distinct from codex (1455) / openrouter (1456)
const DEFAULT_SCOPES = 'read,write';
const LOGIN_TIMEOUT_MS = 120_000;
const LINEAR_PROFILE_KEY = 'linear:default';

export const PROFILE_KEY = LINEAR_PROFILE_KEY;

/**
 * Public OAuth client_id for the OpenSwarm Linear app. PKCE means no client
 * secret is needed. Read from LINEAR_OAUTH_CLIENT_ID so the id is not baked into
 * source/git; a future public build can set a hardcoded default here.
 */
function getClientId(): string {
  const id = process.env.LINEAR_OAUTH_CLIENT_ID?.trim();
  if (!id) {
    // cxt-ignore-next-line: fake_data — real redirect URI shown in setup guidance
    throw new Error('LINEAR_OAUTH_CLIENT_ID is not set. Register a Linear OAuth app at https://linear.app/settings/api/applications/new (redirect http://localhost:1457/callback, scopes read,write, PKCE) and set LINEAR_OAUTH_CLIENT_ID in .env.');
  }
  return id;
}

// ----- PKCE helpers (same shape as oauthPkce.ts / openrouterPkce.ts) -----

function generateCodeVerifier(): string {
  return randomBytes(96).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(32).toString('hex');
}

// ----- Types -----

export interface LinearFlowResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LinearFlowOptions {
  port?: number;
  scopes?: string;
}

/**
 * Validate Linear's authorization-code exchange response.
 *
 * Thin wrapper over the shared validator. This is an exchange, so a refresh
 * token is mandatory — it is the only point at which one is issued.
 */
export function parseLinearTokenResponse(value: unknown): LinearFlowResult {
  const { accessToken, refreshToken, expiresIn } = parseTokenResponse(value, {
    provider: 'Linear',
    requireRefreshToken: true,
  });
  return { accessToken, refreshToken: refreshToken as string, expiresIn };
}

export function isValidLinearCallback(
  code: string | null,
  error: string | null,
  returnedState: string | null,
  expectedState: string,
): boolean {
  return returnedState === expectedState && (!!code || !!error);
}

/**
 * Linear OAuth 2.0 PKCE flow.
 *   1. generate PKCE verifier/challenge + state
 *   2. open https://linear.app/oauth/authorize?...&code_challenge=...&code_challenge_method=S256
 *   3. receive ?code=... on the local callback server
 *   4. POST https://api.linear.app/oauth/token (code_verifier, client_id — NO secret)
 *      → access_token + refresh_token
 */
export async function runLinearPkceFlow(options: LinearFlowOptions = {}): Promise<LinearFlowResult> {
  const { port = DEFAULT_CALLBACK_PORT, scopes = DEFAULT_SCOPES } = options;
  const clientId = getClientId();
  // Must match the redirect URI registered on the Linear OAuth app exactly.
  const redirectUri = `http://localhost:${port}/callback`;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: scopes,
    state,
  });
  const authUrl = `${LINEAR_AUTH_ENDPOINT}?${authParams.toString()}`;

  return new Promise<LinearFlowResult>((resolve, reject) => {
    const settlement = new PkceSettlement();
    const exchangeAbort = new AbortController();

    const timeout = setTimeout(() => {
      if (settlement.finish()) {
        exchangeAbort.abort(new Error('Linear login timed out'));
        server.close();
        reject(new Error('Linear login timed out (120s). 다시 시도하세요.'));
      }
    }, LOGIN_TIMEOUT_MS);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (settlement.settled) {
        res.writeHead(400);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
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

      if (!isValidLinearCallback(code, error, returnedState, state)) {
        settlement.finish();
        clearTimeout(timeout);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Invalid callback parameters'));
        server.close();
        reject(new Error('Invalid Linear callback: missing code or state mismatch'));
        return;
      }

      if (error) {
        settlement.finish();
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(error));
        server.close();
        reject(new Error(`Linear OAuth error: ${error}`));
        return;
      }

      try {
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: clientId,
        });

        const tokenRes = await fetch(LINEAR_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
          signal: AbortSignal.any([exchangeAbort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '');
          throw new Error(`Token exchange failed (${tokenRes.status}): ${errText.slice(0, 300)}`);
        }

        const result = parseLinearTokenResponse(await tokenRes.json());

        if (!settlement.finish()) return;
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());
        server.close();
        resolve(result);
      } catch (err) {
        if (!settlement.finish()) return;
        clearTimeout(timeout);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(String(err)));
        server.close();
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Auth] Callback server listening on http://127.0.0.1:${port}`);
      console.log('[Auth] 브라우저에서 Linear 로그인 페이지를 엽니다...');
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

/** Full PKCE flow + persist the linear:default profile. Returns the access token. */
export async function loginAndSaveLinearProfile(port?: number): Promise<string> {
  const result = await runLinearPkceFlow({ port });

  const profile: AuthProfile = {
    type: 'oauth',
    provider: 'linear',
    access: result.accessToken,
    refresh: result.refreshToken,
    expires: Date.now() + result.expiresIn * 1000,
    clientId: getClientId(),
  };

  const store = new AuthProfileStore();
  store.setProfile(LINEAR_PROFILE_KEY, profile);

  console.log(`[Auth] Linear OAuth 인증 완료. 프로필 저장됨: ${LINEAR_PROFILE_KEY}`); // cxt-ignore: fake_execution — printed after a real token exchange
  return result.accessToken;
}

// ----- HTML templates -----

function successHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenSwarm Auth</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0fdf4}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#16a34a;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>✓ 인증 완료</h1><p>OpenSwarm에 Linear 인증이 완료되었습니다.<br>이 창을 닫아도 됩니다.</p></div></body></html>`;
}

function errorHtml(error: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenSwarm Auth Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fef2f2}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#dc2626;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>✗ 인증 실패</h1><p>${escapeHtml(error)}</p><p>터미널에서 다시 시도하세요.</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
