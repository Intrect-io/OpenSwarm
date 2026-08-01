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
export function parseLocation(location: string | undefined): { file?: string; line?: number } {
  const raw = location?.trim();
  if (!raw) return {};

  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  if (match && match[1].trim().length > 0) {
    return { file: match[1].trim(), line: Number(match[2]) };
  }
  // No trailing line number. Treat it as a path only if it looks like one —
  // otherwise it is prose ("the auth middleware") and pointing a tool at it
  // would produce a bogus annotation on a file that does not exist.
  return /[/\\]|\.[a-zA-Z0-9]+$/.test(raw) ? { file: raw } : {};
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
 * SARIF 2.1.0, the format GitHub code scanning ingests.
 *
 * Findings without a resolvable file are still emitted — dropping them would
 * silently shrink the report — but they carry no `physicalLocation`, so GitHub
 * files them against the run rather than against a line that does not exist.
 */
export function toSarif(result: ReviewResult, toolVersion: string): unknown {
  const json = toReviewJson(result);

  const rules = new Map<string, { id: string; name: string }>();
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
        results: json.findings.map((finding) => ({
          ruleId: `openswarm/${finding.type || 'finding'}`,
          // Every reviewer follow-up is advisory: the blocking decision is the
          // verdict, not the individual finding. Reporting these as `error`
          // would fail code scanning on suggestions the review itself approved.
          level: 'warning',
          message: { text: finding.title },
          ...(finding.file
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.file },
                      ...(finding.line ? { region: { startLine: finding.line } } : {}),
                    },
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
}
