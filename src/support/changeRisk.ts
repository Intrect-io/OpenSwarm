// ============================================
// OpenSwarm — how risky a change is, from its final diff (AGT-4804)
// ============================================
//
// The merge steward and the human-approval rule both need to know how risky a
// change is, and nothing classified one. This is a deterministic classifier
// over the diff the publisher commits: which paths changed, how many files and
// lines, whether dependencies moved, and whether the project's own protected
// paths were touched. It reads no model and no issue text, so the same diff
// always gets the same class.
//
// Three levels, and every rule can only RAISE the level:
//   high   — deploy/infra, CI, migrations, auth and secrets, protected paths,
//            or a change past the medium size limits;
//   medium — dependency manifests and lockfiles, binary files, or a change
//            past the low size limits;
//   low    — everything else.
// A diff that cannot be read is `medium`, never `low`: unknown is not safe.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { globToRegExp } from '../agents/protectedFiles.js';
import { loadPublicationRiskRules } from './repoMetadata.js';

const exec = promisify(execFile);

export type ChangeRiskLevel = 'low' | 'medium' | 'high';

/** One changed file. `null` line counts mean git could not count them (binary). */
export interface DiffFileStat {
  path: string;
  added: number | null;
  deleted: number | null;
}

/**
 * Per-project rules, read from the repository's `openswarm.json` under
 * `publication.risk`. Paths are globs (`**` spans directories). Every field is
 * optional and adds to — never replaces — the conservative default.
 */
export interface ChangeRiskRules {
  /** Extra paths that make a change high risk. */
  highPaths?: string[];
  /** Extra paths that make a change at least medium risk. */
  mediumPaths?: string[];
  /** The project's own protected paths; touching one is high risk. */
  protectedPaths?: string[];
  /** Largest change (files / added+deleted lines) that can still be low. */
  lowMaxFiles?: number;
  lowMaxLines?: number;
  /** Largest change that can still be medium; beyond it is high. */
  mediumMaxFiles?: number;
  mediumMaxLines?: number;
}

export interface ChangeRisk {
  level: ChangeRiskLevel;
  /** Why, most severe first — one line per rule that fired. */
  reasons: string[];
  files: number;
  /** Added + deleted lines over the files git could count. */
  lines: number;
}

export const DEFAULT_RISK_LIMITS = {
  lowMaxFiles: 5,
  lowMaxLines: 150,
  mediumMaxFiles: 20,
  mediumMaxLines: 600,
} as const;

/**
 * Paths whose change is high risk in any project, with the reason shown on the
 * PR. `docsExempt` rules do not fire on documentation files: a README under
 * `infra/` changes no deployment, while a document that names keys still
 * belongs with the secrets it describes.
 */
