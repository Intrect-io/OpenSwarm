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
