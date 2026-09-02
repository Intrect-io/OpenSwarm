# Durable autonomous loop

OpenSwarm separates two kinds of truth:

- Linear or the local issue store owns user intent, issue state, and discussion.
- `~/.openswarm/automation.db` owns execution state, leases, attempts, artifacts,
  repository admission, and pending external effects.

JSON task-state files remain compatibility projections. Once an issue has a row
in `automation.db`, they cannot claim work or override the durable state.

## Rollout modes

Set `autonomous.automationLedgerMode` to one of:

- `off`: legacy behavior; the ledger is not opened.
- `shadow`: insert-only discovery projection. It never claims work, fences a
  worker, creates an outbox effect, or changes tracker delivery.
- `primary`: the ledger is the fail-closed execution authority.

Legacy state migrates lazily per actionable issue in `primary`. Exhausted work is
imported as `NEEDS_HUMAN`; work with an old branch, worktree, completion flag, or
in-progress marker is imported as `NEEDS_RECONCILE`. An import is insert-only, so
later JSON reads can never rewind a durable row.

## State and recovery

The normal path is:

```text
READY -> CLAIMED -> EXECUTING -> VERIFYING -> PUBLISHING
      -> SYNC_PENDING -> DONE
```

`CLAIMED` through `PUBLISHING` require the current owner, lease token, lease
epoch, and an unexpired lease. A stale callback cannot renew, change stage,
attach a worktree/PR, record a result, or publish an outbox acknowledgement.

On restart or inside a competing claim transaction, expired active states move
to `NEEDS_RECONCILE`. The expired owner's token remains attached until the
original executor promise exits, or a later daemon proves the owner PID is
dead. The state is not claimable and continues to consume a repository slot
until both that exit fence and artifact inspection clear it. The reconciler
then checks artifact truth:

1. An open or merged PR moves the run to `SYNC_PENDING`; only tracker sync runs.
2. A closed, unmerged PR moves the run to `NEEDS_HUMAN`.
3. No PR returns the run to `READY` only when the worktree is missing, safely
   preserved, or owned by a process that is confirmed gone. A live owner or
   ambiguous marker stays parked so stale and replacement workers cannot overlap.
4. An unavailable GitHub lookup leaves the run parked in `NEEDS_RECONCILE`.

Unknown worktrees are retained. Only a terminal ledger row or another proven
orphan authorizes pruning. During a live attempt, only an exact
`success + approved` result removes its worktree; thrown setup/pipeline/tracker
paths preserve partial work for reconciliation.

## Concurrency invariants

- Claim, repository-cap, attempt/cost budget, and circuit checks run in one
  `BEGIN IMMEDIATE` SQLite transaction across processes.
- An expired repository owner blocks a new owner until reconciliation records
  the old attempt as orphaned.
- Same-repository concurrency defaults to one and can exceed one only with
  worktree isolation plus explicit repository policy.
- Repository admission, conflict grouping, project enable/disable, worktree
  pruning, and ledger rows all use the same `realpath`-canonical identity.
  Symlink or `..` aliases cannot create a second concurrency domain.
- Queue admission is authoritative: a duplicate or stopping-time rejection does
  not consume the heartbeat's slot budget.
- Hard-timeout executors quarantine their repository until the underlying
  process actually exits; multiple timed-out executors are tracked independently.
  Reclaiming a logical scheduler slot is not enough.
- Worktree create/resume and terminal cleanup share an issue-scoped SQLite
  lifecycle lock. Ownership is re-read while holding it, so a stale prune or
  STUCK cleanup cannot delete a worktree that a replacement owner just resumed.
- PR creation uses re-read-after-create-failure, covering two publishers that
  both observed no PR and client failure after GitHub accepted a create.
- Outbox claims have renewable, fenced delivery leases. Linear completion
  comments use a deterministic UUID plus a hidden marker; local-tracker comments
  use the marker. Remote success followed by local crash therefore converges on
  the same logical completion effect during retry.
- The successful-run state transition and outbox insert commit in one immediate
  transaction; no consumer can observe an effect for an executing run.
- Cancellation also commits `SYNC_PENDING` plus `tracker.cancel` atomically. A
  failed `Backlog` transition cannot leave `CANCELLED + Todo` and be mistaken for
  an operator reopen; only the acknowledged effect finalizes `CANCELLED`.
- Outbox acknowledgement and the final `SYNC_PENDING -> DONE/CANCELLED`
  transition commit together. Startup also repairs the historical split-write
  window before claiming new effects.
- Decomposition child issues use deterministic UUIDv4 identities, so a crash
  after creating only part of a plan recovers the same children instead of
  filing a second set.
- Child tracker state and comments converge before the parent is marked
  decomposed. Budget/depth projection is idempotent and advances only after all
  asynchronous child effects succeed.
- Async pipeline-event effects drain to a fixed point before the execution may
  become terminal. Durable stage/publication callbacks are critical fences;
  rejection aborts the lifecycle and preserves the worktree.
- Shutdown stops admission, aborts executors, and waits for the active heartbeat
  and asynchronous scheduler handlers. If the grace deadline expires, ledger
  close is deferred until late callbacks cross the stopping fence.

## Repository policy

An optional `automation` block in `openswarm.json` controls admission:

```json
{
  "automation": {
    "enabled": true,
    "maxConcurrent": 1,
    "maxAttemptsPerHour": 12,
    "maxFailuresPerHour": 6,
    "maxCostUsdPerDay": 10,
    "circuitCooldownMinutes": 60
  }
}
```

Unreadable or invalid policy is an infrastructure failure, not permission to
run with guessed defaults.

A separate `publication` block decides what happens to the pull requests the
swarm publishes from this repository. Worker attempts run only deterministic
guards and verification; the agentic fresh review (`openswarm pr review
--fresh`) runs once, right after the PR is published, and only where the
repository opts in:

```json
{
  "publication": {
    "freshReview": true
  }
}
```

It lives outside `automation` so opting in does not pull that block's admission
defaults in with it. A review failure is logged on the run but never undoes the
publication or re-publishes the PR.

## Operations

Relevant service settings are:

```yaml
autonomous:
  automationLedgerMode: primary
  automationLeaseMs: 600000
  shutdownGraceMs: 30000
```

`/api/stats` exposes ledger state/effect counts, expired leases, pending effect
age, and open circuits. A lifetime SQLite writer lock is acquired before any
Linear/Discord/web side effect, closing the port-probe check-then-bind race; the
OS releases it on process death. launchd gets a 45-second exit timeout. At
startup, `stdout.log` and `stderr.log` are copy-truncated under a separate SQLite
writer lock when they exceed 25 MiB; five generations are kept. Override the
threshold with `OPENSWARM_LOG_MAX_BYTES`.

Before promoting a rollout, run the focused race/fault tests plus the full suite:

```bash
npm test -- src/automation/runLedger.test.ts \
  src/automation/durableRunCoordinator.test.ts \
  src/automation/autonomousRunner.durable.test.ts \
  src/orchestration/taskScheduler.coverage.test.ts \
  src/support/worktreeManager.coverage.test.ts \
  src/support/serviceInstanceLock.test.ts
npm test
npm run typecheck
```
