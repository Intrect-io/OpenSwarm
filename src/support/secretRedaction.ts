// ============================================
// OpenSwarm — redact secret-shaped values from text written to disk
// ============================================
//
// A worker that greps a repository with a `.env` in it prints the real
// credential in its tool output, and the session transcript recorded it
// verbatim (measured 2026-09-29: a live Linear API key, five times, in one
// transcript). Fixing the file mode stops other local users reading it; this
// keeps the value out of the file at all. (AGT-4608)
//
// The patterns are shapes, not a list of known values: provider key prefixes,
// bearer headers, private-key blocks, and NAME=value assignments whose name
// says it is a secret. The replacement has no quote or backslash, so it is
// safe to apply to a serialized JSON line.

export const REDACTED = '[redacted]';

const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private keys (the whole block, or as much as the line holds).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Authorization headers.
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Provider key shapes.
  /\b(?:sk|pk|rk)-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];

/**
 * NAME=value or NAME: value where NAME is an environment-style (upper-case)
 * name that says it holds a secret; the value is replaced. Upper case only, so
 * code such as `const token = getToken()` is left alone.
 */
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)(\\?["']?)([^\s"'\\,;}()]{6,})/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}${REDACTED}`);
}
