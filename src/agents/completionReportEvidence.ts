/**
 * Completion-report evidence gate (AGT-4900, defences 4 and 5 of AGT-4190).
 *
 * A worker that finishes with "all tests pass" has made a claim, not shown a
 * result. Two shortcuts were observed in practice:
 *
 * - "Tests pass" with nothing that ran behind it. Green-looking reports shipped
 *   while the project's test suite had never been executed.
 * - Citing a document written in the same change as the proof (cgf-portal #215:
 *   a readiness doc claimed no credentials were committed, in the commit that
 *   committed them). A document is part of the output, not evidence about it.
 *
 * So a report that claims a check passed must carry one `Ran:` line per check:
 *
 *     Ran: npm test -> exit 0, 412 passed, 0 failed
 *     Ran: npm run lint -> exit 0
 *
 * Test runners must state passed/failed counts; lint, typecheck and build
 * commands have no such counts, so an exit code is enough for them. Evidence
 * lines that point at a doc file changed in this same diff are dropped. A claim
 * left with no execution evidence is not a success.
 *
 * A report that makes no claim is not judged here: the missing-validation nudge
 * (workerValidationEvidence.ts) covers silence. This gate covers assertion.
 */
import type { WorkerResult } from './agentPair.js';
import { claimedButNotObserved, isDocOnlyFile } from './workerValidationEvidence.js';

/** One parsed `Ran:` line. */
export interface ReportedRun {
  command: string;
  exitCode: number;
  passed?: number;
  failed?: number;
  /** The line as written, for messages. */
  line: string;
}

/** The format every rejection message quotes, so the next attempt can comply. */
export const EVIDENCE_LINE_FORMAT =
  'Ran: <command> -> exit <code>, <N> passed, <M> failed (test runners) or Ran: <command> -> exit <code> (lint/typecheck/build)';

const RAN_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?Ran:(?:\*\*)?\s*(.+?)\s*$/i;
// `->`, `→` or `=>` separates the command from its outcome.
const RAN_SPLIT = /\s*(?:->|→|=>)\s*/;
const EXIT_CODE = /\bexit(?:\s*code)?\s*[:=]?\s*(-?\d+)\b/i;
const PASSED_COUNT = /(\d+)\s+pass(?:ed|ing)?\b/i;
const FAILED_COUNT = /(\d+)\s+fail(?:ed|ing|ures?)?\b/i;
const EVIDENCE_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Evidence|근거)\s*:(?:\*\*)?\s*(.+?)\s*$/i;

/** Commands whose output has pass/fail counts, so the report must state them. */
const TEST_RUNNER_COMMAND = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|swift\s+test|gradle\s+test|mvn\s+test|unittest)\b/i;

/**
 * A line asserting that a check passed. Deliberately narrow: it names a kind
 * of check and a positive outcome. Lines that also negate or hedge ("tests
 * were not run", "could not verify the build passes") are statements of a
 * limit, which the worker prompt asks for, and are not claims.
 */
