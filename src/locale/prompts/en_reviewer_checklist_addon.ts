// ============================================
// OpenSwarm - Reviewer Checklist Addon (English)
// Source-string invariant test detection (single source of truth)
// ============================================

/**
 * Checklist item for detecting weak source-string invariant tests.
 *
 * A test that inspects source code text (e.g., `inspect.getsource`,
 * `__code__`, `readFile(__filename)`) instead of exercising real behavior
 * is a weak guard — it can be bypassed by moving the same logic to a
 * helper function. This checklist item ensures the reviewer:
 *
 * 1. Identifies such tests as weak guards, not full invariant proofs.
 * 2. Verifies the checked tokens are real API names in the codebase.
 * 3. Documents what mutation the test cannot catch (e.g., indirect calls).
 */
export const sourceStringChecklistItem =
  `Source-string invariant tests: if the test uses source inspection (e.g., \`inspect.getsource\`, \`__code__\`, \`readFile(__filename)\`), verify it checks for real API names that exist in the codebase and document what mutation it cannot catch (e.g., "indirect calls via helper"). A test that only checks source text is a weak guard — it passes when the same logic is moved to a helper function. Do not treat it as a full invariant proof; approve only with that limitation stated in the verdict, and prefer a cheap behavior-based alternative (e.g., a mock client whose forbidden method fails the test when called) when one exists.`;