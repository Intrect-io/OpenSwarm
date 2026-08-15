// ============================================
// OpenSwarm - Auth CLI Handler
// `openswarm auth login/status/logout`
// ============================================

import { password } from '@inquirer/prompts';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import {
  loginAndSaveProfile,
  DEFAULT_OPENAI_CLIENT_ID,
} from '../auth/oauthPkce.js';
import {
  loginAndSaveOpenRouterProfile,
  saveOpenRouterApiKey,
} from '../auth/openrouterPkce.js';
import { loginAndSaveLinearProfile } from '../auth/linearPkce.js';
import { getCodexModelIds } from '../adapters/codexModels.js';
import { safeConsole as console } from '../support/safeLog.js';

type Provider = 'gpt' | 'openrouter' | 'linear';

const PROFILE_KEYS: Record<Provider, string> = {
  gpt: 'openai-gpt:default',
  openrouter: 'openrouter:default',
  linear: 'linear:default',
};

const VALID_PROVIDERS: Provider[] = ['gpt', 'openrouter', 'linear'];

function assertProvider(provider: string): asserts provider is Provider {
  if (!VALID_PROVIDERS.includes(provider as Provider)) {
    console.error(
      `지원하지 않는 provider: "${provider}". 지원: ${VALID_PROVIDERS.join(', ')}`,
    );
    process.exit(1);
  }
}

export interface AuthLoginOpts {
  clientId?: string;
  port?: number;
}

/**
 * 로그인 흐름 (provider별 분기)
 */
export async function handleAuthLogin(
  provider: string,
  opts: AuthLoginOpts,
): Promise<void> {
  assertProvider(provider);

  try {
    if (provider === 'gpt') {
      const clientId =
        opts.clientId ?? process.env.OPENAI_CLIENT_ID ?? DEFAULT_OPENAI_CLIENT_ID;
      await loginAndSaveProfile(clientId, opts.port);
      printGptPostLoginHint();
    } else if (provider === 'linear') {
      await loginAndSaveLinearProfile(opts.port);
      console.log('✓ Linear 연동 완료. `openswarm init`에서 팀/프로젝트를 선택하세요.'); // cxt-ignore: fake_execution — after real OAuth token exchange
    } else {
      await loginOpenRouter(opts);
      printOpenRouterPostLoginHint();
    }
  } catch (err) {
    console.error(`로그인 실패: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function loginOpenRouter(opts: AuthLoginOpts): Promise<void> {
  // API keys must never be supplied through argv because process listings and
  // shell history expose them. Use the environment or hidden prompt instead.
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) {
    saveOpenRouterApiKey(envKey);
    console.log(
      `[Auth] OPENROUTER_API_KEY 환경 변수에서 키를 저장했습니다: ${PROFILE_KEYS.openrouter}`,
    );
    return;
  }

  // PKCE browser flow (primary path).
  try {
    await loginAndSaveOpenRouterProfile(opts.port);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Auth] PKCE 흐름 실패: ${message}`);
    console.error('[Auth] API 키 직접 입력으로 전환합니다.');
  }

  // Interactive API-key fallback when PKCE could not complete.
  const manualKey = await promptForApiKey();
  saveOpenRouterApiKey(manualKey);
  console.log(`[Auth] OpenRouter API key 저장 완료: ${PROFILE_KEYS.openrouter}`);
}

function promptForApiKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('비대화형 환경에서는 OPENROUTER_API_KEY를 사용하세요.');
  }

  return password({ message: 'OpenRouter API key (hidden):' }).then((answer) => {
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error('빈 키가 입력되었습니다.');
    }
    return trimmed;
  });
}

function printGptPostLoginHint(): void {
  console.log('');
  console.log('GPT 어댑터를 사용하려면 config.yaml에서 adapter를 변경하세요:');
  console.log('  adapter: gpt');
  console.log('');
  console.log('또는 CLI에서 직접 실행:');
  console.log('  openswarm run "your task" --model gpt-4o');
}

function printOpenRouterPostLoginHint(): void {
  console.log('');
  console.log('OpenRouter 어댑터를 사용하려면 config.yaml에서 adapter를 변경하세요:');
  console.log('  adapter: openrouter');
  console.log('');
  console.log('또는 CLI에서 직접 실행 (모델은 provider/model 형식):');
  console.log('  openswarm run "your task" --model anthropic/claude-sonnet-4');
}

/**
 * 저장된 인증 프로필 상태 표시
 */
export function handleAuthStatus(): void {
  const store = new AuthProfileStore();
  const profiles = store.listProfiles();
  const keys = Object.keys(profiles);

  if (keys.length === 0) {
    console.log('저장된 인증 프로필이 없습니다.');
    console.log('로그인:');
    console.log('  openswarm auth login --provider gpt');
    console.log('  openswarm auth login --provider openrouter');
    return;
  }

  console.log('인증 프로필:');
  console.log('');

  for (const key of keys) {
    const p = profiles[key];
    const isApiKey = p.type === 'apiKey';
    const expired = !isApiKey && Date.now() > p.expires;
    const expiresAt = isApiKey
      ? '∞ (API key)'
      : `${new Date(p.expires).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${expired ? '만료됨' : '유효'})`;

    console.log(`  ${key}`);
    console.log(`    Provider:   ${p.provider}`);
    console.log(`    Type:       ${p.type}`);
    console.log(`    Token:      ${maskToken(p.access)}`);
    console.log(`    Expires:    ${expiresAt}`);
    if (p.accountId) {
      console.log(`    Account:    ${p.accountId}`);
    }
    console.log('');
  }
}

/**
 * 사용 가능한 Codex 모델 목록 표시.
 * GPT/Codex OAuth 토큰이 있으면 라이브로(chatgpt.com Codex 백엔드) 조회하고,
 * 없으면 ~/.codex 로컬 소스 + 큐레이트 fallback으로 표시한다.
 */
export async function handleAuthModels(): Promise<void> {
  const store = new AuthProfileStore();
  let accessToken: string | undefined;

  if (store.getProfile(PROFILE_KEYS.gpt)) {
    try {
      accessToken = await ensureValidToken(store, PROFILE_KEYS.gpt);
    } catch (err) {
      console.warn(
        `[Auth] 토큰 검증 실패 (${err instanceof Error ? err.message : String(err)}). 오프라인 fallback으로 표시합니다.`,
      );
    }
  } else {
    console.log('GPT/Codex 인증 프로필이 없습니다 — 오프라인 fallback 목록을 표시합니다.');
    console.log('라이브 조회: openswarm auth login --provider gpt');
    console.log('');
  }

  const models = await getCodexModelIds(accessToken);
  const source = accessToken ? 'live · Codex OAuth backend' : 'offline fallback';

  console.log(`Codex 모델 (${source}):`);
  for (const model of models) {
    console.log(`  ${model}`);
  }
}

/**
 * 인증 프로필 삭제
 */
export function handleAuthLogout(provider: string): void {
  assertProvider(provider);

  const profileKey = PROFILE_KEYS[provider];
  const store = new AuthProfileStore();

  if (store.deleteProfile(profileKey)) {
    console.log(`프로필 "${profileKey}" 삭제 완료.`);
  } else {
    console.log(`프로필 "${profileKey}"이(가) 존재하지 않습니다.`);
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '...' + token.slice(-4);
}
