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
 * Test runners must state a passed count (Korean `412개 통과` / `통과 412` is
 * accepted too); a missing failed count with exit 0 means 0 failed, because
 * runners such as vitest omit "0 failed". `go test` prints no counts, so `ok`,
 * `PASS` or exit 0 alone is enough for it, as for lint, typecheck and build.
 *
 * A failing run only contradicts a claim of the same kind (a failing lint run
 * does not contradict "tests pass"), and a failing run the report marks as
 * pre-existing ("already failing on main", "기존 실패") on its own line or the
 * next is an honest limit, not a contradiction. A claim still needs at least
 * one passing run behind it.
 *
 * Evidence that points at a doc file changed in this same diff is not
 * evidence: an `Evidence:` line citing one, or a `Ran:` line whose command only
 * reads one (`cat docs/x.md`). A command that merely takes the file as input
 * (`markdownlint docs/x.md`, `pip install -r requirements.txt`) is a real run.
 *
 * Where the adapter observed execution (`executedCommands`), each reported run
 * must have been observed, untargeted, and the exit code of the LAST matching
 * observed run must agree. Observed entries carry `[exit N]` for a non-zero
 * exit and `[exit ?]` when the adapter saw the command run but not its exit
 * status; for those only the observation itself is checked. Pass/fail COUNTS
 * are never cross-checked: no adapter captures runner output reliably enough.
 *
 * A report that makes no claim is not judged here: the missing-validation nudge
 * (workerValidationEvidence.ts) covers silence. This gate covers assertion.
 */
import type { WorkerResult } from './agentPair.js';

/** One parsed `Ran:` line. */
export interface ReportedRun {
  command: string;
  exitCode: number;
  passed?: number;
  failed?: number;
  /** The report marks this run's failure as known and not caused by the change. */
  preExisting?: boolean;
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
// Hangul is not a word character, so the Korean forms are not anchored with \b.
const PASSED_COUNT = [/(\d+)\s+pass(?:ed|ing)?\b/i, /(\d+)\s*개?\s*통과/, /통과\s*:?\s*(\d+)/];
const FAILED_COUNT = [/(\d+)\s+fail(?:ed|ing|ures?)?\b/i, /(\d+)\s*개?\s*실패/, /실패\s*:?\s*(\d+)/];
const EVIDENCE_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Evidence|근거)\s*:(?:\*\*)?\s*(.+?)\s*$/i;
const GO_TEST = /\bgo\s+test\b/i;
/** `go test` reports `ok` / `PASS` instead of an exit code or counts. */
const GO_TEST_OK = /^(?:ok|PASS)\b/;
const PRE_EXISTING = /\bpre-?existing\b|\balready\s+fail(?:ing|ed|s)?\b|\bfails?\s+on\s+(?:main|master)\b|\bknown\s+(?:failure|failing|flak)|기존\s*(?:실패|에도\s*실패|부터\s*실패)|원래\s*(?:부터\s*)?실패/i;

type CheckKind = 'test' | 'lint' | 'build';

/** Commands whose output has pass/fail counts, so the report must state them. */
const TEST_RUNNER_COMMAND = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|swift\s+test|gradle\s+test|mvn\s+test|unittest)\b/i;
const LINT_COMMAND = /\b(?:lint\w*|eslint|oxlint|ruff|mypy|pyright|tsc|type-?check\w*|clippy|flake8|pylint|golangci-lint|go\s+vet|biome|prettier\s+--check|black\s+--check|stylelint|markdownlint)\b/i;
const BUILD_COMMAND = /\b(?:build|compile|make|cmake|gmake|cargo\s+check|webpack|vite\s+build|rollup|esbuild|gradle\s+assemble|mvn\s+(?:package|compile|install))\b/i;

function commandKind(command: string): CheckKind | undefined {
  if (TEST_RUNNER_COMMAND.test(command) || /\b(?:tests?|tox|nox|ctest)\b/i.test(command)) return 'test';
  if (LINT_COMMAND.test(command)) return 'lint';
  if (BUILD_COMMAND.test(command)) return 'build';
  return undefined;
}

/**
 * A line asserting that a check passed. Deliberately narrow: it names a kind
 * of check and a positive outcome. A build claim must assert the outcome
 * ("the build passes", "build is green"); "made the build succeed" describes
 * work, not a verification.
 */
