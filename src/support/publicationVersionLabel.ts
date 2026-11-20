// ============================================
// OpenSwarm — version:* label on the PRs it opens (AGT-4269)
// ============================================
//
// vega-agent gates every PR on exactly one `version:*` label (version-label.yml):
// a PR merged without one bumps nothing, so the release never fires and the
// change silently never reaches the installed app. On 2026-09-10 all five open
// swarm PRs failed that check with `LABELS: []` — not a human slip, OpenSwarm
// simply never labelled. A check that is red by default hides the real failures
// behind it (#690's type error and #691's regression were buried that way).
//
// The label is derived from the title's kind prefix. When the kind does not
// decide it, the PR opens unlabelled and the body says why: a wrong label is
// worse than none, because a human reviewing a red check will pick one, while a
// wrong green one is never looked at again.
//
// Repositories that do not define the version:* labels are left alone — `gh pr
// create --label` with an unknown label fails the whole create.

import { ghWithTimeout } from './ghPullRequests.js';

/** Label lookups are best-effort: a slow gh must not stall a publication. */
const LABEL_LOOKUP_TIMEOUT_MS = 15_000;

export type GhRunner = (cwd: string, ...args: string[]) => Promise<string>;
const shortGh: GhRunner = (cwd, ...args) => ghWithTimeout(cwd, LABEL_LOOKUP_TIMEOUT_MS, ...args);

export type VersionLabel = 'version:skip' | 'version:patch' | 'version:minor';

const KIND_TO_LABEL: Readonly<Record<string, VersionLabel>> = {
  test: 'version:skip',
  tests: 'version:skip',
  ci: 'version:skip',
  docs: 'version:skip',
  doc: 'version:skip',
  chore: 'version:skip',
  bug: 'version:patch',
  bugfix: 'version:patch',
  fix: 'version:patch',
  hotfix: 'version:patch',
  perf: 'version:patch',
  feature: 'version:minor',
  feat: 'version:minor',
};

// Leading issue identifiers a caller may prepend: "AGT-123:", "[AGT-123]", "(AGT-123)".
const LEADING_ISSUE_ID_RE = /^\s*(?:\[[A-Z][A-Z0-9]*-\d+\]|\([A-Z][A-Z0-9]*-\d+\)|[A-Z][A-Z0-9]*-\d+:?)\s*/;
// "[CI] …", "[BUG] …"
const BRACKET_KIND_RE = /^\s*\[([A-Za-z]+)\]/;
// "fix: …", "ci(gate): …", "feat!: …" — the "!" (breaking) is captured so it is not mapped.
const CONVENTIONAL_KIND_RE = /^\s*([A-Za-z]+)(?:\([^)]*\))?(!?):/;

export type VersionLabelDecision =
  | { label: VersionLabel; kind: string }
  | { label: null; reason: string };

/** Decide the version:* label from a PR/issue title. Pure. */
export function versionLabelForTitle(title: string): VersionLabelDecision {
  let rest = title;
  // Strip any number of leading issue identifiers.
  for (let i = 0; i < 3; i++) {
    const stripped = rest.replace(LEADING_ISSUE_ID_RE, '');
    if (stripped === rest) break;
    rest = stripped;
  }

  let bracket = BRACKET_KIND_RE.exec(rest);
  // "[WIP] fix: x" / "[Desktop] feat: x": a bracket tag that is not a kind
  // does not hide the conventional prefix of the remaining title.
  if (bracket && !KIND_TO_LABEL[bracket[1].toLowerCase()]) {
    const tail = rest.replace(BRACKET_KIND_RE, '');
    const tailKind = CONVENTIONAL_KIND_RE.exec(tail);
    if (tailKind && (tailKind[2] === '!' || KIND_TO_LABEL[tailKind[1].toLowerCase()])) {
      rest = tail;
      bracket = null;
    }
  }
  const conventional = bracket ? null : CONVENTIONAL_KIND_RE.exec(rest);
  const rawKind = bracket?.[1] ?? conventional?.[1];
  if (!rawKind) {
    return { label: null, reason: 'the title has no kind prefix (e.g. `[BUG]`, `fix:`, `feat(scope):`)' };
  }
  const kind = rawKind.toLowerCase();
  if (conventional?.[2] === '!') {
    return { label: null, reason: `\`${rawKind}!\` marks a breaking change — major or minor is a release decision` };
  }
  const label = KIND_TO_LABEL[kind];
  if (!label) {
    return { label: null, reason: `the kind \`${rawKind}\` does not decide whether this ships (skip, patch or minor)` };
  }
  return { label, kind };
}

