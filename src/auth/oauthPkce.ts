// ============================================
// OpenSwarm - OAuth 2.1 PKCE Flow
// Browser-based OpenAI OAuth login
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AuthProfileStore, type AuthProfile } from './oauthStore.js';
import { openBrowser } from './openBrowser.js';
import { PkceSettlement, TOKEN_EXCHANGE_TIMEOUT_MS } from './pkceSettlement.js';
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

// PKCE helpers

function generateCodeVerifier(): string {
  // 43-128자 base64url-safe 랜덤 문자열
  const bytes = randomBytes(64);
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .slice(0, 128);
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateState(): string {
  return randomBytes(32).toString('hex');
}

// OAuth flow result

export interface OAuthFlowResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  accountId?: string;
}

export interface OAuthFlowOptions {
  clientId?: string;
  port?: number;
  scopes?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  redirectUri?: string;
}

/**
 * Run the full OAuth PKCE flow:
 * 1. Generate PKCE challenge + state
 * 2. Start local callback server
 * 3. Open browser for user login
 * 4. Exchange authorization code for tokens
 * 5. Return tokens
 */
export async function runOAuthPkceFlow(
  options: OAuthFlowOptions = {},
): Promise<OAuthFlowResult> {
  const clientId = options.clientId ?? DEFAULT_OPENAI_CLIENT_ID;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const authEndpoint = options.authEndpoint ?? OPENAI_AUTH_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? OPENAI_TOKEN_ENDPOINT;
  const redirectUri = options.redirectUri ?? `http://127.0.0.1:${port}/auth/callback`;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = `${authEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    originator: OAUTH_ORIGINATOR,
  })}`;

  return new Promise<OAuthFlowResult>((resolve, reject) => {
    const settlement = new PkceSettlement();
    const exchangeAbort = new AbortController();
    // Track the currently claimed response so cancellation can terminate it.
    let claimedResponse: ServerResponse | null = null;

    const timeout = setTimeout(() => {
      if (settlement.finish()) {
        exchangeAbort.abort(new Error('OAuth login timed out'));
        claimedResponse?.destroy();
        claimedResponse = null;
        server.close();
        reject(new Error('OAuth login timed out (120s). 다시 시도하세요.'));
      }
    }, LOGIN_TIMEOUT_MS);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (settlement.settled) {
        res.writeHead(400);
        res.end();
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
      claimedResponse = res;

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

        const raw: unknown = await tokenRes.json();
        const parsed = parseTokenResponse(raw, { provider: 'ChatGPT', requireRefreshToken: true });
        const tokens = {
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken as string,
          expires_in: parsed.expiresIn,
          id_token: (raw as { id_token?: unknown }).id_token as string | undefined,
        };

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
          // Cancellation won — terminate the claimed response so the browser
          // doesn't hang on a socket whose flow we just abandoned.
          claimedResponse?.destroy();
          claimedResponse = null;
          server.close();
          return;
        }
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());
        server.close();
        resolve(result);
      } catch (err) {
        if (!settlement.finish()) {
          claimedResponse?.destroy();
          claimedResponse = null;
          server.close();
          return;
        }
        clearTimeout(timeout);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(String(err)));
        server.close();
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Auth] Callback server listening on http://127.0.0.1:${port}`);
      console.log(`[Auth] 브라우저에서 OpenAI 로그인 페이지를 엽니다...`);
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      if (settlement.finish()) {
        exchangeAbort.abort(err);
        claimedResponse?.destroy();
        claimedResponse = null;
        clearTimeout(timeout);
        reject(new Error(`Callback server error: ${err.message}`));
      }
    });
  });
}

/**
 * OAuth 로그인 → 토큰 저장 (온보딩 전체 흐름)
 */
export async function loginAndSaveProfile(
  clientId: string,
  port?: number,
): Promise<void> {
  const result = await runOAuthPkceFlow({ clientId, port });
  const store = new AuthProfileStore();
  const profile: AuthProfile = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
    accountId: result.accountId,
  };
  store.save(PROFILE_KEY, profile);
  console.log(`[Auth] Profile saved as '${PROFILE_KEY}'`);
}

function successHtml(): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>인증 완료</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0fdf4}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#16a34a;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>✓ 인증 완료</h1><p>OpenSwarm CLI로 돌아가세요.</p></div></body></html>`;
}

function errorHtml(error: string): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>인증 실패</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fef2f2}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#dc2626;margin-bottom:0.5rem}p{color:#666}code{background:#f3f4f6;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.9rem}</style></head>
<body><div class="card"><h1>✗ 인증 실패</h1><p>${escapeHtml(error)}</p><p>터미널에서 다시 시도하세요.</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}