const DEFAULT_HIGH_PATHS: ReadonlyArray<{ pattern: RegExp; reason: string; docsExempt?: boolean }> = [
  { pattern: /(?:^|\/)(?:deploy(?:ment)?s?|infra(?:structure)?|terraform|k8s|kubernetes|helm|charts|ansible)\//i, reason: 'deploy/infra', docsExempt: true },
  { pattern: /(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|wrangler\.toml|fly\.toml|vercel\.json|netlify\.toml|Procfile|[^/]+\.tf)$/i, reason: 'deploy/infra', docsExempt: true },
  { pattern: /(?:^|\/)(?:deploy|release)[^/]*\.(?:sh|py|ts|js|mjs)$/i, reason: 'deploy/infra', docsExempt: true },
  { pattern: /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|(?:^|\/)Jenkinsfile$|^azure-pipelines|^\.githooks\/|^\.github\/actions\//i, reason: 'CI', docsExempt: true },
  { pattern: /(?:^|\/)(?:migrations?|alembic)\/|\.sql$/i, reason: 'migration' },
  { pattern: /(?:^|[/._-])(?:auth|oauth|secrets?|credentials?|passwords?|permissions?|rbac|acl|keys?|tokens?|crypto|encrypt(?:ion)?)(?:[/._-]|$)/i, reason: 'auth/secrets' },
  { pattern: /(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|keystore)$/i, reason: 'auth/secrets' },
];

/** Dependency manifests and lockfiles: a change here is at least medium. */
const DEPENDENCY_FILE = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|setup\.py|setup\.cfg|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(?:\.lock)?|composer\.(?:json|lock)|build\.gradle(?:\.kts)?|pom\.xml)$/;

const DOC_FILE = /(?:^|\/)(?:docs?|documentation)\/|\.(?:md|mdx|rst|txt|adoc)$/i;

const RANK: Record<ChangeRiskLevel, number> = { low: 0, medium: 1, high: 2 };

function raise(current: ChangeRiskLevel, to: ChangeRiskLevel): ChangeRiskLevel {
  return RANK[to] > RANK[current] ? to : current;
}

/** Parse `git diff --numstat` output; null when a line does not have its shape. */
export function parseNumstat(text: string): DiffFileStat[] | null {
  const stats: DiffFileStat[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) return null;
    stats.push({
      path: renamedPath(match[3]),
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return stats;
}

/** `src/{a => b}/x.ts` and `a => b` (renames) → the new path. */
function renamedPath(path: string): string {
  const braced = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replace(/\/\//g, '/');
  const plain = / => (.+)$/.exec(path);
  return plain ? plain[1] : path;
}

function matchesAny(path: string, globs: readonly string[] | undefined): boolean {
  return (globs ?? []).some((glob) => globToRegExp(glob).test(path));
}

/**
 * Classify a diff. `diff === null` means the diff could not be read — that is
 * `medium`, because an unknown change is not a safe one.
 */
export function classifyChangeRisk(
  diff: readonly DiffFileStat[] | null,
  rules: ChangeRiskRules = {},
  protectedFiles: readonly string[] = [],
): ChangeRisk {
  if (diff === null) {
    return { level: 'medium', reasons: ['unknown: the diff could not be read'], files: 0, lines: 0 };
  }
  const high = new Set<string>();
  const medium = new Set<string>();
  let lines = 0;
  let uncounted = 0;

  for (const file of diff) {
    if (file.added === null || file.deleted === null) uncounted++;
    else lines += file.added + file.deleted;

    const isDoc = DOC_FILE.test(file.path);
    for (const { pattern, reason, docsExempt } of DEFAULT_HIGH_PATHS) {
      if (docsExempt && isDoc) continue;
      if (pattern.test(file.path)) high.add(`${reason}: \`${file.path}\``);
    }
    if (protectedFiles.includes(file.path) || matchesAny(file.path, rules.protectedPaths)) {
      high.add(`protected file: \`${file.path}\``);
    }
    if (matchesAny(file.path, rules.highPaths)) high.add(`project high-risk path: \`${file.path}\``);
    if (DEPENDENCY_FILE.test(file.path)) medium.add(`dependencies: \`${file.path}\``);
    if (matchesAny(file.path, rules.mediumPaths)) medium.add(`project medium-risk path: \`${file.path}\``);
  }
  if (uncounted > 0) medium.add(`${uncounted} file(s) git cannot count lines for (binary)`);

  const limits = { ...DEFAULT_RISK_LIMITS, ...definedOnly(rules) };
  const files = diff.length;
  const docsOnly = files > 0 && diff.every((file) => DOC_FILE.test(file.path));
  if (files > limits.mediumMaxFiles || lines > limits.mediumMaxLines) {
    // A large documentation change is reviewed for wording, not for breakage.
    (docsOnly ? medium : high).add(`size: ${files} file(s), ${lines} line(s) (medium limit ${limits.mediumMaxFiles} / ${limits.mediumMaxLines})`);
  } else if (files > limits.lowMaxFiles || lines > limits.lowMaxLines) {
    medium.add(`size: ${files} file(s), ${lines} line(s) (low limit ${limits.lowMaxFiles} / ${limits.lowMaxLines})`);
  }

  let level: ChangeRiskLevel = 'low';
  if (medium.size > 0) level = raise(level, 'medium');
  if (high.size > 0) level = raise(level, 'high');
  return { level, reasons: [...high, ...medium], files, lines };
}

function definedOnly(rules: ChangeRiskRules): Partial<typeof DEFAULT_RISK_LIMITS> {
  const out: Record<string, number> = {};
  for (const key of ['lowMaxFiles', 'lowMaxLines', 'mediumMaxFiles', 'mediumMaxLines'] as const) {
    const value = rules[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** The PR body section. Kept short: the level, then why. */
export function changeRiskSection(risk: ChangeRisk): string {
  const lines = [`## Risk: ${risk.level}`];
  if (risk.reasons.length === 0) {
    lines.push(`${risk.files} file(s), ${risk.lines} line(s); no high- or medium-risk path.`);
  } else {
    const shown = risk.reasons.slice(0, 8);
    lines.push(...shown.map((reason) => `- ${reason}`));
    if (risk.reasons.length > shown.length) lines.push(`- … ${risk.reasons.length - shown.length} more`);
  }
  return lines.join('\n');
}

/**
 * Classify what this branch changed since it left `baseRef` (three dots, the
 * same range the change-shape section uses). A git failure yields the
 * `unknown → medium` class rather than throwing: classification must never
 * block a publication.
 */
export async function classifyBranchRisk(
  worktreePath: string,
  baseRef: string,
  rules: ChangeRiskRules | undefined,
  protectedFiles: readonly string[] = [],
): Promise<ChangeRisk> {
  try {
    // quotepath off: git otherwise prints a non-ASCII path quoted and escaped
    // (`"\355\225\234.sql"`), and every suffix rule would miss it. cgf-portal
    // tracks Korean file names.
    const { stdout } = await exec('git', ['-c', 'core.quotepath=false', 'diff', '--numstat', '-M', `${baseRef}...HEAD`], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024,
    });
    return classifyChangeRisk(parseNumstat(stdout), rules ?? {}, protectedFiles);
  } catch {
    return classifyChangeRisk(null);
  }
}

/**
 * The publisher's entry point: the repository's rules are read from the
 * operator's checkout (`originalPath`), not from the worktree the worker
 * edited, so a run cannot relax the rules that classify its own diff.
 */
export async function publicationRisk(
  originalPath: string,
  worktreePath: string,
  baseRef: string,
  protectedFiles: readonly string[] = [],
): Promise<ChangeRisk> {
  return classifyBranchRisk(worktreePath, baseRef, await loadPublicationRiskRules(originalPath), protectedFiles);
}
