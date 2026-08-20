// ============================================
// OpenSwarm - Explicitly approved model-provider egress
// ============================================
//
// Agent runs may include repository content in a model request. Keep that
// deliberate transfer on a narrow, auditable boundary: only the providers that
// the CLI implements may receive such a request, and every target is HTTPS.

const APPROVED_MODEL_ENDPOINTS = new Set([
  'https://api.atlascloud.ai/v1/chat/completions',
  'https://chatgpt.com/backend-api/codex/responses',
  'https://api.openai.com/v1/chat/completions',
  'https://openrouter.ai/api/v1/chat/completions',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ApprovedEgressRequest {
  url: string;
  body: string;
}

/**
 * Serialize a request only after its exact provider endpoint has passed the
 * egress allowlist. Callers must not send model prompts through raw `fetch`.
 */
export function prepareApprovedModelRequest(endpoint: string, payload: unknown): ApprovedEgressRequest {
  if (!APPROVED_MODEL_ENDPOINTS.has(endpoint)) {
    throw new Error(`Refusing model request to unapproved endpoint: ${endpoint}`);
  }
  return { url: endpoint, body: JSON.stringify(payload) };
}

/**
 * Resolve a local OpenAI-compatible API route only when its configurable base
 * points at loopback. This also protects the probe requests that carry a local
 * API key but no model prompt.
 */
export function approvedLocalModelEndpoint(
  baseUrl: string,
  path: '/v1/models' | '/v1/chat/completions',
): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`Refusing model request to invalid local endpoint: ${baseUrl}`);
  }

  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== '' && base.pathname !== '/')
  ) {
    throw new Error(`Refusing model request to unapproved local endpoint: ${baseUrl}`);
  }

  return new URL(path, base).href;
}

/**
 * Local adapters may send prompts only to loopback OpenAI-compatible servers.
 * The base URL is user-configurable, so validate it before serializing the
 * fixed chat-completions request instead of treating every configured URL as
 * trusted.
 */
export function prepareApprovedLocalModelRequest(baseUrl: string, payload: unknown): ApprovedEgressRequest {
  return {
    url: approvedLocalModelEndpoint(baseUrl, '/v1/chat/completions'),
    body: JSON.stringify(payload),
  };
}
