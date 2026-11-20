import type { WorkerResult } from './agentPair.js';

const VALIDATION_RELEVANT_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cc|cpp|h|hpp|swift|kt|kts|scala|cs|php|sh|bash|zsh|sql|toml|ya?ml|json)$/i;
const VALIDATION_RELEVANT_BASENAME_RE = /(^|\/)(Dockerfile(?:\.[^/]+)?|Containerfile(?:\.[^/]+)?|Makefile|GNUmakefile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|package(?:-lock)?\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|requirements(?:-[^/]+)?\.txt|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|flake\.nix|shell\.nix|docker-compose\.ya?ml|compose\.ya?ml)$/i;
// Only treat README/CHANGELOG/LICENSE/NOTICE as doc-only when they carry a doc
// extension (or none). A real source module named e.g. `readme.ts` must NOT be
// misclassified as docs — that would let it skip the validation gate while the
// tester's isTesterCodeFile() still treats it as code (inconsistent).
const DOC_ONLY_FILE_RE = /(^|\/)(README|CHANGELOG|LICENSE|NOTICE)(\.(md|mdx|txt|rst|adoc))?$|(^|\/)docs?\/|\.((md|mdx|txt|rst|adoc))$/i;
// Pure data/asset trees (locale strings, fixtures, snapshots, mocks) have
// nothing to build or test on their own; exempt them so a data-only edit does
// not get bounced for "no validation command".
const DATA_ONLY_DIR_RE = /(^|\/)(locales?|i18n|fixtures?|__fixtures__|__snapshots__|snapshots?|__mocks__|mocks?|testdata|test-data)\//i;
// Executable / source formats under data dirs still require validation evidence.
// Broader than TESTER_CODE_FILE_RE: includes sh/swift/sql/etc. that VALIDATION_RELEVANT
// already tracks, but excludes pure data formats (json/yaml/toml).
const EXECUTABLE_SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cc|cpp|h|hpp|swift|kt|kts|scala|cs|php|sh|bash|zsh|sql)$/i;
const VALIDATION_COMMAND_RE = /\b(npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|pnpm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|yarn\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|bun\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|vitest|jest|mocha|pytest|ruff|mypy|pyright|tsc|eslint|oxlint|cargo\s+(?:check|test|clippy|build)|go\s+(?:test|vet|build)|swift\s+test|gradle\s+(?:test|build|check)|mvn\s+(?:test|verify)|make\b|cmake\b|py_compile|compileall|clippy|fmt\s+--check)\b/i;
// Anchored at each segment start: a leading inspection verb means that segment
// ran no validation (e.g. `rg "npm test"` searches for the string, it does not
// run it), so the segment is skipped rather than the whole command rejected.
const INSPECTION_ONLY_COMMAND_RE = /^\s*(?:rg|grep|sed|cat|ls|find|pwd|git\s+(?:status|diff|show|log|grep)|jq|head|tail|wc|tree|du|file|which|echo|printf)\b/i;
const SCRIPT_SMOKE_COMMAND_RE = /^\s*(?:python3?|node|tsx|ts-node|uv\s+run|npx|bunx|bash|sh)\b.*\b(?:scripts?\/|tests?\/|\.py|\.js|\.ts|\.sh|--help|--dry-run|smoke|verify|validate|check|test|build|compile)\b/i;
// A segment that names a validation tool but does not run it: a shell comment,
// a no-op builtin (`:`, `true`, `false`), `command -v`/`type`/`man`/`help`
// lookups, or help/version/list/dry-run flags. These print text, they do
// not build or test anything, so they are not validation evidence.
const NON_EXECUTING_PREFIX_RE = /^\s*(?:#|:(?:\s|$)|true\b|false\b|command\s+-[vV]\b|type\b|man\b|help\b|whatis\b|whereis\b)/i;
// Only flags that mean "do not run" for every tool here; `-v`/`-n` stay out
// because pytest uses them for verbose output and parallel workers.
const NON_EXECUTING_FLAG_RE = /(?:^|\s)(?:--help|-h|--version|--listTests|--collect-only|--co|--showConfig|--print-config)(?=\s|=|$)/;
const MAKE_DRY_RUN_RE = /^\s*(?:make|gmake)\b.*\s(?:-n|--dry-run|--just-print|--recon)(?=\s|$)/;
const TESTER_CODE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cpp|h|hpp)$/;

