import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { safeConsole as console } from '../support/safeLog.js';
import type { IntegrationSiblingResult } from './integrationCoordinator.js';

const execFileAsync = promisify(execFile);
/** Safe git command execution (no shell) */
export async function gitExec(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * Resolve `owner/repo` for a specific remote URL via `gh repo view <url>`,
 * rather than `gh repo view` with no argument. The bare form lets `gh` pick
 * whichever remote it considers "the" repository for `cwd`, which is not
 * documented to be `origin` specifically — a repo with more than one remote
 * configured could have `gh` resolve one while a subsequent `git fetch
 * origin ...` reads from another, defeating an identity check meant to catch
 * exactly that mismatch. Passing the caller's own resolved `origin` URL pins
 * both to the same remote.
 */
export async function ghRepoView(cwd: string, remoteUrl: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh', ['repo', 'view', remoteUrl, '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd }
  );
  return stdout.trim();
}

export type PRIssueComment = {
  author: string;
  body: string;
  createdAt: string;
};

export type AutoStash = {
  hash: string;
};

const CRITICAL_COMMENT_KEYWORDS = ['🔴', 'critical', '버그', 'bug', '수정 필요', 'must fix', '필수', 'required'];

/**
 * Bare substring matching on 'bug'/'critical'/'required' also fires inside
 * "debug", "bugfix", "prerequisite" — words with no bearing on whether a
 * comment is actionable review feedback. Word-boundary matching for the
 * single-token ASCII keywords fixes that without touching the multi-word
 * phrase or the Korean/emoji tokens, where `\b` isn't meaningful.
 */
function matchesCriticalKeyword(bodyLower: string): boolean {
  return CRITICAL_COMMENT_KEYWORDS.some((keyword) => {
    const kw = keyword.toLowerCase();
    return /^[a-z]+$/.test(kw) ? new RegExp(`\\b${kw}\\b`).test(bodyLower) : bodyLower.includes(kw);
  });
}
const FEEDBACK_ADDRESSED_MARKERS = [
  'Review feedback addressed',
  'Auto-fix completed - CI passing',
];

function parseStashList(output: string): Array<{ hash: string; ref: string; subject: string }> {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', ref = '', subject = ''] = line.split('\x00');
      return { hash, ref, subject };
    })
    .filter((stash) => stash.hash && stash.ref);
}

export async function stashLocalChanges(cwd: string, message: string): Promise<AutoStash | null> {
  try {
    const before = new Set(
      parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
        .map((stash) => stash.hash)
    );
    await gitExec(cwd, 'stash', 'push', '-u', '-m', message);
    const created = parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
      .find((stash) => !before.has(stash.hash) && stash.subject.includes(message));
    return created ? { hash: created.hash } : null;
  } catch {
    return null;
  }
}

export async function restoreAutoStash(cwd: string, stash: AutoStash | null): Promise<void> {
  if (!stash) return;
  try {
    const stashRef = parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
      .find((entry) => entry.hash === stash.hash)?.ref;
    if (!stashRef) return;
    await gitExec(cwd, 'stash', 'apply', stashRef);
    await gitExec(cwd, 'stash', 'drop', stashRef);
  } catch (err) {
    console.error(`[PRProcessor] Failed to restore auto-stash ${stash.hash}:`, err);
  }
}

/** Known AI review-bot author name fragments. Codex comments were previously
 * invisible to critical-comment detection because this check only matched
 * "claude" — the `claude-review` action was the only bot in mind when it was
 * written, so a repo also running a Codex-based review action never had its
 * feedback picked up here at all. */
const REVIEW_BOT_AUTHOR_FRAGMENTS = ['claude', 'codex'];

export function isReviewBotComment(comment: PRIssueComment): boolean {
  const author = comment.author.toLowerCase();
  // Exact bare name (e.g. a PAT-based integration posting as "codex"), or a
  // GitHub App/bot account (GitHub always suffixes those "[bot]") whose name
  // contains the fragment. Plain substring matching without the [bot] anchor
  // would also treat a human account that merely contains "claude"/"codex" in
  // its username as an automated reviewer.
  return REVIEW_BOT_AUTHOR_FRAGMENTS.some((fragment) =>
    author === fragment || (author.endsWith('[bot]') && author.includes(fragment)));
}

export function getActiveCriticalComments(comments: PRIssueComment[]): PRIssueComment[] {
  const lastAddressedAt = comments.reduce<number | null>((latest, comment) => {
    if (!FEEDBACK_ADDRESSED_MARKERS.some((marker) => comment.body.includes(marker))) {
      return latest;
    }
    const createdAt = new Date(comment.createdAt).getTime();
    if (Number.isNaN(createdAt)) return latest;
    return latest === null || createdAt > latest ? createdAt : latest;
  }, null);

  return comments.filter((comment) => {
    const createdAt = new Date(comment.createdAt).getTime();
    if (lastAddressedAt !== null && (!Number.isNaN(createdAt) && createdAt <= lastAddressedAt)) {
      return false;
    }
    return isReviewBotComment(comment) && matchesCriticalKeyword(comment.body.toLowerCase());
  });
}

type PRStateEntry = {
  repo: string;
  prNumber: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  iterations: number;
  lastProcessed?: string;
  lastReviewFeedbackProcessed?: string;
  lastError?: string;
};

export type PRState = {
  prs: Record<string, PRStateEntry>;
  integrations: Record<string, {
    repo: string;
    mergedPRNumber: number;
    mergedBranch: string;
    baseBranch: string;
    mergeCommitOid: string;
    status: 'baseline' | 'pending' | 'completed';
    attempts: number;
    updatedAt: string;
    results?: IntegrationSiblingResult[];
    lastError?: string;
  }>;
  integrationBaselines: Record<string, string>;
  updatedAt: string;
};

const PRStateEntrySchema = z.object({
  repo: z.string().min(1), prNumber: z.number().int().positive(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  iterations: z.number().int().nonnegative(),
  lastProcessed: z.string().optional(), lastReviewFeedbackProcessed: z.string().optional(), lastError: z.string().optional(),
});
const IntegrationStateEntrySchema = z.object({
  repo: z.string().min(1), mergedPRNumber: z.number().int().positive(),
  mergedBranch: z.string().min(1), baseBranch: z.string().min(1), mergeCommitOid: z.string().min(1),
  status: z.enum(['baseline', 'pending', 'completed']), attempts: z.number().int().nonnegative(),
  updatedAt: z.string(), results: z.array(z.unknown()).optional(), lastError: z.string().optional(),
});
export const PRStateSchema = z.object({
  prs: z.record(z.string(), PRStateEntrySchema),
  integrations: z.record(z.string(), IntegrationStateEntrySchema).default({}),
  integrationBaselines: z.record(z.string(), z.string()).default({}),
  updatedAt: z.string(),
}) as z.ZodType<PRState>;

// Constants

export const PR_STATE_PATH = resolve(homedir(), '.openswarm', 'pr-state.json');
