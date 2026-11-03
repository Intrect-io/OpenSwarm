# Agent code factory — recursive red team

OpenSwarm's end state is an *agent code factory*: issue → unattended worker and
reviewer → deterministic verification → pull request → merge, with no person at
the keyboard, producing code that can be trusted. This document records the red
team rounds run against that claim, what each found, what was decided, and where
it was fixed.

Each round follows the same protocol:

- Two attack axes are chosen from different layers, so they do not just vary
  each other:
  - L1 internal consistency
  - L2 boundaries and contracts
  - L3 time and scale
  - L4 environment, people and incentives
- One axis is the main attack on the success condition; the other is a flank
  the authors were least likely to have considered.
- Each axis gets its own subagent with a researched, real-world persona, and the
  two run in parallel.
- Every finding needs a reproduction path. The orchestrator re-checks each one
  against the code before ruling it CONFIRMED, PLAUSIBLE (with the action that
  would settle it) or REJECTED (with the evidence that it is wrong).
- A later round must use axes from layers other than the earlier rounds', and
  attacks the state left by the earlier fixes.

## Round 1

- **Date:** 2026-11-03.
- **Target:** origin/main `d8b63a6`.
- **Mode:** default (2 parallel agents).
- **Axis A:** L4/incentive (Goodhart). Persona: ML evaluation-integrity
  engineer (reward-hacking investigator for coding agents).
- **Axis B:** L3/ops (unattended operation). Persona: on-call SRE for an
  unattended batch/CI fleet.
- **Duplicate rate:** 0%. No two findings share a cause or a fix. A-F2 and A-F3
  overlap only partly, because protecting config removes part of F2, so they
  stayed separate.
- **Rejection rate:** 0%. Every finding was re-checked against `d8b63a6` before
  it was adopted.

| # | Axis | Vector | Trigger | Damage | Reproduction (verified) | Verdict | Severity | Fix |
|---|---|---|---|---|---|---|---|---|
| A-F1 | L4/incentive | Turning a test into a skip, or deleting a pytest/Go test, was invisible, and the guard only commented after publication | A worker skips the failing acceptance test | PR #580 pattern: mutants survive, ready PR, unattended merge | `deletedTestGuard.ts:35` counted `it.skip(` as `it(` (node eval: 1 and 1); `:55` read JS/TS only; `publicationReviewHook.ts:94` only commented | CONFIRMED | critical | #861 (+ #861 follow-up `277b246`) |
| A-F2 | L4/incentive | The worker controlled the test-runner/coverage config that verify read | Head adds `test.exclude`, lowers thresholds, or edits `conftest.py` | The deterministic gate reports a pass it never measured | `runner.ts:704` pinned only package.json `scripts`; no config guard in `src/verify` | CONFIRMED | critical | #862 |
| A-F3 | L4/incentive | `protectedFiles` was enforced but never set by a production caller | Any unattended run | The grader's inputs stay writable by the graded party | Only `worker.ts:421` forwarded it; no assignment anywhere | CONFIRMED | major | #865 |
| B-F1 | L3/ops | `rate_limited` retried every 60 s forever, outside every circuit, with no notice | Quota exhausted or OAuth expired without a reset time | Silent stall; one issue made 804 attempts (792 rate limited) in 3 days | `durableRunCoordinator.ts:156`; live ledger | CONFIRMED | major | #866 |
| B-F2 | L3/ops | The cost ceiling was per-repo opt-in, read NULL cost as free, and dropped the cost of lease-expired attempts | Any unattended spend | Undefined spend ceiling; 75% of 8,291 live attempts had no cost | `runLedger.ts:670-678` UPDATE fenced on lease; live ledger | CONFIRMED | major | #867 |
| B-F3 | L3/ops | The reconciler swallowed the `ls-remote` cause and re-warned every heartbeat, serially | Missing git credentials or remote | 32% of a day's log was this line; rows pinned forever; heartbeat stalls | `autonomousRunner.ts:1794-1800`; 22,204 of 68,629 log lines | CONFIRMED | major | #868 |
| B-minor | L3/ops | Tests wrote the operator's live `daily-pace.json` and `~/.openswarm/bus` | Every vitest run | Dashboard counts inflated; 4,709 bus dirs (81 MB) | `runnerState.ts:158`, `agentBus.ts:108`, no env override | CONFIRMED | minor | #860 |

