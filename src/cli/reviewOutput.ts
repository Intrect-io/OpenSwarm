// ============================================
// OpenSwarm — Machine-readable review output
// ============================================
//
// `openswarm review` only ever spoke to humans: coloured terminal text plus
// Linear issues. A CI gate needs the same verdict in a shape other tools can
// consume — a stable JSON contract for scripting, and SARIF so GitHub code
// scanning can surface findings inline on the pull request. (INT-3102)

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReviewResult, RecommendedAction } from '../agents/agentPair.js';

/**
 * The published package version, for the SARIF tool record. Read from
 * package.json rather than hardcoded so it cannot drift from what shipped;
 * cli.js lives at <pkg>/dist/, so the manifest is one directory up. Falls back
 * to '0.0.0' because a missing version must not fail a report that is otherwise
 * complete.
 */
export async function packageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Schema version for the `--json` contract. Bump on any breaking field change. */
export const REVIEW_JSON_SCHEMA_VERSION = 1;

export interface ReviewJsonFinding {
  /** Reviewer-assigned follow-up category, e.g. "bug", "test-coverage". */
  type: string;
  title: string;
  /** Raw location string as the reviewer wrote it, when it gave one. */
  location?: string;
  /** Parsed from `location` when it looks like `path` or `path:line`. */
  file?: string;
  line?: number;
}

export interface ReviewJson {
  schemaVersion: number;
  decision: ReviewResult['decision'];
  /** False when the reviewer never produced a verdict (quota, empty output). */
  gateRan: boolean;
  feedback: string;
  issues: string[];
  suggestions: string[];
  findings: ReviewJsonFinding[];
  costUsd?: number;
}

/**
 * Split a reviewer `location` into file and line.
 *
 * The field is free-form prose in practice — "src/foo.ts:42", "src/foo.ts",
 * "the auth middleware". Only the first two shapes can be placed in a file, and
 * a Windows drive letter (`C:\src\foo.ts`) must not be mistaken for a line
 * number, so the line is taken only from a trailing all-digits segment.
 */
/**
 * Root files that carry no extension. Without them a reviewer pointing at
 * `Dockerfile` loses its location entirely — the string has neither a separator
 * nor a dotted suffix, so the general rule reads it as prose. An explicit list
 * rather than a looser test, because "middleware" must keep failing it.
 */
const EXTENSIONLESS_FILES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile', 'Jenkinsfile', 'Procfile', 'Rakefile',
  'Gemfile', 'Vagrantfile', 'Brewfile', 'Justfile', 'LICENSE', 'README', 'CHANGELOG',
  'CODEOWNERS',
]);

function looksLikePath(value: string): boolean {
  if (!value) return false;
  // A separator or a dotted suffix is decisive on its own — real paths do
  // contain spaces, so whitespace must not veto them.
  if (/[/\\]/.test(value) || /\.[a-zA-Z0-9]+$/.test(value)) return true;
  // Otherwise it is a bare word. Only a known extensionless build file qualifies;
  // this is where "the auth middleware" has to lose.
  return !/\s/.test(value) && EXTENSIONLESS_FILES.has(value);
}

export function parseLocation(location: string | undefined): { file?: string; line?: number } {
  const raw = location?.trim();
  if (!raw) return {};

  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  if (match) {
    const candidate = match[1].trim();
    if (looksLikePath(candidate)) return { file: candidate, line: Number(match[2]) };
  }
  // No trailing line number. Treat it as a path only if it looks like one —
  // otherwise it is prose ("the auth middleware") and pointing a tool at it
  // would produce a bogus annotation on a file that does not exist.
  return looksLikePath(raw) ? { file: raw } : {};
}

/**
 * SARIF defines `artifactLocation.uri` as a URI *reference*, so a raw filesystem
 * path does not belong there. Windows separators become forward slashes and each
 * segment is percent-encoded — which matters for the spaces and `#` that appear
 * in real paths and would otherwise produce an unresolvable location.
 */
export function toUriReference(file: string): string {
  return file
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function toReviewJson(result: ReviewResult, gateRan = true): ReviewJson {
  const findings: ReviewJsonFinding[] = (result.recommendedActions ?? []).map((action: RecommendedAction) => ({
    type: action.type,
    title: action.title,
    ...(action.location ? { location: action.location } : {}),
    ...parseLocation(action.location),
  }));

  return {
    schemaVersion: REVIEW_JSON_SCHEMA_VERSION,
    decision: result.decision,
    gateRan,
    feedback: result.feedback ?? '',
    issues: result.issues ?? [],
    suggestions: result.suggestions ?? [],
    findings,
    ...(result.costInfo?.costUsd !== undefined ? { costUsd: result.costInfo.costUsd } : {}),
  };
}

/**
 * The document emitted when the reviewer never produced a verdict — quota
 * exhausted, adapter down, unparseable output. `decision` is empty because there
 * was none: reporting `revise` here would invent a verdict, which is the failure
 * INT-3100 exists to prevent. The reason lands in `feedback` so a CI step can
 * surface it without scraping stderr.
 */
export function gateNotRunJson(error: unknown): ReviewJson {
  return {
    schemaVersion: REVIEW_JSON_SCHEMA_VERSION,
    decision: '' as ReviewResult['decision'],
    gateRan: false,
    feedback: error instanceof Error ? error.message : String(error),
    issues: [],
    suggestions: [],
    findings: [],
  };
}

/**
 * SARIF 2.1.0, the format GitHub code scanning ingests.
 *
 * Findings without a resolvable file are still emitted — dropping them would
 * silently shrink the report — but they carry no `physicalLocation`, so GitHub
 * files them against the run rather than against a line that does not exist.
 */
export function toSarif(result: ReviewResult, toolVersion: string): unknown {
  const json = toReviewJson(result);

  // `issues` are the blocking findings and `recommendedActions` the advisory
  // ones — the reviewer prompt separates them deliberately. Emitting only the
  // latter meant a `revise` carrying issues and no follow-ups produced an empty
  // results array, so code scanning showed nothing at all for a failed gate.
  // Issues carry no location field, hence no physicalLocation.
  const issueResults = json.issues.map((issue) => ({
    ruleId: 'openswarm/issue',
    level: 'error',
    message: { text: issue },
  }));

  const rules = new Map<string, { id: string; name: string }>();
  if (issueResults.length > 0) rules.set('openswarm/issue', { id: 'openswarm/issue', name: 'issue' });
  for (const finding of json.findings) {
    const id = `openswarm/${finding.type || 'finding'}`;
    if (!rules.has(id)) rules.set(id, { id, name: finding.type || 'finding' });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'OpenSwarm',
            version: toolVersion,
            informationUri: 'https://github.com/unohee/OpenSwarm',
            rules: [...rules.values()].map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: `Reviewer follow-up: ${rule.name}` },
            })),
          },
        },
        results: [
          ...issueResults,
          ...json.findings.map((finding) => ({
            ruleId: `openswarm/${finding.type || 'finding'}`,
            // Follow-ups are advisory: several accompany an approve, so reporting
            // them as errors would fail code scanning on suggestions the review
            // itself accepted. The blocking findings are the issues above.
            level: 'warning',
            message: { text: finding.title },
            ...(finding.file
              ? {
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: toUriReference(finding.file) },
                        ...(finding.line ? { region: { startLine: finding.line } } : {}),
                      },
                    },
                  ],
                }
              : {}),
          })),
        ],
      },
    ],
  };
}