const MAKE_PREFIX = String.raw`(?<!\b(?:make|made|makes|making|get|got|gets|getting|let)\s+(?:(?:the|all|our|every)\s+)?)`;
const CLAIM_PATTERNS: Array<{ kind: CheckKind | 'any'; pattern: RegExp }> = [
  { kind: 'test', pattern: /\b(?:tests?|test\s+suite|specs?)\b[^.\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green)\b/i },
  { kind: 'lint', pattern: /\b(?:lint(?:ing|er)?|type-?check(?:ing|s)?|tsc|oxlint|eslint|ruff|mypy|pyright|clippy)\b[^.\n]{0,40}?\b(?:pass(?:es|ed)?|clean|green|no\s+(?:errors|warnings))\b/i },
  { kind: 'build', pattern: new RegExp(String.raw`${MAKE_PREFIX}\bbuild\b[^.\n]{0,40}?(?:\b(?:pass(?:es|ed|ing)|succeed(?:s|ed)|(?:is|was|are|were|stays?)\s+(?:green|clean|successful|passing))\b|\bgreen\b)`, 'i') },
  { kind: 'any', pattern: new RegExp(String.raw`${MAKE_PREFIX}\b(?:ci|checks?)\b[^.\n]{0,40}?(?:\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)|(?:is|are|was|were)\s+(?:green|clean|successful|passing))\b|\bgreen\b)`, 'i') },
  { kind: 'test', pattern: /테스트[^.\n]{0,20}?통과(?!\s*(?:하도록|되도록|시키))/ },
  { kind: 'lint', pattern: /(?:린트|타입\s*체크)[^.\n]{0,20}?(?:통과|성공)(?!\s*(?:하도록|되도록|시키))/ },
  { kind: 'build', pattern: /빌드[^.\n]{0,20}?(?:통과|성공)(?!\s*(?:하도록|되도록|시키))/ },
];

/**
 * Lines that state a limit ("tests were not run", "could not verify the build
 * passes") are not claims. The negation must be attached to the verification
 * verb: "All tests pass (not flaky)" and "tests pass without network" are
 * still claims.
 */