export function isValidationRelevantFile(file: string): boolean {
  if (/(^|\/)docs?\//i.test(file)) return false;
  if (VALIDATION_RELEVANT_BASENAME_RE.test(file)) return true;
  // Data/asset trees (locale, fixtures, snapshots, mocks) are exempt ONLY for
  // non-executable assets. Source/executable modules under such a dir (including
  // sh/swift/sql and locale i18n modules) still need a validation check.
  if (DATA_ONLY_DIR_RE.test(file) && !EXECUTABLE_SOURCE_FILE_RE.test(file)) return false;
  return VALIDATION_RELEVANT_FILE_RE.test(file) && !DOC_ONLY_FILE_RE.test(file);
}

function validationRelevantFiles(files: string[]): string[] {
  return files.filter(file => {
    return isValidationRelevantFile(file);
  });
}

/** `if`/`while`/... make the command after them conditional on something unseen. */
const CONTROL_KEYWORD_RE = /^(?:if|then|elif|else|while|until|do|for|case|select|!)(?=\s|$)/;
/** Segments that always succeed (`true`, `:`) or always fail (`false`). */
const ALWAYS_TRUE_RE = /^(?:true|:)$/;
const ALWAYS_FALSE_RE = /^false$/;

/**
 * The shell segments of `command` that can actually run, in order. A comment
 * (`cd . # npm test`) is cut off; a segment that short-circuit makes dead
 * (`false && npm test`, `true || npm test`) is dropped; a segment under a
 * control keyword (`if false; then npm test; fi`) is dropped, since whether it
 * ran depends on a condition the evidence does not show. (#897 review)
 */
function executedSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let operator = ';';
  let previous = '';
  const push = (next: string) => {
    const seg = current.trim();
    current = '';
    if (seg) {
      const dead = (operator === '&&' && ALWAYS_FALSE_RE.test(previous))
        || (operator === '||' && ALWAYS_TRUE_RE.test(previous));
      if (!dead && !CONTROL_KEYWORD_RE.test(seg)) segments.push(seg);
      previous = dead ? (operator === '&&' ? 'false' : 'true') : seg;
    }
    operator = next;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') { current += char + (command[i + 1] ?? ''); i++; continue; }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      const newline = command.indexOf('\n', i);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(two); i++; continue; }
    if (char === ';' || char === '|' || char === '\n') { push(char === '|' ? '|' : ';'); continue; }
    current += char;
  }
  push(';');
  return segments;
}

function commandLooksLikeValidation(command: string): boolean {
  // Workers routinely chain inspection then validation in one string
  // (e.g. "git diff && npm test"). Evaluate each shell segment independently so
  // a leading inspection verb does not mask a real validation command in a later
  // segment, while an inspection-only segment (which may merely *mention* a test
  // command as a search string) still counts as no validation.
  const candidates = executedSegments(command);
  return candidates.some(seg => {
    if (INSPECTION_ONLY_COMMAND_RE.test(seg) || NON_EXECUTING_PREFIX_RE.test(seg)) return false;
    if (VALIDATION_COMMAND_RE.test(seg)) return !NON_EXECUTING_FLAG_RE.test(seg) && !MAKE_DRY_RUN_RE.test(seg);
    return SCRIPT_SMOKE_COMMAND_RE.test(seg);
  });
}

const normalizeCommand = (command: string) => command.replace(/\s+/g, ' ').trim();

