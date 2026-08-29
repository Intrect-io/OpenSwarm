// ============================================
// OpenSwarm - Agent identity
// ============================================
//
// Every agent on the coordination board gets an assigned handle. It is
// deterministic from (repository, executionId, role), so the same agent
// answers to the same handle across restarts, and it is drawn from
// role-flavoured vocabulary so a reviewer does not read like a worker.
//
// Two rules the operator set, both load-bearing (AGT-4064):
//
//  - **No `role-hex`.** The previous fallback produced `reviewer-b0bc`, which
//    reads as a machine ID rather than a participant in a conversation.
//  - **No numeric collision suffixes.** Agents used to name themselves, and a
//    collision appended " 2". Because the collision set included agents that
//    had finished hours earlier, a name that was merely *used before* got
//    bumped — and the bumped name reached later agents through the board
//    history they read, so a model would report `Codename: Atlas 3` as its own
//    choice and get bumped again to `Atlas 3 2`. The numbering fed itself.
//    A collision now picks a different handle; it never decorates one.
//
// Handles come in several shapes so a board does not read as one template
// repeated: `MopReviewer3744`, `kestrel_qa`, `NimbusReviews`, `mosslark42`.

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

// Role-flavoured vocabulary: a reviewer should not read like a worker. Words
// are concrete and ordinary — the kind of thing a person picks for a handle —
// and none of them is a role keyword, so no generated handle can land in the
// `role-hex` shape this module is here to avoid.
const SUBJECTS: Readonly<Record<AgentRole, readonly string[]>> = {
  worker: [
    'anvil', 'kestrel', 'harbor', 'lathe', 'quarry', 'rivet', 'timber', 'beacon',
    'cinder', 'drift', 'gable', 'halyard', 'mason', 'nimbus', 'orchard', 'pylon',
    'ridge', 'solder', 'trellis', 'vault', 'willow', 'basalt', 'copper', 'dovetail',
    'ember', 'furrow', 'granite', 'hollow', 'juniper', 'kiln',
  ],
  reviewer: [
    'mop', 'lens', 'sieve', 'ledger', 'sentry', 'tally', 'plumb', 'caliper',
    'compass', 'gauge', 'warden', 'sifter', 'marker', 'thistle', 'bramble', 'lantern',
    'pumice', 'quill', 'sable', 'tinder', 'verge', 'wicker', 'amber', 'burrow',
    'clover', 'dapple', 'fathom', 'garnet', 'heron', 'indigo',
  ],
  orchestrator: [
    'relay', 'dispatch', 'switch', 'pilot', 'signal', 'junction', 'tiller', 'rudder',
    'atlas', 'cairn', 'ferry', 'lattice', 'meridian', 'pivot', 'span', 'trailhead',
  ],
  'review-agent': [
    'audit', 'probe', 'survey', 'canvas', 'sweep', 'scope', 'reckon', 'tessera',
    'almanac', 'bellwether', 'cadence', 'docket', 'errata', 'foolscap',
  ],
};

/** Shape A's role word — the `Reviewer` in `MopReviewer3744`. */
const ROLE_WORDS: Readonly<Record<AgentRole, readonly string[]>> = {
  worker: ['Dev', 'Builder', 'Eng', 'Maker'],
  reviewer: ['Reviewer', 'Checker', 'QA', 'Auditor'],
  orchestrator: ['Ops', 'Lead', 'Runner', 'Coord'],
  'review-agent': ['Audit', 'Scan', 'Sweep', 'Review'],
};

/** Shape B's lowercase tag — the `qa` in `kestrel_qa`. */
const ROLE_TAGS: Readonly<Record<AgentRole, readonly string[]>> = {
  worker: ['dev', 'eng', 'build', 'wip'],
  reviewer: ['qa', 'review', 'check', 'rv'],
  orchestrator: ['ops', 'lead', 'run', 'hq'],
  'review-agent': ['audit', 'scan', 'sweep', 'rev'],
};