const CLAIM_LINE = new RegExp([
  String.raw`\b(?:tests?|test\s+suite|specs?)\b[^.\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green)\b`,
  String.raw`\b(?:lint(?:ing|er)?|type-?check(?:ing|s)?|tsc|oxlint|eslint|ruff|mypy|pyright|clippy)\b[^.\n]{0,40}?\b(?:pass(?:es|ed)?|clean|green|no\s+(?:errors|warnings))\b`,
  String.raw`\b(?:build|ci|checks?)\b[^.\n]{0,40}?\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|green)\b`,
  String.raw`테스트[^.\n]{0,20}?통과`,
  String.raw`(?:린트|타입\s*체크|빌드)[^.\n]{0,20}?(?:통과|성공)`,
].join('|'), 'i');
const HEDGE_LINE =
  /\b(?:not|n['’]t|never|unable|cannot|could\s+not|without|skipped|unverified|pending|todo)\b|못\s*했|않았|미실행|확인\s*못/i;

/** Parse every `Ran:` line in a report. Lines without an exit code are returned as malformed. */
export function parseReportedRuns(text: string): { runs: ReportedRun[]; malformed: string[] } {
  const runs: ReportedRun[] = [];
  const malformed: string[] = [];
  for (const raw of text.split('\n')) {
    const match = raw.match(RAN_LINE);
    if (!match) continue;
    const body = match[1].replace(/`/g, '');
    const [command, ...rest] = body.split(RAN_SPLIT);
    const outcome = rest.join(' ');
    const exit = outcome.match(EXIT_CODE);
    if (!command.trim() || !exit) {
      malformed.push(raw.trim());
      continue;
    }
    const passed = outcome.match(PASSED_COUNT);
    const failed = outcome.match(FAILED_COUNT);
    runs.push({
      command: command.trim(),
      exitCode: Number(exit[1]),
      passed: passed ? Number(passed[1]) : undefined,
      failed: failed ? Number(failed[1]) : undefined,
      line: raw.trim(),
    });
  }
  return { runs, malformed };
}

/** Lines of the report that assert a check passed. */
export function verificationClaims(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    // JSON-looking lines are raw stream events (a parse fallback), not the report.
    .filter((line) => line && !/^[{[]/.test(line) && !RAN_LINE.test(line))
    .filter((line) => CLAIM_LINE.test(line) && !HEDGE_LINE.test(line));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Doc files changed in this diff that an evidence line cites. */
export function selfAuthoredDocCitations(line: string, filesChanged: readonly string[]): string[] {
  const text = line.replace(/\\/g, '/');
  return filesChanged
    .map(normalizePath)
    .filter((file) => file && isDocOnlyFile(file) && text.includes(file));
}

/**
 * Why this completion report is not acceptable as a success, or [] when it is.
 * Only judged when the report claims a check passed.
 */
export function completionReportEvidenceIssues(
  result: Pick<WorkerResult, 'output' | 'summary' | 'filesChanged' | 'executedCommands'>,
): string[] {
  const text = result.output || result.summary || '';
  const claims = verificationClaims(text);
  if (claims.length === 0) return [];

  const filesChanged = result.filesChanged ?? [];
  const issues: string[] = [];
  const { runs, malformed } = parseReportedRuns(text);

  // Evidence lines that cite a doc this same diff wrote are not evidence.
  const citedDocs = new Set<string>();
  for (const raw of text.split('\n')) {
    if (!RAN_LINE.test(raw) && !EVIDENCE_LINE.test(raw)) continue;
    for (const doc of selfAuthoredDocCitations(raw, filesChanged)) citedDocs.add(doc);
  }
  const usableRuns = runs.filter((run) => selfAuthoredDocCitations(run.line, filesChanged).length === 0);

  if (malformed.length > 0) {
    issues.push(`Evidence lines without an exit code are not evidence: ${malformed.slice(0, 3).join(' | ')}`);
  }

  for (const run of usableRuns) {
    if (TEST_RUNNER_COMMAND.test(run.command) && (run.passed === undefined || run.failed === undefined)) {
      issues.push(`Test run reported without passed/failed counts: ${run.line}`);
    }
    if (run.exitCode !== 0 || (run.failed ?? 0) > 0) {
      issues.push(`Report claims success but its own evidence shows a failing run: ${run.line}`);
    }
  }

  // Where the adapter observed execution, a reported run must have happened.
  const observed = result.executedCommands;
  if (observed) {
    const neverRan = claimedButNotObserved(usableRuns.map((run) => run.command), observed);
    if (neverRan.length > 0) {
      issues.push(`Reported runs that OpenSwarm never observed executing: ${neverRan.slice(0, 3).join('; ')}`);
    }
    for (const run of usableRuns) {
      const exitMatch = observed
        .map((line) => line.match(/^(.*?)(?: \[exit (-?\d+)\])?$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .filter((m) => claimedButNotObserved([run.command], [m[1]]).length === 0);
      if (exitMatch.length > 0 && !exitMatch.some((m) => Number(m[2] ?? 0) === run.exitCode)) {
        issues.push(`Reported exit code does not match the observed run: ${run.line}`);
      }
    }
  }

  if (usableRuns.length === 0) {
    const docs = [...citedDocs];
    issues.unshift(
      docs.length > 0
        ? `Report cites documents written in this same change as evidence (${docs.slice(0, 3).join(', ')}); a document you wrote is output, not evidence. Claim: "${claims[0].slice(0, 160)}"`
        : `Report claims a check passed but shows no execution evidence. Claim: "${claims[0].slice(0, 160)}"`,
    );
  }

  if (issues.length === 0) return [];
  return [...issues, `Report each check you ran as one line: ${EVIDENCE_LINE_FORMAT}. If you did not run a check, say so instead of claiming it passed.`];
}
