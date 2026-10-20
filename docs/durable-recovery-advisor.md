# Durable loop recovery and Recovery Advisor

AGT-4780 implements the existing project/issue loop. It does not add a Mission execution mode. The default `autonomous.loopAdvisor.mode` is `off`; no running daemon or project configuration is enabled by this change.

## Reference decisions

- [OMP vibe director](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/system/vibe-mode-active.md): retain the workstream and independently read artifacts before accepting a worker claim. OpenSwarm keeps its existing role and project concurrency policy.
- [OMP workflowz](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/system/workflow-notice.md): explicit dependencies, typed results, bounded execution and verification at phase boundaries. These map to durable stage checkpoints rather than additional fan-out.
- [Factory Missions](https://docs.factory.com/missions/overview): planning and validation checkpoints inform the execution contract and artifact identity. The existing OpenSwarm pipeline remains the execution authority.
- [OMP advisor boundary](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/advisor/boundary-guidance.md): advice may be wrong or late. OpenSwarm reserves calls under its lease and rechecks ownership before applying policy.

These are design adaptations, not claims of behavioral or benchmark parity with those products.

## Execution truth

The existing automation SQLite database gains additive `automation_recovery`, `automation_progress_failures`, `automation_stage_checkpoints` and `automation_advice` tables. The run/attempt ledger remains responsible for owner, lease epoch, project lock, retry, operator wait, publication reconciliation and budgets.

The execution contract hashes task text, authoritative operator input, stage/role/guard/verify/security policy, file scope, acceptance criteria and task budget. A progress snapshot contains the actual Git tree digest, stable identifiers for adapter-observed commands or deterministic verification results, failure classification and consecutive unchanged failures. Self-reported `commands` and conversational activity are not execution evidence. A successful different stage does not erase another stage's repeated failure history.

Native repeated-call detection compares the call and its observed result. It emits `terminationCause: no_progress`; delegated CLIs retain stage-level observability. Reading changed output is progress. Inbox read/wait turns retain their existing exemption, including batches that also reread an unchanged file. A successful stage retains its termination signal as metadata; the signal alone never reclassifies successful work as a recovery failure or triggers an advisor park. A completed pipeline clears its resume boundary, so a reopened issue cannot reuse a former completion.

## Recovery boundaries

Only a known reviewer/tester infrastructure or quota exception can preserve a successful worker checkpoint for the next attempt. A crash during a command does not mark that command reusable. The current contract, artifact tree and verification environment must match exactly. A changed tracked or untracked file, intent, acceptance criterion, role/guard setting or trusted verification input invalidates reuse. A failed stage is never restored. Only the successful worker is restored. Required tests and the reviewer run again in the current environment: external services and undeclared installed-dependency changes cannot be completely attested by a Git/manifest fingerprint. The identity includes Node/platform/architecture, a hash of the sorted process environment, trusted verification inputs/commands and policy; raw environment values are never stored.

Quality/configuration failures, operator waits, unknown side effects, cancellations and changed policy do not authorize stage reuse. Existing durable publication/outbox reconciliation continues separately from implementation. Reusing a stage emits lifecycle and `pipeline:recovery` events and does not charge its earlier model cost again.

Trusted Native unknown-outcome and operator-wait flags survive worker, tester and reviewer parsing. They override a success/approve claim, stop the pipeline even with `continueOnTestFail`, and retain their stage and exact question correlations. Unknown side effects quarantine the run in `NEEDS_HUMAN` without a retry deadline and prohibit parked/unfinished publication. Idle fill, ephemeral-path heuristics and tracker Todo cannot release an unknown-outcome quarantine; explicit operator dispatch can. No successful checkpoint or advisor consultation is recorded for that boundary.

## Advisor policy

```yaml
autonomous:
  loopAdvisor:
    mode: off # off | shadow | active
    # adapter/model inherit the effective project/default advisor role when omitted
    timeoutMs: 45000
    triggerAfter: 2
    maxCallsPerIssue24h: 2
```

`off` performs no consultation. `shadow` records a diagnosis without changing execution policy. `active` may supply strategy feedback, select only that role's configured `escalateModel`, retain the coordinator's infrastructure backoff, or park for an operator. No action grants permission, changes acceptance/file scope, makes an operator decision, executes an arbitrary model-suggested command, or approves a result.

Explicit `loopAdvisor.adapter/model` take precedence; omitted fields inherit the advisor role after project overrides are merged with `defaultRoles.advisor`. The same effective role supplies the configured independent premise-verification tier.

Calls require a native adapter that enforces tool restrictions and a separately resolved model from the failed stage. Shell, filesystem, web, memory, MCP and coordination tools are withheld. The structured response must reference supplied evidence keys. Unknown fields/actions/evidence, malformed output, unsupported enforcement, missing model provenance, cancellation, timeout or provider failure leave the original failure policy intact.

Each evidence identity may reserve a consultation only once, including after failures or restart. A rolling 24-hour maximum of two reservations per issue includes failed calls and the independent premise-verification pass. A local deadline enforces the smaller of 45 seconds, configuration and remaining task time, including model lookup; ignoring an adapter's timeout does not hold the pipeline indefinitely. Provider usage is retained on invalid responses. Usage after a provider ignores cancellation cannot be reconstructed from an absent receipt.

Reservations and completion writes are lease-fenced SQLite transactions. New ownership interrupts a pending consultation; late results cannot apply. External execution holds, operator waits and unknown outcomes cannot be bypassed. Advice is automated feedback, never authoritative operator feedback. Strategy/model recommendations for identical evidence can be reapplied without another consultation on a later attempt. Advisor stop/operator parks are excluded from idle-fill, including the durable resume gate. An explicit operator resume atomically consumes the prior terminal recommendation, so it does not immediately re-park the resumed run.

For `verify_claim`, the second pass must use a configured reviewer/advisor `escalateModel` distinct from both the failed reviewer and the first advisor, including their provider-reported identities. Without such a tier it records unavailable and preserves the review. This tool-free pass sees the original reviewer claim and bounded repository-internal source excerpts. Symlinks outside the repository and oversized files are excluded. A typed `supported/refuted/unknown` result and its evidence keys are persisted; truncated source forces `unknown`. Passing unrelated checks never refutes a finding. The original review remains blocking: the regular required reviewer and verification gates must still pass before completion. This pass is source-based; it does not run an arbitrary proposed reproduction command.

Hermes clarification advice is unchanged: its existing opt-in and approval boundary remain separate.

## Operator visibility

Authenticated `GET /api/automation/runs/:issueId` returns the durable run plus `recovery.contract`, `progress`, `advice`, `nextAction` and `reason`. Existing stats include `automationLedger.recovery` counts derived from the full ledger, not the bounded live board. `pipeline:recovery` SSE events announce observations, reused stages and advice. A pending consultation with an expired/replaced owner reads as interrupted, not processing.

The human-question producer rechecks answered state after notification, and the coordination-store lock rejects a late pending page marker after a durable answer. The supervisor also treats a completed answer as absorbing for historical markers.

## Verification and limits

Run `npm test -- src/agents/pairPipeline.recovery.test.ts src/automation/runRecoveryStore.test.ts src/agents/recoveryAdvisor.test.ts src/adapters/agenticLoop.turns.test.ts src/adapters/agenticLoop.coordinationProgress.test.ts src/coordination/humanQuestions.test.ts src/coordination/orchestratorSupervisor.test.ts --maxWorkers=2` for restart, stale lease, modes, limits, changed artifacts, model policy, no-progress and notification-race controls.

Fault fixtures establish deterministic policy and delivery behavior. Actual-provider consultation is recorded separately; fixture success alone is not evidence of real model quality or unattended production reliability. No production activation or deployment is part of this change.