**Out of scope (operator facts, not repository code; not acted on):**

- The `openswarm` daemon container has been stopped since 2026-09-29 with
  `RestartPolicy=no`.
- The host's `vela-autodeploy.sh` defaults to disabled.
- The watcher raises about 47 critical alerts a day, unactioned.
- The work disk is at 93%.

**Shipped alongside round 1, at the operator's request:**

- The `claude -p` harness isolation (#859).
- The ADE desktop workspace: Linux build and CI (#863), the bundled workspace
  over a read-only allowlisted proxy (#864), and confirmed stop/retry actions
  with the token kept in the shell (#869).

## Round 2

- **Date:** 2026-11-04.
- **Target:** origin/main `d18c11c`, the state after every round-1 fix and the
  ADE (#859–#869).
- **Mode:** default (2 parallel agents).
- **Axis A:** L2/trust (who controls which input). Persona: penetration
  tester for CI/CD and agent platforms. Reference incidents:
  `pull_request_target` poisoned pipeline execution, prompt-injection-driven
  tool misuse, `conftest.py`/jest-setup hijacking.
- **Axis B:** L1/state (invariants and stuck states). Persona:
  formal-verification engineer for distributed job state machines.
  Reference incidents: DynamoDB 2015 metadata storm, Kubernetes controller
  hot loops, Celery/Temporal auxiliary state not cleared on other exit paths.
- **Layers:** both axes are from layers round 1 did not use (it used L4 and
  L3).
- **Duplicate rate:** 0%. A-F2 and A-F3 both widen what `pinTrustedTestConfig`
  pins, but they are different inputs (an untracked ignored file vs a tracked
  file under another name) and neither fix removes the other. No B finding
  shares a cause with an A finding.
- **Rejection rate:** 0% of the six reported findings. Each agent also rejected
  candidates of its own:
  - A: the ADE proxy, the token handling, and auth lifting under the #842
    policy.
  - B: an exit-less `active_tests_removed` park, and protected files changing
    mid-run. Both had evidence of a working exit or of being computed once.
- **Check:** every finding was re-checked against the code before its verdict.

| # | Axis | Vector | Trigger | Damage | Reproduction (verified) | Verdict | Severity | Fix (this branch) | Proof |
|---|---|---|---|---|---|---|---|---|---|
| A-F1 | L2/trust | The opt-outs (`tests.allowRemoval`, `tests.allowEdits`, "the issue names this file") were read from `task.description`, which by then carries the tracker comment history, earlier workers' summaries included | A worker writes a DoD block or a test file name in its summary; the next attempt reads it as the issue's | The graded party disables the active-test gate and unprotects the tests; any commenter can too | `executionTaskContext.ts:51` appends comments to `description`; `linear.ts:355` posts `workerSummary`; `dodContract.ts` `FENCE` takes the first block anywhere; `protectedFiles.ts`/`testRemovalGate.ts` read that text | CONFIRMED | critical | `issueOwnText()` cuts the description at `EXECUTION_COMMENT_CONTEXT_HEADING`; `parseDoDContract` (also used by `coordinatorResolution`) and the name rule read only that | `pairPipeline.protectedFiles.test.ts` "ignores opt-outs that appear only in the appended comment history"; `testRemovalGate.test.ts` "does not take allowRemoval from the appended comment history" |
| A-F2 | L2/trust | A gitignored test-runner config bypassed the base pin | Add `tests/conftest.py` to `.gitignore`, then create it with `collect_ignore` | Verify goes green without collecting the failing test; the PR diff shows only one `.gitignore` line | `runner.ts:144-150` copies ignored files into the sandbox; `trustedConfig.ts:119` listed only `--exclude-standard` untracked files | CONFIRMED | major | `findPinnedFiles` walks the sandbox (skipping dependency, build and cache trees) for every pinned file. One git does not track fails closed; one that differs from base is pinned | `runner.trustedConfig.test.ts` "a gitignored head-only conftest.py cannot turn a failing check green" (fails with the walk disabled) |
| A-F3 | L2/trust | Setup modules the pinned config loads (`setupFiles`, `globalSetup`, `vitest.setup.ts`, `jest.setup.js` …) were neither pinned nor protected | Edit the setup module to skip or mock the failing path | The pinned config loads the change's own setup code | `protectedFiles.ts` `isGraderFile` and `trustedConfig.ts` `PINNED_CONFIG` had no setup patterns; this repo's `vitest.config.ts` uses `setupFiles: ['./vitest.setup.ts']` | CONFIRMED | major | Setup/teardown names added to `PINNED_CONFIG`; `referencedTestSupportFiles` resolves each base runner config's `setupFiles`/`setupFilesAfterEnv`/`globalSetup`/`globalTeardown`/`snapshotSerializers`, and both pinning and `protectedFiles` cover them | `runner.trustedConfig.test.ts` "a head-only vitest.setup.ts change cannot turn a failing check green"; `pairPipeline.protectedFiles.test.ts` "protects the setup modules a runner config loads, whatever their name" |
| B-F1 | L1/state | The rate-limit streak counted results, not retries: N parallel workers hitting one 429 ramped N steps at once | 8 workers share a quota burst (the default `maxConcurrentTasks` is 64) | One momentary limit became a one-hour daemon-wide pause, and later a false `degraded` notice | `rateLimitBackoff.ts:73-77` `hits++` on every call; round-1 test pinned 6 same-instant hits = 32 min | CONFIRMED | major | A hit that lands while a pause is in force only extends to a later provider reset time; only a hit after the pause ends escalates | `rateLimitBackoff.test.ts` "counts same-instant hits from parallel workers as one step" |
| B-F2 | L1/state | Pre-model results (`rate_limited`, `superseded`, `deferred`) have no cost, so they counted at the unknown-cost estimate | A rate-limit storm with a ceiling configured | The spend circuit opens without one model call, and holds until UTC midnight | `pipelinePreflight.ts` result has no `totalCost`; `durableRunCoordinator.ts:787` stores NULL; `runLedgerCost.ts` excluded only `operator_remediated` | CONFIRMED | major | `NO_SPEND_STATUSES` are excluded from the unknown count; in-flight and crashed attempts (no result) still count | `runLedger.costCircuit.test.ts` "rate-limited attempts without cost do not count toward the ceiling" |
| B-F3 | L1/state | The origin-lookup backoff row outlived its incident, because only a probe success or a permanent verdict cleared it | The pointer clears another way, then the same issue loses its worktree again | The new incident started at the long delay with no log line (`failures === 1` never true), reintroducing round-1 B-F3's "cause nowhere" | Only `missingWorktreeReconciler.ts` touches `automation_origin_lookup_backoff`; no other cleanup path | CONFIRMED | major (B reported "minor–major") | Each sweep calls `store.retainOnly(candidate issue ids)` before probing | `reconcileMissingWorktree.test.ts` "a new incident after the pointer cleared elsewhere starts its backoff over" |

**Residual limits, not defects of this branch:**

- B-F2: a run that was rate-limited **after** spending (mid-run) and reported
  no cost is now counted as zero rather than at the estimate.
- A-F3: setup references are resolved from string literals in the runner
  config. A config that builds the path at runtime is not followed. The
  sandbox walk still pins any setup-named file.
- Delegated CLI adapters still do not receive `protectedFiles` (the #842
  policy keeps them out of unattended runs unless the operator opts in).

## Open

None. Every round-2 critical or major finding is fixed on this branch with a
test.