/** Shape C's trailing word — the `Reviews` in `NimbusReviews`. */
const ROLE_SUFFIXES: Readonly<Record<AgentRole, readonly string[]>> = {
  worker: ['Builds', 'Works', 'Forge', 'Labs'],
  reviewer: ['Reviews', 'Checks', 'Audits', 'Notes'],
  orchestrator: ['Runs', 'Ops', 'Board', 'Desk'],
  'review-agent': ['Audits', 'Scans', 'Sweeps', 'Reports'],
};

const HANDLE_SHAPES = 4;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Build one handle from the digest. `salt` shifts which bytes are read, so a
 * collision moves to a genuinely different handle instead of decorating the
 * one it wanted with a number.
 */
function composeHandle(role: AgentRole, digest: Buffer, salt: number): string {
  const at = (i: number): number => digest[(i * 3 + salt * 7) % digest.length];
  const pick = <T>(list: readonly T[], i: number): T => list[at(i) % list.length];
  const subjects = SUBJECTS[role];
  const subject = pick(subjects, 1);
  // Offset by at least one so the compound shape never doubles a word
  // (`heronheron27` reads like a bug, not a handle).
  const second = subjects[(subjects.indexOf(subject) + 1 + (at(2) % (subjects.length - 1))) % subjects.length];

  switch (at(0) % HANDLE_SHAPES) {
    case 0: // MopReviewer3744
      return `${capitalize(subject)}${pick(ROLE_WORDS[role], 3)}${String(((at(4) << 8) | at(5)) % 10_000).padStart(4, '0')}`;
    case 1: // kestrel_qa
      return `${subject}_${pick(ROLE_TAGS[role], 6)}`;
    case 2: // NimbusReviews
      return `${capitalize(subject)}${pick(ROLE_SUFFIXES[role], 7)}`;
    default: // mosslark42
      return `${subject}${second}${String(at(8) % 100).padStart(2, '0')}`;
  }
}

/** Normalize a call sign into its routable address form. */
export function callSignAddress(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Roles resolved in a fixed order so cross-role avoidance is deterministic:
// each role skips any handle an earlier role on the same task already took.
const ROLE_ORDER: readonly AgentRole[] = ['orchestrator', 'review-agent', 'worker', 'reviewer'];

/**
 * Resolve a stable handle for one agent identity.
 *
 * Purely a function of (repository, executionId, role) — no process state — so
 * a daemon restart resolves the same identity to the same handle. That matters
 * because a reply is addressed to a handle: if a restart renamed a live
 * participant, the answer would sit in an inbox nobody reads. (Caught by the
 * PR review on AGT-4064: an earlier version probed against an in-memory
 * registry, which made a collision-resolved handle restart-dependent.)
 *
 * Collisions are avoided only against the other roles on the SAME task, and
 * that is sufficient: `CoordinationStore.consume` filters by `taskId` as well
 * as recipient, so two agents on different tasks cannot read each other's mail
 * even when their handles coincide.
 *
 * `taken` remains available for a caller that knows of addresses it must avoid;
 * production callers pass nothing and stay deterministic.
 */
export function assignCallSign(
  input: { repository: string; executionId: string; role: AgentRole },
  taken: ReadonlySet<string> = new Set(),
): AgentCallSign {
  const blocked = new Set(taken);
  for (const other of ROLE_ORDER) {
    if (other === input.role) break;
    blocked.add(callSignAddress(handleFor({ ...input, role: other }, blocked)));
  }
  const name = handleFor(input, blocked);
  return { name, address: callSignAddress(name), role: input.role };
}

function handleFor(
  input: { repository: string; executionId: string; role: AgentRole },
  blocked: ReadonlySet<string>,
): string {
  const digest = digestOf([input.repository, input.executionId, input.role]);
  for (let salt = 0; salt < 64; salt += 1) {
    const name = composeHandle(input.role, digest, salt);
    if (!blocked.has(callSignAddress(name))) return name;
  }
  // Every probe collided — vanishingly unlikely, but the handle still has to be
  // distinct. Widen with digest hex rather than a counter, and keep the shape:
  // no `role-hex`, no " 2".
  return `${composeHandle(input.role, digest, 0)}${digest.toString('hex').slice(0, 4)}`;
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
