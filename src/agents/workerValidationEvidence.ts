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
const VALIDATION_COMMAND_RE = /\b(npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|pnpm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|yarn\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|bun\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|vitest|jest|mocha|pytest|ruff|mypy|pyright|tsc|eslint|oxlint|cargo\s+(?:check|test|clippy|build)|go\s+(?:test|vet|build)|swift\s+test|gradle\s+(?:test|build|check)|mvn\s+(?:test|verify)|make\b|cmake\b|py_compile|compileall|clippy|fmt\s+--check)\b/i;
// Anchored at each segment start: a leading inspection verb means that segment
// ran no validation (e.g. `rg "npm test"` searches for the string, it does not
// run it), so the segment is skipped rather than the whole command rejected.
const INSPECTION_ONLY_COMMAND_RE = /^\s*(?:rg|grep|sed|cat|ls|find|pwd|git\s+(?:status|diff|show|log|grep)|jq|head|tail|wc|tree|du|file|which)\b/i;
const SCRIPT_SMOKE_COMMAND_RE = /^\s*(?:python3?|node|tsx|ts-node|uv\s+run|npx|bunx|bash|sh)\b.*\b(?:scripts?\/|tests?\/|\.py|\.js|\.ts|\.sh|--help|--dry-run|smoke|verify|validate|check|test|build|compile)\b/i;
const TESTER_CODE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cpp|h|hpp)$/;

export function isValidationRelevantFile(file: string): boolean {
  if (/(^|\/)docs?\//i.test(file)) return false;
  if (VALIDATION_RELEVANT_BASENAME_RE.test(file)) return true;
  // Data/asset trees (locale, fixtures, snapshots, mocks) are exempt ONLY for
  // non-code assets. A real source module under such a dir still needs a check.
  if (DATA_ONLY_DIR_RE.test(file) && !TESTER_CODE_FILE_RE.test(file)) return false;
  return VALIDATION_RELEVANT_FILE_RE.test(file) && !DOC_ONLY_FILE_RE.test(file);
}

function validationRelevantFiles(files: string[]): string[] {
  return files.filter(file => {
    return isValidationRelevantFile(file);
  });
}

function commandLooksLikeValidation(command: string): boolean {
  // Workers routinely chain inspection then validation in one string
  // (e.g. "git diff && npm test"). Evaluate each shell segment independently so
  // a leading inspection verb does not mask a real validation command in a later
  // segment, while an inspection-only segment (which may merely *mention* a test
  // command as a search string) still counts as no validation.
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
  const candidates = segments.length > 0 ? segments : [command];
  return candidates.some(seg => {
    if (INSPECTION_ONLY_COMMAND_RE.test(seg)) return false;
    return VALIDATION_COMMAND_RE.test(seg) || SCRIPT_SMOKE_COMMAND_RE.test(seg);
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
    ? (result.commands ?? []).filter((command) => commandLooksLikeValidation(command) && !observed.includes(command))
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
