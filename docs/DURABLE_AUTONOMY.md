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

### Spend budgets

The daemon config sets two budgets (AGT-4807). They are read from the run
ledger's recorded attempt costs. An attempt with no recorded cost counts at
the same estimate the daily ceilings use. The usage ledger
(`~/.openswarm/usage/*.jsonl`) is not the source: only the agentic-loop
adapters write it, so Claude CLI runs never appear there, and it is per host
while the run ledger is shared by every daemon that claims from it. Days are
UTC, as in both ledgers.

```yaml
autonomous:
  budget:
    perProjectDailyUsd: 20   # used when openswarm.json sets no automation.maxCostUsdPerDay
    perIssueUsd: 5
```

- **Project daily budget:** a project at or over it gets no claims until
  00:00 UTC. The first refusal of the day sends **one** notifier alert per
  project, deduplicated in the ledger (`automation_budget_alerts`), so
  several daemons sharing one ledger still alert once. A repository's own
  `automation.maxCostUsdPerDay` takes precedence. The daemon-wide
  `autonomous.spend.maxCostUsdPerDay` also alerts once a day.
- **Issue budget:** counts what one issue has spent since its budget park was
  last lifted (other resumes do not reset it). When the issue is at or over the budget, its next claim parks
  it as `NEEDS_HUMAN` (`issue_budget_exhausted`) without running anything.
  The park adds no spend of its own. The tracker gets the one operator-park
  comment, which shows the spend. An explicit dispatch (the dashboard issue
  board) resumes it and starts a fresh budget. Moving the issue back to Todo
  alone does not lift this park, and neither does a free idle-fill slot.

A separate `publication` block decides what happens to the pull requests the
swarm publishes from this repository. Worker attempts run only deterministic
guards and verification; the agentic fresh review (`openswarm pr review
--fresh`) runs once, right after the PR is published. It is on by default — a
repository turns it off with:

```json
{
  "publication": {
    "freshReview": false
  }
}
```

It lives outside `automation` so the setting does not pull that block's
admission defaults in with it.

When the reviewer asks for changes, the publication is undone (AGT-4270): the
PR goes back to draft so nobody merges it, and the run drops out of `approved`
so the worktree is preserved and the task returns to the queue. The commits and
the durable record stay — deleting them would strand the work and invite a
duplicate PR. A review that merely *failed* — no diff against the merge base, a
crashed processor, or a failure posting the comment after an approval — says
nothing about the code and undoes nothing.

That draft flag is load-bearing downstream: the reconciler treats a draft PR on
a run's branch as work still in progress and returns the run to the queue,
rather than reading an open PR as delivery and completing the issue.

### Change risk class

Every publication classifies the diff it commits as `low`, `medium` or `high`
(AGT-4804, `src/support/changeRisk.ts`). It prints the class on the PR under
`## Risk: <level>` and stores it in the attempt's `result_json` as
`changeRisk`. The classifier is deterministic. It reads only the
`git diff --numstat` of the branch against its base, never the issue text or
a model.

- **high:** any of these:
  - deploy or infra paths (`Dockerfile`, compose, `infra/`, `*.tf`, `wrangler.toml`, release scripts);
  - CI (`.github/workflows/`, `.githooks/`);
  - migrations (`migrations/`, `*.sql`);
  - auth and secret paths (`auth`, `secret`, `credential`, `key`, `token`, `.env*`, `*.pem`);
  - a protected path;
  - more than 20 files or 600 changed lines.
- **medium:** dependency manifests or lockfiles, binary files, more than 5 files or 150 lines, or a diff that cannot be read (unknown is never `low`).
- **low:** everything else.

Documentation files do not trip the deploy/infra and CI rules. A large docs-only change is capped at `medium`.

A repository adds its own rules. The rules are read from the operator's checkout, not from the worktree the worker edited:

```json
{
  "publication": {
    "risk": {
      "highPaths": ["src/billing/**"],
      "mediumPaths": ["src/ui/**"],
      "protectedPaths": ["src/orders/**"],
      "lowMaxFiles": 5, "lowMaxLines": 150,
      "mediumMaxFiles": 20, "mediumMaxLines": 600
    }
  }
}
```

Rules only add to the defaults. A project cannot mark a default high-risk path as low.

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
