/**
 * Turning a failing tester result into feedback the next iteration can act on.
 *
 * A deterministic tester failure used to be deferred to the reviewer rather
 * than to the bounded self-repair loop. The default config disables the
 * reviewer stage, so that deferral had no recipient and the run ended instead
 * of retrying. The pipeline now defers only when a reviewer is configured, and
 * otherwise records the failure here and starts another iteration (AGT-4438).
 */

import type { ReviewResult } from './agentPair.js';
import { buildTestFixPrompt, type TesterResult } from './tester.js';

/**
 * How much of a failing command's output one reflection entry carries.
 *
 * Bounded because the trail goes into the next worker prompt, and taken from
 * the tail because pytest, vitest and go test all print their summary last.
 */
export const TEST_FAILURE_EXCERPT_CHARS = 1200;

/**
 * The errors to record in the reflection trail for a failing tester run.
 *
 * `TesterResult.failedTests` from the deterministic runner holds COMMAND names
 * (`deterministicTester.ts`), so a trail built from it told the worker
 * "pytest" and nothing else. Prefer each failing command's own output; fall
 * back to the names, then to a count, when there is no evidence to quote.
 * This is the same defect AGT-4436 fixed on the cross-attempt channel.
 */
export function testerReflectionErrors(result: TesterResult | undefined): string[] {
  const fromEvidence = (result?.verificationEvidence ?? [])
    .filter((item) => item.headStatus === 'fail')
    .map((item) => `${item.command.name}: ${item.rawOutputTail.slice(-TEST_FAILURE_EXCERPT_CHARS)}`);
  if (fromEvidence.length > 0) return fromEvidence;

  const failedTests = result?.failedTests ?? [];
  if (failedTests.length > 0) return failedTests;

  return [result?.error || `Tests failed (${result?.testsFailed ?? 0} failing)`];
}

/** The revise instruction a failing tester run stands in for. */
export function testerRevisionFeedback(result: TesterResult): ReviewResult {
  return {
    decision: 'revise',
    feedback: buildTestFixPrompt(result),
    issues: result.failedTests,
    suggestions: result.suggestions,
  };
}