/**
 * Claimed commands that no observed command contains. Containment, not
 * equality: a worker that claims `npm test` and ran
 * `cd pkg && npm test 2>&1 | tail` did run it. (AGT-4534)
 */
export function claimedButNotObserved(claimed: readonly string[], observed: readonly string[]): string[] {
  const seen = observed.map(normalizeCommand);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return claimed.filter((command) => {
    const wanted = normalizeCommand(command);
    if (!wanted) return false;
    // Whole words: `tsc` is not inside `tsconfig.json`, and `npm run build`
    // is not `npm run build:docs`.
    const pattern = new RegExp(`(?:^|[\\s;&|(])${escape(wanted)}(?=$|[\\s;&|)])`);
    return !seen.some((ran) => pattern.test(ran));
  });
}

export function missingWorkerValidationIssues(result: WorkerResult): string[] {
  const changed = validationRelevantFiles(result.filesChanged ?? []);
  if (changed.length === 0) return [];
  // What the adapter saw run is the evidence when it can see it; the model's
  // own list is a claim. Only adapters that cannot observe execution (CLI
  // adapters) fall back to the claim. (AGT-4534)
  const observed = result.executedCommands;
  const commands = observed ?? result.commands ?? [];
  if (commands.some(commandLooksLikeValidation)) return [];

  const sample = changed.slice(0, 6).join(', ');
  const suffix = changed.length > 6 ? `, +${changed.length - 6} more` : '';
  const claimedOnly = observed
    ? claimedButNotObserved((result.commands ?? []).filter(commandLooksLikeValidation), observed)
    : [];
  if (claimedOnly.length > 0) {
    return [
      `Worker reported validation commands that were never executed: ${claimedOnly.slice(0, 3).join('; ')}`,
      `Run at least one relevant smoke/build/test/static check before review, or run the closest available check and report its failure. Files needing validation: ${sample}${suffix}`,
    ];
  }
  const commandIssue = commands.length === 0
    ? 'Worker changed code/config files but reported zero validation commands.'
    : `Worker changed code/config files but only reported non-validation commands: ${commands.slice(0, 3).join('; ')}`;
  return [
    commandIssue,
    `Run at least one relevant smoke/build/test/static check before review, or run the closest available check and report its failure. Files needing validation: ${sample}${suffix}`,
  ];
}

export function testerWouldRunForWorkerResult(
  result: WorkerResult,
  hasTester: boolean,
  skipIfNoCode: boolean,
  verifyEnabled = false,
): boolean {
  if (!hasTester) return false;
  if (!skipIfNoCode) return true;
  return (result.filesChanged ?? []).some(file => verifyEnabled
    ? isValidationRelevantFile(file)
    : TESTER_CODE_FILE_RE.test(file));
}

export function isTesterCodeFile(file: string): boolean {
  return TESTER_CODE_FILE_RE.test(file);
}

/**
 * Report lines for the commands behind a worker result, for agents that
 * cannot run anything themselves (reviewer, tester): what OpenSwarm observed
 * running, what the worker only claimed, or — for adapters that cannot
 * observe execution — the self-report, labelled as such. (AGT-4534)
 */
export function formatCommandEvidence(result: Pick<WorkerResult, 'commands' | 'executedCommands'>): string {
  // The newest commands are shown: the final check is the one that matters.
  const list = (cmds: readonly string[]) => (cmds.length <= 10
    ? (cmds.join(', ') || '(none)')
    : `(${cmds.length - 10} earlier omitted) ${cmds.slice(-10).join(', ')}`);
  const observed = result.executedCommands;
  if (!observed) return `- **Commands (self-reported, execution not observable):** ${list(result.commands)}`;
  const claimedOnly = claimedButNotObserved(result.commands, observed);
  return [
    `- **Commands executed (observed by OpenSwarm):** ${list(observed)}`,
    ...(claimedOnly.length > 0 ? [`- **Commands claimed by the worker but NOT observed running:** ${list(claimedOnly)}`] : []),
  ].join('\n');
}