const HEDGE_PATTERNS: RegExp[] = [
  /\b(?:tests?|specs?|suite|lint\w*|build|checks?|ci|type-?check\w*|it|they)\b[^.\n]{0,30}?(?:\bnot|\bnever|n['’]t)\s+(?:been\s+|yet\s+|be\s+)?(?:run|ran|executed|verified|checked|confirmed)\b/i,
  /\b(?:did\s+not|didn['’]t|could\s+not|couldn['’]t|cannot|can['’]t|unable\s+to|was\s+unable\s+to|have\s+not|haven['’]t|has\s+not|hasn['’]t|was\s+not\s+able\s+to|not\s+able\s+to|never)\s+(?:yet\s+)?(?:run|ran|execute[ds]?|verif(?:y|ied)|confirm(?:ed)?|check(?:ed)?)\b/i,
  /\b(?:tests?|lint\w*|build|checks?)\s+(?:were\s+|was\s+)?(?:skipped|unverified|untested)\b/i,
  /\bskipped\s+(?:the\s+)?(?:tests?|lint\w*|build|checks?)\b/i,
  /(?:실행|확인|검증|돌리|돌려\s*보)[^.\n]{0,8}?(?:못|않|안\s*했|안\s*함)|미실행|미검증|미확인/,
];

function claimKinds(line: string): Array<CheckKind | 'any'> {
  if (HEDGE_PATTERNS.some((pattern) => pattern.test(line))) return [];
  return [...new Set(CLAIM_PATTERNS.filter(({ pattern }) => pattern.test(line)).map(({ kind }) => kind))];
}

/**
 * The report text lines. A JSON one-liner is a stream event (a parse fallback)
 * unless it carries the report itself in a top-level `summary` or `text`.
 */
function reportLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
    .flatMap((line) => (/^[{[]/.test(line) ? jsonReportLines(line) : [line]));
}

function jsonReportLines(line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return []; // Not JSON: not report prose either.
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (typeof record.type === 'string') return []; // a stream event, not the report
  return ['summary', 'text']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split('\n').map((l) => l.trim()).filter(Boolean));
}

/** Parse every `Ran:` line in a report. Lines without an exit code are returned as malformed. */
export function parseReportedRuns(text: string): { runs: ReportedRun[]; malformed: string[] } {
  const runs: ReportedRun[] = [];
  const malformed: string[] = [];
  const lines = reportLines(text);
  lines.forEach((raw, index) => {
    const match = raw.match(RAN_LINE);
    if (!match) return;
    const body = match[1].replace(/`/g, '');
    const [command, ...rest] = body.split(RAN_SPLIT);
    const outcome = rest.join(' ');
    const exit = outcome.match(EXIT_CODE);
    const goOk = !exit && GO_TEST.test(command) && GO_TEST_OK.test(outcome.trim());
    if (!command.trim() || (!exit && !goOk)) {
      malformed.push(raw.trim());
      return;
    }
    const exitCode = exit ? Number(exit[1]) : 0;
    const count = (patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const found = outcome.replace(EXIT_CODE, ' ').match(pattern);
        if (found) return Number(found[1]);
      }
      return undefined;
    };
    const passed = count(PASSED_COUNT);
    let failed = count(FAILED_COUNT);
    // vitest prints no "0 failed"; a clean exit with a passed count means none failed.
    if (failed === undefined && exitCode === 0 && passed !== undefined) failed = 0;
    const next = lines[index + 1];
    const preExisting = PRE_EXISTING.test(raw) || (next !== undefined && !RAN_LINE.test(next) && PRE_EXISTING.test(next));
    runs.push({
      command: command.trim(),
      exitCode,
      passed,
      failed,
      ...(preExisting ? { preExisting } : {}),
      line: raw.trim(),
    });
  });
  return { runs, malformed };
}

/** Lines of the report that assert a check passed. */
export function verificationClaims(text: string): string[] {
  return reportLines(text)
    .filter((line) => !RAN_LINE.test(line))
    .filter((line) => claimKinds(line).length > 0);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

const PROSE_EXTENSION = /\.(?:md|mdx|rst|adoc)$/i;
const PROSE_BASENAME = /(?:^|\/)(?:README|CHANGELOG|NOTES)(?:[._-][^/]*)?$/i;
const NON_PROSE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|c|cc|cpp|h|hpp|swift|kt|sh|json|ya?ml|toml)$/i;

/**
 * A prose document someone could write to "prove" their own change: *.md,
 * *.mdx, *.rst, *.adoc, README*, CHANGELOG* and NOTES* (not `readme.ts`), and
 * anything under docs/. A `.txt` is prose only by those names or location, so
 * `requirements.txt`, `constraints.txt` and `CMakeLists.txt` are not docs.
 */
export function isProseDocFile(file: string): boolean {
  const path = normalizePath(file);
  if (/(?:^|\/)docs\//i.test(path)) return true;
  if (PROSE_EXTENSION.test(path)) return true;
  return PROSE_BASENAME.test(path) && !NON_PROSE_EXTENSION.test(path);
}

/** Doc files changed in this diff that a line cites. */
export function selfAuthoredDocCitations(line: string, filesChanged: readonly string[]): string[] {
  const text = line.replace(/\\/g, '/');
  return filesChanged
    .map(normalizePath)
    .filter((file) => file && isProseDocFile(file) && text.includes(file));
}

const READ_ONLY_COMMAND = /^\s*(?:sudo\s+)?(?:cat|less|head|tail|more|bat|batcat|type|get-content|gc)\b/i;

/** Same-diff docs a `Ran:` command only reads (`cat docs/x.md`), not ones it takes as input. */
function docsReadByCommand(command: string, filesChanged: readonly string[]): string[] {
  const docs = new Set<string>();
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (!READ_ONLY_COMMAND.test(segment)) continue;
    for (const doc of selfAuthoredDocCitations(segment, filesChanged)) docs.add(doc);
  }
  return [...docs];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeCommand = (command: string) => command.replace(/\s+/g, ' ').trim();
const OBSERVED_EXIT_SUFFIX = /^(.*?)(?: \[exit (-?\d+|\?)\])?$/s;
const REDIRECT_TOKEN = /^(?:\d*>>?|&>|<)/;
const VALUE_FLAG = /^(?:-p|-c|--config|--project|--prefix|--manifest-path|--outputFile|--rootdir|--tsconfig)$/;
const PATH_LIKE_TOKEN = /\/|::|\.[A-Za-z0-9]{1,6}$/;
/** Flags that select a subset of tests by name (vitest/jest -t, pytest -k, mocha --grep, …). */
const FILTER_FLAG = /^(?:-t|-k|-g|--testNamePattern|--grep|--filter|--testPathPattern)(?:=|$)/;
const SHELL_SEPARATOR = /^(?:\||\|\||&&|;|\|&)$/;

/**
 * True when the args following a command occurrence narrow it to a subset (a
 * targeted run): a path argument, a name filter, or any positional argument
 * after `--`. Flags alone after `--` (`npm test -- --run`) still run
 * everything (#921 review follow-up).
 */
function isTargetedRemainder(remainder: string): boolean {
  const tokens = remainder.split(/\s+/).filter(Boolean);
  let afterDashDash = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SHELL_SEPARATOR.test(token)) break; // what follows is another command (`| tail -20`)
    if (REDIRECT_TOKEN.test(token)) {
      // `> file` takes the next token as its target.
      if (/^(?:\d*>>?|&>|<)$/.test(token)) i++;
      continue;
    }
    if (token === '--') {
      afterDashDash = true;
      continue;
    }
    if (FILTER_FLAG.test(token)) return true;
    if (VALUE_FLAG.test(token)) {
      i++; // `--config vitest.config.ts`: the value is configuration, not a target.
      continue;
    }
    if (token.startsWith('-')) continue;
    if (afterDashDash || PATH_LIKE_TOKEN.test(token)) return true;
  }
  return false;
}

interface ObservedMatch {
  /** Exit code of the observed run; undefined when the adapter did not see it. */
  exitCode?: number;
  targeted: boolean;
}

/** How a reported command appears in one observed command, if it does. */
function matchObserved(reported: string, observedLine: string): ObservedMatch | undefined {
  const [, body, exit] = observedLine.match(OBSERVED_EXIT_SUFFIX) ?? [];
  const ran = normalizeCommand(body ?? observedLine);
  const wanted = normalizeCommand(reported);
  if (!wanted) return undefined;
  const lineExit = exit === undefined ? 0 : exit === '?' ? undefined : Number(exit);
  // Whole words: `tsc` is not inside `tsconfig.json`, and `npm run build` is
  // not `npm run build:docs`. Containment, so `cd pkg && npm test 2>&1 | tail`
  // is a run of `npm test`.
  const pattern = new RegExp(`(?:^|[\\s;&|(])${escapeRegExp(wanted)}(?=$|[\\s;&|)])`, 'g');
  let match: ObservedMatch | undefined;
  for (const occurrence of ran.matchAll(pattern)) {
    const after = ran.slice((occurrence.index ?? 0) + occurrence[0].length);
    const remainder = after.split(/&&|\|\||[;|)]/)[0] ?? '';
    const candidate = { exitCode: commandExit(after.slice(remainder.length), lineExit), targeted: isTargetedRemainder(remainder) };
    // The last untargeted occurrence on the line is the run that counts.
    if (!match || match.targeted || !candidate.targeted) match = candidate;
  }
  return match;
}

/**
 * The exit code of a command followed by `tail` on the same line. The line's
 * exit is the command's only when nothing follows it, or when only `&&` links
 * follow and the line exited 0 (each link ran and succeeded). After a pipe,
 * `;`, `||` or a failing chain, the command's own exit is unknown.
 */
function commandExit(tail: string, lineExit: number | undefined): number | undefined {
  if (!tail.trim()) return lineExit;
  const links = tail.match(/&&|\|\||[;|)]/g) ?? [];
  return lineExit === 0 && links.every((link) => link === '&&') ? 0 : undefined;
}

/** Reported runs checked against what the adapter saw execute. */
function observedRunIssues(runs: readonly ReportedRun[], observed: readonly string[]): string[] {
  const issues: string[] = [];
  const neverRan: string[] = [];
  for (const run of runs) {
    const matches = observed
      .map((line) => matchObserved(run.command, line))
      .filter((m): m is ObservedMatch => m !== undefined);
    const full = matches.filter((m) => !m.targeted);
    if (matches.length === 0) {
      neverRan.push(run.command);
      continue;
    }
    if (full.length === 0) {
      issues.push(`Reported run was only observed as a targeted run (extra paths or args after \`--\`), which does not show the full command passed: ${run.line}`);
      continue;
    }
    // The last matching run is the one the report's outcome must describe.
    const last = full[full.length - 1];
    if (last.exitCode !== undefined && last.exitCode !== run.exitCode) {
      issues.push(`Reported exit code does not match the observed run: ${run.line}`);
    }
  }
  if (neverRan.length > 0) {
    issues.unshift(`Reported runs that OpenSwarm never observed executing: ${neverRan.slice(0, 3).join('; ')}`);
  }
  return issues;
}

/**
 * Why this completion report is not acceptable as a success, or [] when it is.
 * Only judged when the report claims a check passed.
 */
export function completionReportEvidenceIssues(
  result: Pick<WorkerResult, 'output' | 'summary' | 'filesChanged' | 'executedCommands'>,
): string[] {
  const text = result.output || result.summary || '';
  const lines = reportLines(text);
  const claimLines = lines.filter((line) => !RAN_LINE.test(line) && claimKinds(line).length > 0);
  if (claimLines.length === 0) return [];
  const claimedKinds = new Set(claimLines.flatMap(claimKinds));
  // A failing run of a kind we cannot tell is held against any claim.
  const claimCovers = (kind: CheckKind | undefined) =>
    kind === undefined || claimedKinds.has('any') || claimedKinds.has(kind);

  const filesChanged = result.filesChanged ?? [];
  const issues: string[] = [];
  const { runs, malformed } = parseReportedRuns(text);

  // Evidence lines and doc-reading runs that cite a doc this same diff wrote are not evidence.
  const citedDocs = new Set<string>();
  for (const line of lines) {
    if (EVIDENCE_LINE.test(line)) for (const doc of selfAuthoredDocCitations(line, filesChanged)) citedDocs.add(doc);
  }
  const usableRuns: ReportedRun[] = [];
  for (const run of runs) {
    const read = docsReadByCommand(run.command, filesChanged);
    if (read.length === 0) usableRuns.push(run);
    for (const doc of read) citedDocs.add(doc);
  }

  if (malformed.length > 0) {
    issues.push(`Evidence lines without an exit code are not evidence: ${malformed.slice(0, 3).join(' | ')}`);
  }

  let contradicted = false;
  for (const run of usableRuns) {
    if (TEST_RUNNER_COMMAND.test(run.command) && !GO_TEST.test(run.command)
      && (run.passed === undefined || run.failed === undefined)) {
      issues.push(`Test run reported without passed/failed counts: ${run.line}`);
    }
    const failing = run.exitCode !== 0 || (run.failed ?? 0) > 0;
    // A known failure stated as such is a limit, and a failing lint run does
    // not contradict "tests pass"; only a same-kind failure does.
    if (failing && !run.preExisting && claimCovers(commandKind(run.command))) {
      contradicted = true;
      issues.push(`Report claims success but its own evidence shows a failing run: ${run.line}`);
    }
  }

  // Where the adapter observed execution, a reported run must have happened.
  if (result.executedCommands) issues.push(...observedRunIssues(usableRuns, result.executedCommands));

  const docs = [...citedDocs];
  // A known failure reported as such still shows the check ran.
  const passingRuns = usableRuns.filter((run) => run.preExisting || (run.exitCode === 0 && (run.failed ?? 0) === 0));
  if (passingRuns.length === 0 && !contradicted) {
    issues.unshift(
      docs.length > 0
        ? `Report cites documents written in this same change as evidence (${docs.slice(0, 3).join(', ')}); a document you wrote is output, not evidence. Claim: "${claimLines[0].slice(0, 160)}"`
        : `Report claims a check passed but shows no execution evidence. Claim: "${claimLines[0].slice(0, 160)}"`,
    );
  } else if (docs.length > 0) {
    issues.push(`Report cites documents written in this same change as evidence (${docs.slice(0, 3).join(', ')}); a document you wrote is output, not evidence. Remove the citation or replace it with a run.`);
  }

  if (issues.length === 0) return [];
  return [...issues, `Report each check you ran as one line: ${EVIDENCE_LINE_FORMAT}. If you did not run a check, say so instead of claiming it passed.`];
}
