// ============================================
// OpenSwarm - Agent identity fallback names
// ============================================
//
// Agents choose their own display names (any style they like) via the
// `codename` field of their first structured output; that choice is
// registered in pipelineCoordination's name registry. What lives here is the
// DETERMINISTIC FALLBACK identity an agent carries before it has spoken:
// stable (same worker in the same repository resolves to the same fallback
// across restarts) and deliberately plain — `worker-3f2a` — so a themed
// convention never overrides the agent's own choice.

import { createHash } from 'node:crypto';

/** The role a call sign carries, so a name also states what the agent does. */
export type AgentRole = 'worker' | 'reviewer' | 'orchestrator' | 'review-agent';

export interface AgentCallSign {
  /** Human-facing call sign, e.g. `worker-3f2a` (fallback) or a self-chosen name. */
  name: string;
  /** Lowercase, punctuation-free address used for mailbox routing. */
  address: string;
  role: AgentRole;
}

function digestOf(parts: readonly string[]): Buffer {
  return createHash('sha256').update(parts.join('\0')).digest();
}

function compose(role: string, digest: Buffer, salt: number): string {
  const hex = digest.subarray(salt % 16, (salt % 16) + 2).toString('hex');
  return `${role}-${hex}`;
}

/** Normalize a call sign into its routable address form. */
export function callSignAddress(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Resolve a stable call sign for one agent identity.
 *
 * `taken` holds the addresses already in use by other live identities in this
 * repository; a collision advances to the next candidate rather than letting
 * two active agents answer to one name.
 */
export function assignCallSign(
  input: { repository: string; executionId: string; role: AgentRole },
  taken: ReadonlySet<string> = new Set(),
): AgentCallSign {
  const digest = digestOf([input.repository, input.executionId, input.role]);
  for (let salt = 0; salt < 30; salt += 1) {
    const name = compose(input.role, digest, salt);
    const address = callSignAddress(name);
    if (!taken.has(address)) return { name, address, role: input.role };
  }
  const fallback = `${input.role}-${digest.toString('hex').slice(0, 8)}`;
  return { name: fallback, address: callSignAddress(fallback), role: input.role };
}

/**
 * Strip markup and mention characters from a model-supplied display name so a
 * codename cannot smuggle Markdown structure or @-mentions into the
 * coordination board or Linear comments. Returns null when nothing
 * displayable remains. Every surface that renders a chosen name must pass it
 * through here first — the name arrives from the model, not from us.
 */
export function sanitizeAgentDisplayName(raw: string | undefined): string | null {
  const cleaned = String(raw ?? '')
    .replace(/[\r\n`*_#>[\]|@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned || null;
}
