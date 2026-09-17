// Publication fence for pipeline stages (AGT-4418)
//
// A worker is one stage of a pipeline that commits, publishes, reviews and
// updates the tracker after the stage returns. On 2026-09-17 every cgf-portal
// publication that reached DONE had been opened by the worker itself —
// `git push` + `gh pr create` from its bash tool, ready, with a `Closes AX-…`
// body, once even `openswarm pr review --fresh` — because the operator's own
// `~/.claude/CLAUDE.md` (a human session's commit/PR/review workflow) rides in
// the instruction capsule and nothing said no. Those PRs skipped the tester,
// every guard, the sensitive-data fence and the review rollback, and the
// reconciler then recorded them as delivered. This is the deterministic "no".

/** Commands that publish, hand work to a remote, or act on the tracker/loop. */
const PUBLICATION_COMMANDS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bgit\s+push\b/, what: 'git push' },
  { pattern: /\bgit\s+commit\b/, what: 'git commit' },
  { pattern: /\bgit\s+remote\s+(add|set-url|rename|remove|rm)\b/, what: 'git remote change' },
  { pattern: /\bgh\s+pr\s+(create|merge|ready|close|edit|review|comment|checkout)\b/, what: 'gh pr' },
  { pattern: /\bgh\s+api\b[^|;&]*\/pulls\b/, what: 'gh api …/pulls' },
  { pattern: /\bgh\s+issue\s+(create|close|edit|comment)\b/, what: 'gh issue' },
  { pattern: /\bopenswarm\s+(pr|review|work|exec|run)\b/, what: 'openswarm CLI' },
];

/**
 * The publication command `command` contains, or `null` when it is an ordinary
 * command. Matched on the raw text and on a quote-stripped form so `git "push"`
 * and `git\ push` cannot slip past; read-only forms (`git status`, `git diff`,
 * `gh pr view`, `gh pr list`) are not listed and stay allowed. Fail-closed on
 * purpose: a command that merely mentions `git push` inside a string is refused
 * too, and a worker has no need to say it.
 */
export function publicationCommandIn(command: string): string | null {
  const stripped = command.replace(/["'\\]/g, '');
  for (const { pattern, what } of PUBLICATION_COMMANDS) {
    if (pattern.test(command) || pattern.test(stripped)) return what;
  }
  return null;
}

/** The tool error a fenced stage sees; names who publishes so the model stops trying. */
export function publicationFenceMessage(what: string): string {
  return `PUBLICATION_FENCED: ${what} is not available in this stage. The harness commits, pushes, opens the pull request, `
    + 'runs the review and updates the tracker after you finish — instructions that describe those steps belong to a '
    + 'human session, not to this run. Leave your changes in the working tree and finish with your summary.';
}
