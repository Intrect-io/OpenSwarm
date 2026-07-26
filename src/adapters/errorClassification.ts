// ============================================
// OpenSwarm - Error classification (INT-2010)
// ============================================
//
// Distinguish "the agent's CLI/runtime failed to execute" (infrastructure) from
// "the agent ran and the work is wrong" (a real task failure). Infra failures —
// CLI non-zero exit, auth expiry, spawn ENOENT, timeouts, network drops — must
// NOT count toward the rejection/failure budgets that mark an issue durably
// STUCK: the task itself never got a fair attempt. This mirrors how RateLimitError
// is already special-cased (INT-1906), extended to the broader infra class.
//
// Observed in production (2026-06-28~29): `codex CLI failed with code 1` and
// `Reviewer execution failed: claude CLI failed with code 1` repeatedly drove
// otherwise-completable tasks to STUCK after worker had already edited files.

// Substrings (matched case-insensitively) that mark a failure as infrastructural
// rather than a verdict on the work. Kept conservative — code-logic errors
// (TypeError, assertion failures) are deliberately NOT here, so a genuinely
// broken edit still counts.
const INFRA_ERROR_PATTERNS = [
  'cli failed with code', // codex/claude CLI exited non-zero
  'exited with code',
  'exited with non-zero',
  'non-zero code',
  'enoent', // spawn: binary not found
  'spawn ', // spawn EACCES / spawn failures
  'etimedout',
  'timed out',
  'timeout after',
  'esockettimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket hang up',
  'network error',
  'enospc', // disk full — an environment condition, not a task verdict; backoff-retry once space frees (INT-2521)
  'no space left on device', // the human-readable form of ENOSPC (full phrase, so prose like "no space left for the label" is not mis-flagged)
  'enomem', // out of memory — same class: host resource exhaustion, not a bad edit
  'git-tracker:', // git snapshot/diff failed mid-run — infra, not a task verdict (colon-anchored to avoid prose) (INT-2521)
  'reviewer-stage:', // reviewer ran but its output couldn't be parsed into a verdict — infra, not a quality reject (INT-2521)
  'verify-runner:', // deterministic verifier could not execute; not a quality failure (INT-2662)
  'throttle-retry:', // a 429/limit throttle survived its retry budget — infra for that call, NOT a spent quota (INT-2907)
  'fetch failed', // undici: the real code hides in error.cause.code (checked below)
  'terminated', // undici mid-stream socket drop
  'unauthorized',
  'forbidden',
  'not authenticated',
  'authentication failed',
  'invalid api key',
  'permission denied',
  // NOTE: bare '401'/'403' were removed — they matched prose like "line 401" or
  // "error 4013". Real auth failures carry a word ('unauthorized'/'forbidden'/…)
  // or an adapter/HTTP-status wrapper, both covered here + in INFRA_ERROR_REGEXES. (INT-2521)
  // Server-side capacity / gateway failures — the model server was reachable but
  // could not serve (model loading, overloaded, upstream down). Not a verdict on
  // the task. 429/402 are handled as RateLimitError, not here. Use unambiguous
  // reason phrases (not bare "503") so task text like "expected 503 rows" is not
  // mis-flagged; the numeric-status forms go through INFRA_ERROR_REGEXES. (INT-2520)
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'overloaded',
  'model is loading',
  'model not loaded',
];

// Numeric HTTP status matched ONLY with surrounding context (an adapter error
// wrapper like "Local API error (503)", or "HTTP 503" / "status 503"), so a bare
// number in task/reviewer prose is not mistaken for an infra failure. (INT-2520)
const INFRA_ERROR_REGEXES: readonly RegExp[] = [
  // Adapter error wrappers only ("OpenAI API error (503)", "Local API error (401)",
  // "Codex responses error (504)") — NOT a bare "(503)" in prose, so a task/reviewer
  // message like "expected (503)" is not mis-flagged. Covers auth (401/403) and
  // server-capacity (5xx) status codes. (INT-2520, INT-2521)
  /(?:api|responses) error \((40[13]|50[234])\)/,
  // "http"/"status" only — NOT "code", which collides with generic application
  // error codes ("error code 401: invalid form field"). Real HTTP failures say
  // http/status or carry an adapter wrapper / auth word. (INT-2521)
  /\b(?:http|status)\s*[:=]?\s*(40[13]|50[234])\b/,
];

/**
 * True when `error` looks like an infrastructure/runtime failure of the agent
 * CLI rather than a substantive failure of the task. Used to keep such failures
 * out of the STUCK-inducing rejection/failure counts (they get a backoff retry
 * instead). (INT-2010)
 */
export function isInfraError(error: unknown): boolean {
  // A request that ran past its deadline is infrastructure, not a verdict on
  // the task. AbortSignal.timeout() rejects with a DOMException named
  // TimeoutError whose message — "The operation was aborted due to timeout" —
  // matches none of the patterns below ('timed out', 'timeout after'), so
  // without this a provider that accepted a request and then went silent was
  // reported as the task itself failing. A user abort is deliberately not
  // included: that is a stop, not a fault.
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  // undici wraps connection failures as `TypeError: fetch failed` with the real
  // code (ECONNREFUSED / ECONNRESET / UND_ERR_*) on `error.cause.code` — the
  // top-level message alone would be classed a task failure. (INT-2520)
  const causeCode =
    error && typeof error === 'object' && 'cause' in error
      ? String((error as { cause?: { code?: unknown } }).cause?.code ?? '').toLowerCase()
      : '';
  if (causeCode && INFRA_ERROR_PATTERNS.some((p) => causeCode.includes(p))) return true;
  if (causeCode.startsWith('und_err')) return true; // any undici transport error
  if (!msg) return false;
  return INFRA_ERROR_PATTERNS.some((p) => msg.includes(p)) || INFRA_ERROR_REGEXES.some((r) => r.test(msg));
}

/** Distinguish wall-clock exhaustion from other infrastructure failures. */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return msg.includes('timed out') || msg.includes('timeout after');
}

/**
 * Diagnostic hint for the opaque failure where codex CLI dies because an MCP server
 * declared in ~/.codex/config.toml is OAuth-protected. A direct `url=` MCP server that
 * returns 401 makes codex's rmcp transport quit with a fatal line like:
 *   rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired
 * That message names neither the config file nor the real cause, so the failure looks
 * like a generic `codex CLI failed with code 1`. This returns a one-line pointer at the
 * actual fix; returns null for unrelated errors. Pure and additive — it does NOT change
 * error classification (isInfraError still owns that) or any control flow. (INT-2408)
 */
export function codexMcpAuthHint(error: unknown): string | null {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (!msg) return null;
  const authRequired = msg.includes('authrequired');
  const rmcpTransport = msg.includes('rmcp') || msg.includes('transport channel closed');
  if (!authRequired || !rmcpTransport) return null;
  return (
    "codex CLI: an MCP server in ~/.codex/config.toml returned 401 (OAuth). " +
    "Replace a direct 'url=' server with an mcp-remote (stdio) entry, or remove it."
  );
}
