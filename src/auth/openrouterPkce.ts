// ============================================
// OpenSwarm - OpenRouter PKCE Flow
// Browser-based login that exchanges an authorization code
// for a user-controlled `sk-or-*` API key.
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AuthProfileStore, type AuthProfile } from './oauthStore.js';
import { openBrowser } from './openBrowser.js';
import { PkceSettlement, TOKEN_EXCHANGE_TIMEOUT_MS } from './pkceSettlement.js';

// ----- Constants -----

const OPENROUTER_AUTH_ENDPOINT = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';
const DEFAULT_CALLBACK_PORT = 1456; // distinct from the OpenAI flow (1455)
const LOGIN_TIMEOUT_MS = 120_000;
const OPENROUTER_PROFILE_KEY = 'openrouter:default';

export const PROFILE_KEY = OPENROUTER_PROFILE_KEY;

// ----- PKCE helpers (same shape as oauthPkce.ts) -----

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

export interface OpenRouterFlowResult {
  apiKey: string;
  userId?: string;
}

export interface OpenRouterFlowOptions {
  port?: number;
}

/**
 * OpenRouter PKCE 흐름 실행.
 *
 *   1. PKCE verifier/challenge 생성
 *   2. https://openrouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256 로 브라우저 오픈
 *   3. 로컬 콜백 서버에서 ?code=... 수신
 *   4. POST /api/v1/auth/keys 로 교환 → 영구 sk-or-* API key
 *
 * OpenAI 흐름과 달리 refresh token 개념이 없다 — 받은 키를 그대로 저장한다.
 */
export async function runOpenRouterPkceFlow(
  options: OpenRouterFlowOptions = {},
): Promise<OpenRouterFlowResult> {
  const { port = DEFAULT_CALLBACK_PORT } = options;
  const callbackUrl = `http://127.0.0.1:${port}/auth/callback`;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  // OpenRouter does not echo back `state`, but we still keep it locally
  // so we can detect tampered callbacks (the URL pattern requires us to send it).
  const state = generateState();

  const authParams = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  const authUrl = `${OPENROUTER_AUTH_ENDPOINT}?${authParams.toString()}`;

  return new Promise<OpenRouterFlowResult>((resolve, reject) => {
    const settlement = new PkceSettlement();
    const exchangeAbort = new AbortController();

    const timeout = setTimeout(() => {
      if (settlement.finish()) {
        exchangeAbort.abort(new Error('OpenRouter login timed out'));
        server.close();
        reject(new Error('OpenRouter login timed out (120s). 다시 시도하세요.'));
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
        reject(new Error(`OpenRouter OAuth error: ${error}`));
        return;
      }

      if (!code) {
        settlement.finish();
        clearTimeout(timeout);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Missing authorization code'));
        server.close();
        reject(new Error('Invalid OpenRouter callback: missing code'));
        return;
      }

      try {
        const exchangeRes = await fetch(OPENROUTER_KEYS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            code_challenge_method: 'S256',
          }),
          signal: AbortSignal.any([exchangeAbort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
        });

        if (!exchangeRes.ok) {
          const errText = await exchangeRes.text().catch(() => '');
          throw new Error(
            `Key exchange failed (${exchangeRes.status}): ${errText.slice(0, 300)}`,
          );
        }

        const payload = (await exchangeRes.json()) as {
          key?: string;
          user_id?: string | null;
        };

        if (!payload.key) {
          throw new Error('OpenRouter key exchange response missing "key" field');
        }

        const result: OpenRouterFlowResult = {
          apiKey: payload.key,
          userId: payload.user_id ?? undefined,
        };

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
      if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
        // No browser on a headless SSH host. The operator opens the URL on
        // their own machine and forwards the callback port back here.
        for (const line of formatOpenRouterOauthInstructions(authUrl, port)) {
          console.log(`[Auth] ${line}`);
        }
      } else {
        console.log(`[Auth] 브라우저에서 OpenRouter 로그인 페이지를 엽니다...`);
        openBrowser(authUrl);
      }
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
 * Instructions for completing the PKCE flow from a headless SSH host: open the
 * authorize URL on the operator's own machine, then forward the callback port
 * back so the local callback server receives the redirect.
 */
export function formatOpenRouterOauthInstructions(
  authUrl: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  host?: string,
): string[] {
  const forwardHost =
    host ?? env.SSH_CONNECTION?.trim().split(/\s+/)[2] ?? 'this-host';
  const user = env.USER ?? 'user';
  return [
    `Open this authorize URL in a browser on your own machine:`,
    `  ${authUrl}`,
    `Then forward the callback port back to this host:`,
    `  ssh -N -L ${port}:127.0.0.1:${port} ${user}@${forwardHost}`,
  ];
}

/**
 * OpenRouter API key를 직접 받아 저장 (PKCE fallback).
 * `sk-or-` 접두사만 가볍게 검증한다.
 */
export function saveOpenRouterApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('Empty API key');
  }
  if (!trimmed.startsWith('sk-or-')) {
    throw new Error(
      'OpenRouter API keys start with "sk-or-". Get one from https://openrouter.ai/keys',
    );
  }

  const profile: AuthProfile = {
    type: 'apiKey',
    provider: 'openrouter',
    access: trimmed,
    refresh: '',
    expires: Number.MAX_SAFE_INTEGER,
    clientId: '',
  };

  const store = new AuthProfileStore();
  store.setProfile(OPENROUTER_PROFILE_KEY, profile);
}

/**
 * 전체 PKCE 흐름 + 저장
 */
export async function loginAndSaveOpenRouterProfile(port?: number): Promise<void> {
  const result = await runOpenRouterPkceFlow({ port });

  const profile: AuthProfile = {
    type: 'apiKey',
    provider: 'openrouter',
    access: result.apiKey,
    refresh: '',
    expires: Number.MAX_SAFE_INTEGER,
    clientId: '',
    accountId: result.userId,
  };

  const store = new AuthProfileStore();
  store.setProfile(OPENROUTER_PROFILE_KEY, profile);

  console.log(`[Auth] OpenRouter 인증 완료. 프로필 저장됨: ${OPENROUTER_PROFILE_KEY}`);
  if (result.userId) {
    console.log(`[Auth] User ID: ${result.userId}`);
  }
}

// ----- HTML templates -----

function successHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OpenSwarm Auth</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0fdf4}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#16a34a;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>✓ 인증 완료</h1><p>OpenSwarm에 OpenRouter 인증이 완료되었습니다.<br>이 창을 닫아도 됩니다.</p></div></body></html>`;
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
