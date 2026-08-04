// ============================================
// OpenSwarm — environment handed to spawned agent processes
// ============================================
//
// `env: process.env` gives a child every secret this process holds: provider
// keys for adapters it will never use, the Linear token, npm and GitHub
// credentials. That is fine for a process we fully control and wrong for one
// running an agent, which reads untrusted content and can be talked into
// echoing what it can see. The default here is an allowlist, and each call site
// names the extra variables its own child legitimately needs.

/** Enough for a child to find its interpreter, its home, and a temp directory. */
const BASE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
];

/**
 * The inherited environment, reduced to the base allowlist plus whatever
 * `extraKeys` names. A key may be an exact name or a `PREFIX_` string, which
 * admits every variable starting with it — provider CLIs tend to read a family
 * of variables rather than one.
 */
export function safeInheritedEnv(extraKeys: readonly string[] = []): Record<string, string> {
  const exact = new Set([...BASE_ENV_ALLOWLIST, ...extraKeys.filter((k) => !k.endsWith('_'))]);
  const prefixes = extraKeys.filter((k) => k.endsWith('_'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) env[key] = value;
  }
  return env;
}

/**
 * What the `claude` CLI itself needs. Its credentials normally live under
 * `~/.claude` (so `HOME` covers them), but an operator may authenticate through
 * these instead, and a spawn that silently could not authenticate is a worse
 * outcome than a slightly wider allowlist. Every *other* provider's key stays
 * out.
 */
export const CLAUDE_CLI_ENV_KEYS = ['ANTHROPIC_', 'CLAUDE_', 'XDG_CONFIG_HOME'] as const;