export interface VersionLabelLookup {
  /** version:* labels the repository defines (empty when it defines none). */
  labels: Set<string>;
  /** Set when the lookup itself failed (auth, rate limit, timeout): "no labels" is then unknown, not known. */
  failure?: string;
}

function shortReason(e: unknown): string {
  // execFile errors carry the CLI's own message in stderr; `message` is just the command line.
  const stderr = (e as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e);
  return (text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'unknown error').slice(0, 160);
}

/**
 * The version:* labels the repository defines. A failed lookup is reported as
 * `failure` — distinct from a repository that defines none — and never throws:
 * the PR is opened without a label either way.
 */
export async function repoVersionLabels(cwd: string, run: GhRunner = shortGh): Promise<VersionLabelLookup> {
  try {
    const out = await run(cwd, 'label', 'list', '--search', 'version:', '--limit', '100', '--json', 'name', '--jq', '.[].name');
    return { labels: new Set(out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('version:'))) };
  } catch (e) {
    console.warn('[Worktree] version label lookup failed — opening the PR without one:', e);
    return { labels: new Set(), failure: shortReason(e) };
  }
}

export interface VersionLabelPlan {
  /** Extra `gh pr create` arguments (`--label …`), possibly empty. */
  createArgs: string[];
  /** PR body section explaining a missing label, or ''. */
  bodySection: string;
}

/** Combine the title decision with what the repository supports. Pure. */
export function planVersionLabel(title: string, lookup: ReadonlySet<string> | VersionLabelLookup): VersionLabelPlan {
  const available = 'labels' in lookup ? lookup.labels : lookup;
  const failure = 'labels' in lookup ? lookup.failure : undefined;
  if (failure) {
    return {
      createArgs: [],
      bodySection: `## Version label\nVersion label: lookup failed: ${failure}; add one by hand.`,
    };
  }
  if (available.size === 0) return { createArgs: [], bodySection: '' };
  const decision = versionLabelForTitle(title);
  if (decision.label !== null && available.has(decision.label)) {
    return { createArgs: ['--label', decision.label], bodySection: '' };
  }
  const reason = decision.label === null
    ? decision.reason
    : `the title maps to \`${decision.label}\`, but this repository does not define that label`;
  return {
    createArgs: [],
    bodySection: [
      '## Version label',
      `Opened without a \`version:*\` label: ${reason}. A reviewer picks one before merging.`,
    ].join('\n'),
  };
}

/** Plan the label for a PR about to be created in `cwd`'s repository (one call per creation site). */
export async function versionLabelFor(cwd: string, title: string, run: GhRunner = shortGh): Promise<VersionLabelPlan> {
  return planVersionLabel(title, await repoVersionLabels(cwd, run));
}

/**
 * Best-effort: give a reused or raced PR the version:* label it would have been
 * opened with. A PR that already carries one is left alone. Never throws.
 */
export async function ensureVersionLabel(cwd: string, prUrl: string, title: string, run: GhRunner = shortGh): Promise<void> {
  try {
    const decision = versionLabelForTitle(title);
    if (decision.label === null) return;
    const present = (await run(cwd, 'pr', 'view', prUrl, '--json', 'labels', '--jq', '.labels[].name'))
      .split('\n').map((s) => s.trim());
    if (present.some((l) => l.startsWith('version:'))) return;
    const lookup = await repoVersionLabels(cwd, run);
    if (lookup.failure || !lookup.labels.has(decision.label)) return;
    await run(cwd, 'pr', 'edit', prUrl, '--add-label', decision.label);
  } catch (e) {
    console.warn(`[Worktree] could not add a version label to ${prUrl}:`, e);
  }
}
