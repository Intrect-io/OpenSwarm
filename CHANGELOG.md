# Changelog

## 0.19.1 — 2026-07-26

### Fixed

- **A pre-existing test failure no longer reports as a regression** — `hasSameFailure` waives a failing command when the base and head runs produce the same output fingerprint, but only the command's `cwd` was path-normalized. With a subdirectory `cwd`, everything outside it kept its random sandbox prefix — sibling sources, and the isolated `HOME`/`TMPDIR` beside the project root — and the two runs happen in different `mkdtemp` directories, so identical failures hashed differently. stdout and stderr also shared one fingerprint buffer filled in arrival order, letting OS scheduling change the hash of the same output. Paths are now normalized across the whole sandbox and the streams are captured separately and concatenated in a fixed order. (#321)
- **Rollback restored the wrong stash** — `stash@{N}` is a position, not an identity: every `git stash push` shifts existing entries down, and the checkpoint reused the index captured at creation time. The `stash` strategy pushes `rollback-preserve-*` immediately before popping, so it reliably restored the stash it had just created and orphaned the checkpoint's — the work a user asked to preserve came back as different changes. The checkpoint stash is now located by its message at pop time, and a missing stash reports failure instead of popping whatever occupies that index. (#322)
- **One telemetry install id per install** — `getInstallId()` and `maybeShowNotice()` each did read-then-write from a stale read, so on a first run a daemon and a CLI could both mint an id and the later write replaced the other. State was also written in place, so a reader seeing a torn file regenerated the id as if the install were new. Writes now merge against the current file and go through the atomic write helper the rest of the local state already uses. (#323)

## 0.19.0 — 2026-07-23

### Added

- **`openswarm provider` switches the provider from the terminal** — provider switching only existed in the dashboard and the TUI, so an operator whose provider ran out of quota had to open a browser or hand-edit `provider-override.json` and restart the daemon. `openswarm provider` opens a picker with the current provider preselected; `openswarm provider <name>` switches directly. A running daemon is switched **in place**, so work already in flight moves too, and with no daemon the choice is recorded for the next start. If a live daemon refuses the switch nothing is persisted, so the override file can never describe a provider the running process is not using. Non-TTY invocations print status instead of prompting. The picker lists adapters from the live registry rather than a hardcoded set. (INT-2997, #317)
- **Durable run state machine for the autonomous loop** — a SQLite-backed state machine with fenced leases, repository admission, retry/cost circuits, transactional outbox delivery and crash reconciliation. The loop previously mixed in-memory completion state, async callbacks, tracker/PR side effects and filesystem cleanup with no single ownership authority, so a restart, timeout, duplicate daemon generation or late callback could duplicate work, lose a completion, prune a live worktree or start an overlapping worker. Expired owners now stay fenced until the original executor actually exits or a replacement proves the owner PID is dead. (#310)
- **Worker models route by workload tier** — GPT-5.6 models are selected per workload tier instead of one model for every role. (#311)

### Changed

- **Verification runs inside an OS sandbox and fails closed without one** — every verification command is now executed under `sandbox-exec` on macOS and `bubblewrap` on Linux, with process-tree termination and environment isolation. **This adds a deployment prerequisite:** a Linux host needs `bwrap` installed *and* unprivileged user namespaces permitted (ubuntu-24.04 restricts these through AppArmor), otherwise every verification is refused with `[security] OS verification sandbox is unavailable`. macOS needs no setup. (#315)

### Fixed

- **Same-repository issues no longer starve each other** — with `allowSameProjectConcurrent` enabled but `maxConcurrentPerProject` unset, the scheduler read the per-repository limit as unlimited while the durable coordinator defaulted to 1, so independent issues in one repository cycled `queued → started → claim_deferred` forever (one deployment measured 70 open issues with 1 running and 14 deferred). All three layers now derive the cap from one source, scope resolution is shared, unknown write scope fails closed instead of racing, the heartbeat compares candidates against workers already running in another worktree, and claim-time scope overlap is checked inside the same SQLite transaction as the claim. (INT-2927, #316)
- **Repeated and false STUCK issues** — a stuck report could be raised for work that was progressing and re-raised for the same issue. (#311)
- **An empty reviewer response is no longer a verdict** — a reasoning-only or blank completion was accepted by the final-answer salvage path, and unparseable reviewer text defaulted to `REVISE`, so a review with no findings looked like a legitimate rejection. Empty output is now retried once and then failed explicitly. (INT-2879, #307)
- **`review --max --fix` is repository-aware and fails closed** — fixes are planned from repository dependency and runtime context instead of treating each area as independent, fix units run in isolated Git sandboxes with promotion-scope and conflict validation, and publication requires the final re-review to approve with deterministic verification reporting `passed`. Shared-path cloning, symlink containment, rollback, stale-base detection and verification time budgets are hardened, and repository-local review history is fed back so repeated audits stop rediscovering the same follow-ups. (INT-2920, #308, #309)
- **Codebase-wide hardening from the 2026-07-21 audit** — four sprints covering runtime safety (argv-safe process spawning, CLI/daemon lifecycle, PKCE settlement, network deadlines, serialized shared state), durable data (atomic and concurrency-safe persistence, realpath containment, GraphQL authorization and pagination), UX and verification boundaries (bounded streaming/caches/queues, prompt and terminal sanitization, planner output validation), and reliability under concurrency (cross-process locking, PID ownership verification, bounded stores and event history, process-tree termination). (#312, #313, #315)
- **File lock crash during hand-off** — `withFileLock` stat'd the lock file to age out malformed locks after the open already failed, so when the previous holder released it in between the caller crashed with `ENOENT` instead of acquiring the now-free lock. (#317)

### Security

- **ReDoS in GraphQL bearer token parsing** — the `Authorization` header was matched with `/^Bearer\s+(.+)$/i`, whose `\s+` and `(.+)` overlap; an attacker-supplied header of `Bearer` followed by many tabs backtracked polynomially before failing to match. Header parsing is now linear in header length. (CodeQL `js/polynomial-redos`, #313)

## 0.18.1 — 2026-07-21

### Fixed

- **A 429 is no longer read as a spent usage limit** — every HTTP adapter promoted any 429 to a rate limit, but providers also 429 for short-window throttling (concurrency, requests/min). `review --max` runs 4-16 subagents at once, and one area reporting a limit makes the audit skip every remaining area, so a routine throttle reported `Codex usage limit hit` and fell back to claude on an account with quota to spare. A 429 is now only a limit when the response proves it — a quota signature in the body, or `x-codex-primary-used-percent` at 100 — and a throttle is waited out and retried instead: `Retry-After` when the server sends one (capped at 120s), otherwise a 5s/15s/40s backoff with jitter so concurrent subagents don't retry in lockstep. The wait is abortable and the budget is per API call; a 429 that survives it fails that one call as an infra error rather than the whole run as a limit. Applies to codex-responses, gpt, openrouter, atlascloud and local — the last of which has no quota at all, so its 429 (busy queue, model still loading) used to pause the scheduler for nothing. A spent quota still fails fast exactly as before, and a 402 still needs a credit signature in the body to count. (INT-2907, INT-2909)

## 0.18.0 — 2026-07-21

### Changed

- **`review --max --fix` no longer edits your branch** — fix workers used to accumulate their edits in the caller's working tree, so an audit mixed itself into whatever a daemon worker (or you) was doing on that branch. The fix loop now forks the current HEAD into a dedicated worktree (`<repo>/worktree/audit-<ts>`, branch `swarm/audit-<ts>`), runs the audit, fixes and deterministic verification there, then commits and pushes the result as a PR against the branch it forked from (falling back to the default branch when that branch isn't on the remote). The PR references the Linear audit issue — `Closes` only the master issue this run created, `Refs` for an explicit `--issues <id>` parent — and the PR link is commented back onto that issue. A run that changes nothing discards the worktree instead of leaving an empty branch behind; a failed PR keeps it for manual recovery. Reports, repo knowledge and Linear project mapping still use the original repo path. `--in-place` restores the previous working-tree behavior. (INT-2905)

## 0.17.7 — 2026-07-16

### Added

- **Atlas Cloud provider adapter** — a new LLM adapter for Atlas Cloud, now featured as an official provider sponsor. (#297, #298)

### Fixed

- **`openswarm stop` actually stops a launchd-managed daemon** — when the daemon is externally managed (launchd, no PID file), stop used to only print a `launchctl bootout` hint and leave the daemon running. It now runs the bootout itself and waits for the port to close, falling back to the manual hint only if that fails. (INT-2798, #296)
- **Dashboard project disable survives a daemon restart** — a soft-disable only cleared the in-memory enabled set, so on restart reconcile re-enabled config-defined projects and a repo (e.g. a `config.yaml` project) revived and resumed work. Disable now records the project in the hard `removedConfigPaths` denylist in **both** tilde and absolute path forms — `config.yaml` loads `allowedProjects` raw (tilde) while the dashboard sends an absolute path — and enable/pin clear both. (INT-2799, #301, #302)
- **Failed-session partial work is committed before the worktree is preserved** — a preserved worktree kept its work uncommitted, so a manual directory cleanup lost it silently (a finished 700+ line implementation was nearly lost). It's now captured as a WIP commit on the swarm branch before the resume marker is written — surviving directory removal as a recoverable ref — without polluting history with the internal marker file. (INT-2729, #301)
- **Lance memory writes no longer collide under `review --max`** — up to 16 reviewer subagents (separate processes sharing one on-disk table) overran Lance's optimistic-concurrency retry budget with `Too many concurrent writers`. The dead per-search `lastAccessed` write was removed, and every remaining memory write (add/update/delete) now retries genuine commit conflicts with jittered exponential backoff. (INT-2817, #303, #304)

## 0.17.6 — 2026-07-13

### Fixed

- **Foreign project-local configs no longer hijack discovery or crash `review --max --fix`** — a repo's own `config.json` (any other app's settings) used to shadow `~/.config/openswarm/config.yaml` via the cwd search path and abort a max review right after the cost gate with `agents: expected array, received undefined`. Discovery now requires a top-level `agents` array before claiming a cwd `config.{yaml,yml,json}` (foreign or unparseable files are skipped with a notice), and the `review --max` verify-policy read falls back to built-in defaults with a warning instead of aborting. (INT-2762, #294)
- **`review --max --fix` completion is verified** — fix runs keep iterating until the re-review fully approves, and completion requires verified evidence instead of a first-pass approve. (#292, #293)
- **STUCK false-positive wave closed out (INT-2521)** — infra failures (adapter/CLI errors, git snapshot/diff failures, tester crashes, reviewer parse failures, worktree creation, ENOSPC full disk) are classified and retried as infrastructure instead of masquerading as quality rejects or fake passes; wall-clock timeouts now cover every stage, git op, and task; failed worktrees are preserved for resume with a 7-day sweep. (#256–#270, rolled up in #290)
- **Daemon/worktree correctness** — single-instance guard + atomic state-file writes (INT-2570), the repo's real remote/default branch is resolved instead of hardcoded `origin/main` (INT-2545), duplicate Linear-issue PRs are drafted with a warning (INT-2544), and fan-out winner promotion copies files instead of `git apply` (a 79% production failure rate). (#234)

### Added

- **`review --base <ref>` committed-diff mode** — review the commits ahead of a base ref instead of the working tree (for CI on checked-out PR branches), plus a CI review workflow scaffold. (INT-2552)
- **GPT-5.6 (sol/terra/luna) in the Codex OAuth model catalog.** (#274)
- **Provider parity** — consolidated usage-limit detection across providers (INT-2520) and cost/token/duration parity for loop adapters with planner model pinning. (INT-2508, INT-2509)

## 0.17.5 — 2026-07-05

### Added

- **Worker escalation on repeated review feedback** — when the reviewer repeats near-identical revise feedback (the 0.17.4 stagnation signal), the pipeline now escalates the worker once and retries in-session before giving up: `worker.escalateModel` when it differs from what the next iteration would run anyway, plus a reasoning-effort bump to `high` (active with zero config). Same feedback after escalation → early abort as before, with the feedback persisted for the next attempt. Escalation policy (iteration-count + signal) now lives in `workerEscalation.ts`. (INT-2475, #232)

## 0.17.4 — 2026-07-05

### Fixed

- **Reviewer-revise treadmill** — failing sessions could not converge: a task that failed at max iterations or was rejected was re-picked with zero memory of the reviewer's feedback (measured: 4 successes vs 51 max-iteration exhaustions in a recent window; issues re-picked up to 59×). Every failure/rejection now persists its last reviewer feedback (task-state `lastFailures`, cleared on success) and injects it into the worker's first iteration on re-attempt — on both the parallel and serial heartbeat paths. Two consecutive near-identical revise feedbacks also end the session early instead of burning the remaining iterations (the reflection stagnation brake only counted objective sources, so a repeating reviewer never tripped it). (INT-2474, #230)
- **Fan-out winner promotion died on dirty projects** — `git apply --3way ... does not match index`: `--3way` validates the patch preimage against the index (=HEAD), but on a self-repair retry only the worktree matches the seeded dirty state. Promotion now uses a plain worktree apply, and a promote failure falls back to the single in-place worker instead of failing the whole stage. (#230)

## 0.17.3 — 2026-07-05

### Fixed

- **Duplicate daemons are no longer spawned next to a launchd-managed instance** — daemon detection was PID-file-only, but a launchd (or manually started) daemon never writes the PID file, so every bare `openswarm` launch auto-started a second daemon working the same Linear queue in parallel (observed live: 8 duplicated in-flight tasks). `startDaemon` now probes the `:3847` API before spawning and refuses with a `launchctl` hint; `status` reports externally managed daemons as running; `stop` points at `launchctl` instead of a misleading "not running". (INT-2473, #228)
- **Adaptive worker fan-out actually executes now** — the fan-out gate's threshold-crossing signals fire almost exclusively on self-repair retries, but the runner hard-required a clean worktree, which a retry never has — so fan-out was recommended 53× and executed 0× in production. The runner now snapshots the dirty worktree state via a throwaway temp index, seeds it into each sandbox, and promotes only the incremental winner diff; execution/promotion/fallback are logged to stdout. (#227)
- **Worker validation-evidence gate false-positives** — chained commands with a leading inspection verb (`git diff && npm test`) counted as "no validation"; `.mts`/`.cts` sources slipped the gate; data-only trees (locale/fixtures/snapshots) were over-blocked while real source modules under mock/fixture dirs bypassed it; and a tester-less pipeline hard-failed workers that could not self-report commands instead of deferring to the reviewer. (#227)

### Added

- **Per-project concurrency cap** — optional `autonomous.maxConcurrentPerProject` (1–10) bounds same-project worktree fan-out at both the scheduler and runner candidate-selection layers; unset means uncapped (KG file-conflict detection still gates overlapping tasks). (#227)

## 0.17.2 — 2026-07-02

### Fixed

- **Review fix workers no longer die at the 5-minute default** — `review --max --fix` now gives each area worker a 15-minute timeout, and timeout failures are classified as infrastructure errors instead of being mislabeled as auth/permission problems. Direct API adapters now preserve the shared `timeoutMs: 0` contract as "no deadline". (INT-2350)
- **Heartbeat Live Log skip spam is collapsed** — unmapped/disabled Linear project skips are aggregated per project and repeated identical summaries stay silent across heartbeats. (INT-2350)
- **OAuth browser launch is safer and shared** — Linear, GPT, and OpenRouter PKCE flows now use one `spawn`-based browser opener instead of shell-quoting URLs into per-provider `exec` helpers.
- **Auth, MCP, memory, and registry APIs fail more cleanly** — auth profile files are shape-validated before use, unknown OAuth providers fail explicitly, MCP registry/tool schemas are sanitized, memory metadata parsing is tolerant, vector search pushes filters into LanceDB, and registry GraphQL list/search resolvers avoid broad in-memory filtering.
- **Web/TUI runtime hardening** — mutating GraphQL and local filesystem reads now honor origin/token checks, the web server clears its git-status poller on stop, monitor fetches are abortable with timeouts, SSE reconnects reject invalid streams and cap partial buffers, and resumed chat goals/model selectors avoid stale async state updates.
- **Task-state and multibyte input regressions restored** — Linear sync comments without author metadata still hydrate canonical state when the OpenSwarm marker/prefix match, and the TUI again deduplicates doubled multibyte keystroke events.

## 0.17.1 — 2026-07-02

### Fixed

- **Worktree PRs are actually created now** — the `gh` helper in `worktreeManager` ran with the daemon's own cwd (typically not a git repository, e.g. `$HOME`), so every `gh pr list` / `gh pr create` after a completed task died with `fatal: not a git repository` while the branch push succeeded — completed work stranded on remote branches with no PR (80 recorded failures; the only successes were when the daemon's cwd happened to be the target repo). `gh` now runs inside the task's worktree, mirroring the `git` helper. (INT-2327, #202)

## 0.17.0 — 2026-07-02

### Added

- **Same-project parallel agents** — the daemon can now run multiple agents on one project concurrently. The DecisionEngine's hard "one task per project per cycle" rule (whose justifying comment was stale) is replaced by **round-robin selection**: every pass adds at most one task per project, so no project monopolizes the slots, and later passes fill the remaining slots from the same projects. Active only when the scheduler can actually isolate the runs (`allowSameProjectConcurrent` + `worktreeMode`); file-overlapping tasks within a project are still deferred by the knowledge-graph conflict detection — which this change finally exercises (it was dead code). Verified live: 4 tasks from one project running in parallel worktrees. (INT-2318)

### Changed

- **Per-project 5h task cap removed** — the rolling-window cap (`dailyTaskCap`, default 6) silently stalled a project after a productive burst (throttled with an idle scheduler and no error). Like the previously-removed global pace gate, throughput is now governed only by the cron schedule and the Linear rate limiter. Completion records (`daily-pace.json`) are kept as cost/throughput telemetry. The `dailyTaskCap` config field is gone; stale keys in existing configs are ignored. (INT-2317)

### Fixed

- **Vendored dirs no longer poison conflict detection** — with same-project parallelism live, the KG conflict detector deferred 4/5 tasks as "conflicting" via vendored `google-cloud-sdk/` files (`a.py`, `run.py`, `api.py` substring-matched every issue text). The scanner now skips vendored trees (`google-cloud-sdk`, `third_party`, `vendor(s)`), and issue-impact filename matching requires a whole-word boundary and ≥3 chars. A poisoned cached graph shrank 14MB → 52KB on rescan. (INT-2320)
- **Project cancellation path normalization** — `~` expansion and relative-path resolution before the exact-or-descendant match, plus a fix for a latent traversal bypass (`/dev/WAVE/../WAVE-next` was cancelled by disabling `/dev/WAVE`). Thanks to [@ag-linden](https://github.com/ag-linden). (#192) An empty/blank cancellation path now cancels nothing instead of resolving to the daemon's cwd. (#197)

## 0.16.0 — 2026-07-02

### Security

- **taskState store hardened** — prototype-pollution-safe task map (null-prototype via schema preprocess), fail-closed on a corrupt persisted state file (no silent overwrite), Linear sync-comment **trust filter** (marker/prefix + author allowlist, `OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS` for extras) with an issueId mismatch guard against cross-issue poisoning. (INT-2316)
- **Telemetry privacy tightened** — `command`/`adapter`/`event` labels are sanitized to a strict token shape so dynamic strings can never leak paths or prompt text; `installId` is shape-validated; the send timeout is unref'd so fire-and-forget telemetry cannot keep the process alive. (INT-2316)
- **Web dashboard auth: linear-time bearer parse** — replaced a polynomially-backtracking `Bearer` header regex (CodeQL `js/polynomial-redos`) with a regex-free parse. (INT-2316)
- **BS detector catches env-fallback secrets** — `process.env.X || "hardcoded-secret"` is now flagged (any line mentioning `process.env` used to be excluded wholesale). (INT-2316)

### Changed

- **Audit hardening batch landed** — two full-codebase `openswarm review --max --fix` passes (~130 files) applied per-area fixes: R5 Linear reconcile extended to done→reopened transitions, fix-loop worker errors surfaced (all-failed round stops early), `readOnly` adapter option plumbed through the tool layer, locale key coverage, GraphQL resolver and memory-ops cleanups — plus **13 new test files** (suite 1326 → 1389). (INT-2316)

## 0.15.0 — 2026-07-02

### Added

- **`openswarm fix` is now multi-language** — check resolution auto-detects the project's ecosystem instead of requiring `package.json` scripts. First non-empty source wins: an explicit `"checks"` map in `openswarm.json` (key → shell command — the escape hatch for **any** language and for mixed repos), `package.json` scripts, `Cargo.toml` (**Rust**: `cargo check --all-targets` + `cargo test` by default; `clippy`/`build` via `--checks lint,build`), or **Python** markers (`ruff check .` / `mypy .` / `pytest`, each included only when the repo is configured for the tool; `--checks` bypasses the gating). Previously Rust/Python projects always exited with `No checks resolved`. (INT-2303)

## 0.14.0 — 2026-07-01

### Added

- **Auto-release on version bump** — a push to `main` that changes `package.json` now runs the gate (lint / typecheck / build) and automatically **publishes to npm + tags + creates a GitHub release** (notes sliced from this file). The release flow is just "merge a version-bump PR". Idempotent. Requires a repo secret `NPM_TOKEN`. (INT-2270)
- **CLI update notifier** — when the running version is behind npm's latest, the CLI prints a two-line "update available" notice. 24h cached (`~/.openswarm/update-check.json`) so it's near-instant and non-blocking; skips non-TTY / CI / `--version` / `NO_UPDATE_NOTIFIER`. (INT-2270)

### Changed

- **`checkHandler` colors unified** onto the shared NO_COLOR/TTY-safe helper (`src/support/colors`), finishing the CLI/TUI status-consistency work — ~108 hand-rolled ANSI sites now go through `c` / `status`. Output is byte-identical when piped. (INT-2260)
- **CI `test` job promoted to a hard gate** (the suite is green), and lint is now warning-free (36 → 0).

### Fixed

- **Stale `service.test.ts` provider-override tests** — the reapply lives inside the autonomous-start block; the tests drove it with a non-autonomous config. Fixed → the full suite is green (1315 passing). (INT-2271)
- **`postbuild` `chmod +x dist/cli.js`** — a clean `rm -rf dist && build` no longer leaves the global CLI unexecutable ("permission denied").

## 0.13.0 — 2026-07-01

### Added

- **CLI agent runs now grow repo knowledge** — `openswarm run`, `openswarm fix`, and `openswarm review --max` record into the per-repo knowledge memory (previously only the autonomous daemon did). A standalone run makes the codebase memory grow and gets recalled into the next worker/reviewer prompt: `run` records the task outcome (success pattern / review-rejection pitfall), `fix` records what made the checks pass, and `review --max` records the verdict + top follow-ups as **one capped constraint** (≤10, so hundreds of findings can't flood the memory). Default on; `--no-learn` opts out per command for throwaway/exploratory runs. (INT-2268)

## 0.12.0 — 2026-07-01

### Added

- **`openswarm fix`** — bring `review --max`'s fan-out to the objective checks. Runs the project's checks (lint / typecheck / build / test, resolved from `package.json` scripts; `--checks` to select a subset), groups the failures by file into areas, fans a **fix-worker out over each area**, then **re-runs the checks and repeats until green** (or the `--rounds` budget; default 3). Edits land in the working tree — you review the diff. Unlike `review --max --fix` (an LLM opinion, no re-verify), the checks are deterministic so the loop verifies its own work and converges; it stops on no-progress (same failures + no edits) and exits non-zero while red. `--concurrency <n>`, `--adapter <name>`. (INT-2267)

## 0.11.0 — 2026-07-01

Wider, faster codebase audits — plus the audit can now fix what it finds.

### Added

- **`review --max --fix`** — after the audit, a worker subagent is fanned out per flagged (revise/reject) area and applies that area's reviewer findings to its files. Edits land in the **working tree only** — no commit, no re-review — so you review the diff before committing. Uses the same `--concurrency` as the review. (INT-2249)
- **Concurrency-saturating area distribution** — `review --max` previously ran one reviewer per directory, so a 2-directory repo used only 2 subagents even at `--concurrency 8`. Areas now auto-split until the fan-out fills the pool (floored at one file per area), and it stays a no-op when the directory partition already saturates it. Faster wall-clock on wide audits. (INT-2249)

### Changed

- **Unified CLI/TUI status design** — glyphs (`◐ ✓ ✗ ⚠ ✎`) and the braille spinner are now single-sourced (`src/support/glyphs.ts`), consumed by both the Ink TUI (`<StatusIcon>` / `<Spinner>` + `theme.STATUS`) and plain console output (`status` in `src/support/colors.ts`). Consequences: the **worker now shows the same animated spinner heartbeat as the reviewer** (it was a static line), the `review --max` verdict and `--fix` output are colored consistently (and stay ANSI-free when piped / under `NO_COLOR`), and drifting glyphs (`▶`→`◐`, `●`→`✓`) and duplicate spinner frame sets are collapsed. (INT-2260)
- **Multi-lens reviewer removed** — the opt-in multi-lens reviewer fan-out (PoC, shipped dormant in 0.10.0) is gone. A synthetic planted-defect A/B showed **zero detection uplift** over the single reviewer and **complete lens overlap** (every lens named every defect), so the 3× cost bought nothing. The reproducible A/B harness lives in `benchmarks/reviewLensAB.ts`. (INT-2230)

### Fixed

- **Project cancellation no longer aborts sibling paths** — disabling a project (e.g. `/dev/WAVE`) used a raw string prefix, so it could abort an unrelated running task under a sibling path like `/dev/WAVE-next`. Cancellation now matches the exact project path or a real descendant (worktree) path only, with path normalization. Thanks to [@ag-linden](https://github.com/ag-linden) for the fix. (#182)

## 0.10.2 — 2026-07-01

### Fixed

- **`review --max` is now language-agnostic** — Rust/Go/JVM/C/… repos hit `No production source files to audit` because `SOURCE_EXTENSIONS` only knew JS/TS/Python. Now covers Rust, Go, JVM (Java/Kotlin/Scala/Groovy), C/C++/C#, Ruby, PHP, Swift, Obj-C, Elixir, Clojure, OCaml, Haskell, Dart, Lua, Julia, Zig, Nim — with language-specific test-file exclusions (`_test.go`, `*Test.java`, `*_spec.rb`, …) and build dirs (`target/`, `__pycache__`, `bin`, `obj`). The reviewer is an LLM, so the audit is genuinely language-neutral now. (INT-2240)

## 0.10.1 — 2026-07-01

### Fixed

- **PM synthesis JSON parsing** — `review --max`'s PM agent failed to parse codex-responses' **escaped JSON** output (literal `\n` / `\"`), so synthesis produced no grouped issues and only the master issue remained. `parseSynthesisOutput` now decodes an escaped JSON block before parsing. (INT-2239)
- **Orphan audit issue** — when a repo has no `openswarm.json` `linear.projectId` mapping, `review --max` now warns instead of silently filing the master issue without a project (and, on a multi-team config, on the wrong team). Run `openswarm add` in the repo to map it. (INT-2239)

## 0.10.0 — 2026-06-30

Full-codebase review pipeline (multi-agent audit → report → PM triage → Linear), chat session persistence, and a batch of daemon / TUI / adapter fixes.

### Added

- **`openswarm review --max`** — full-codebase audit that fans reviewer subagents out over directory-shaped areas, with **area isolation + dedup** so a shared file isn't flagged by every area. Persists a markdown report to `.openswarm/audit/audit-<ts>.md` and files a Linear master issue by default (`--out`, `--no-linear`). (INT-2006, INT-2022)
- **PM agent issue synthesis (default)** — `review --max` files Linear issues by default as **at most 10 cohesive issues** (a master parent + synthesized sub-issues), grouped by an LLM PM by theme/root-cause instead of one-per-follow-up. `--no-linear` skips Linear (report only); `--issues-per-area` keeps the legacy per-area filing; `--issues <id>` sets an existing parent. (INT-2225)
- **Codex usage-limit handling + claude fallback** — typed `RateLimitError` from the rich `x-codex-*` 429 headers (used %, reset time), early-abort instead of hammering a dead quota, and **automatic fallback to the `claude` adapter** (Claude subscription) for the remaining areas (`--fallback`, `--no-fallback`). (INT-2192)
- **Chat session persistence + `openswarm resume`** — conversations persist to `~/.openswarm/chat`; `resume` reopens the latest with its goal. `/goal clear` is the only way to stop an in-flight goal. (INT-2014)
- **Execution cwd context** — chat / `/plan` / `/goal` operate in the repo `openswarm` was launched from. (INT-2005)
- **Project selection persistence** — the daemon's enabled-project selection survives restarts. (INT-2208)
- **Planner rich-markdown sub-tasks** — each sub-task description is a full markdown doc (Background / Investigation / Approach / Completion) so the worker starts with context. (INT-1581)
- **`edit_file` fuzzy fallback** — line-normalized matching (whitespace / quotes / unicode) when exact match fails, plus edit prompt guidelines. (INT-2011)

### Fixed

- **Daemon kept running after every project was disabled** — an empty enabled-set was treated as "run all"; now an explicit "disable all" actually stops the daemon (and persists across restarts). (INT-2207, INT-2208)
- **Multi-team config `createIssue`** — passed the comma-joined teamId string to Linear ("teamId must be a UUID"); now resolves a single team (the project's, else the first). (INT-2210)
- **Ink TUI color consistency** — hardcoded color literals + uncolored status text routed through the theme scheme; new `running` / `info` tokens. (INT-2209)
- **Hangul input doubling** — multi-grapheme / N-repeat cases collapsed. (INT-2012)
- **Adapter CLI infra errors no longer counted as STUCK** — codex CLI / usage-limit errors are infra, not task failures. (INT-2010)
- **Linear project overview summary doubling** — strip the prior compact summary before re-appending. (INT-1907)
- **Cancel syncs task-state to Backlog.** (#162)

> Note: 0.8.x–0.9.x were tagged without changelog entries; see git history for those.

## 0.7.0 — 2026-06-19

Runs with **no external SaaS** from a clean install, plus a native ChatGPT-OAuth Codex path.

### Added

- **First-run onboarding wizard (`openswarm init`)** — interactive 3-step setup: AI provider (with inline `auth login`, skipped if already authenticated), task backend (local SQLite or Linear paste-key), and an optional notification channel (Discord/Slack/Telegram/webhook, BYO). Writes `.env` (secrets, `chmod 600`) + `config.yaml` and validates. `--yes`/`--non-interactive` keeps the config-only path for CI. New `promptHelper` (line-event-queue prompts, robust for piped stdin + TTY) and `envFile.writeEnvVars` (upsert, 0600). (INT-1578)
- **Notifier abstraction** — outbound notifications are decoupled from Discord: `Discord` / `Slack` / `Telegram` / generic `Webhook` / `Noop`, selected by a `notifications` config block and injected via `setNotifier`. `EmbedBuilder` falls back to text/markdown for non-Discord channels. (INT-1576)
- **Linear-optional task source (`ITaskSource`)** — the autonomous runner + `/plan` cockpit route through `ITaskSource`. With no `LINEAR_API_KEY`, `selectTaskSource` falls back to the existing local SQLite issue store (`~/.openswarm/issues.db`) and drives the runner end-to-end — no external account. `LinearTaskSource` preserves today's behavior exactly (thin delegation). (INT-1577)
- **Codex model discovery (`openswarm auth models`)** — discovers the Codex models an account can actually use via the OAuth backend (`chatgpt.com/backend-api/codex/models`), with `~/.codex` config/cache and a curated offline fallback; ported from the hermes `codex_models` pattern. `CodexCliAdapter.listModels()`. (INT-1585)
- **Native Codex Responses adapter (`codex-responses`)** — calls `chatgpt.com/backend-api/codex/responses` (Responses API) via ChatGPT OAuth on OpenSwarm's **own** agentic loop, instead of delegating to the external `codex exec` CLI. Tools/verification stay under OpenSwarm's control, and per-role model tiering (worker/reviewer/planner = big/medium/small) works on a single OAuth. Live-verified (`/responses` 200 + tool-calling e2e). (INT-1586)

### Fixed

- **OAuth `account_id` extraction** — stored `id_token.sub` (an IdP subject, e.g. `google-oauth2|…`) instead of `chatgpt_account_id` from the access_token's `https://api.openai.com/auth` claim, so the Codex backend would 401. Existing profiles need a one-time `openswarm auth login --provider gpt` re-login. (INT-1586)
- **`pairMode.webhookUrl` validation** — was a strict `z.string().url()`, so an unset `${PAIR_WEBHOOK_URL:-}` (empty string) made `openswarm validate` fail on every generated config (broken since 0.6.0). Now allows an empty string, matching the other optional `webhookUrl` fields. (INT-1578)

## 0.6.0 — 2026-06-18

### Added

- **TUI Planner Cockpit (`/plan <goal>`)** — the TUI is no longer just chat + a read-only monitor. `/plan` runs the Planner to preview a decomposition, gates on human approval (`y` / `n` / `edit` to drop sub-tasks), then dispatches into the daemon loop; progress shows in the Tasks tab. Available in both the blessed TUI (`chat`) and the readline chat. (INT-1572)
- `POST /api/plan/dispatch` — dual-path dispatch: with Linear configured it creates a parent issue + dependency-wired sub-issues and triggers a heartbeat (reusing the autonomous decomposition engine); otherwise it falls back to running each sub-task through the exec pipeline.
- **Web tools in the agentic loop** — `web_fetch` (keyless: URL → readable text) and `web_search` (pluggable backend: Tavily/Brave when `TAVILY_KEY`/`BRAVE_SEARCH_KEY` is set, else a keyless DuckDuckGo fallback) are now exposed to every adapter (openrouter/gpt/local), restoring the web capability the `claude -p` harness used to provide. Enabled by default (`webTools` option); disabled for the SWE-bench harness to keep the benchmark honest. (INT-1573)

### Changed

- **Planner migrated off `claude -p`** — `runPlanner` now runs through the OpenSwarm agentic loop via the configured adapter (read-only, multi-turn) instead of shelling out to `claude -p --max-turns 1`. Completes the INT-1420 `claude -p` removal, drops the claude-binary dependency, and lets the planner read the codebase before decomposing. `PlannerResult` contract unchanged.
- Extracted `createSubIssuesWithDependencies()` from the autonomous runner so the `/plan` endpoint and `decomposeTask` share one sub-issue/dependency engine (no logic fork).
- Extracted `startExecTask()` in the web server so `POST /api/exec` and the `/plan` fallback share one exec-task lifecycle.

## 0.5.0 — 2026-06-11

### Added

- **OpenRouter adapter** — runs OpenSwarm's native agentic tool loop against any OpenRouter model, with OAuth PKCE (or `OPENROUTER_API` key), ZDR (`data_collection: deny`) for non-OpenAI models, automatic Anthropic prompt caching, and optional reasoning-off for mechanical roles. (#63)
- **LM Studio adapter** — dedicated OpenAI-compatible endpoint support with auto model selection (`LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`). (#60)
- **Repo knowledge loop** — workers learn each repository over time: task outcomes are stored as per-repo memories (success → `system_pattern`, review rejection → `constraint` pitfall) and recalled by relevance into the next worker prompt as a "Repository Knowledge" section. (#63)
- **L0–L6 benchmark suite** (`benchmarks/`) — synthetic L0–L5 tasks with deterministic grading plus L6 = real SWE-bench Lite instances solved by the OpenSwarm harness and graded by the official swebench harness. Includes a hybrid mode (frontier read-only diagnosis + lightweight implementer) that resolved 3/3 attempted instances; see `benchmarks/RUBRIC.md`. (#63)
- Agentic-loop guards, all motivated by SWE-bench findings: final-answer turn on turn exhaustion, no-edit guard (`nudgeMaxOnNoEdit`, counts only successful edits), verification-harness file protection (`protectedFiles`), and configurable bash timeout (`bashTimeoutMs`) with an explicit TIMEOUT message. (#63)

### Changed

- Worker success is now judged primarily by git diff instead of requiring a structured JSON block from the model.
- Default model routing is benchmark-driven: lightweight worker (`z-ai/glm-4.7-flash`) with frontier escalation; frontier planner/reviewer.
- Compaction thresholds raised for modern context windows (24k→60k tokens, keep 16 recent messages) — fixes an infinite re-read loop on long agentic runs.
- `loadConfig` now disables Discord/Linear integration when credentials are missing (standalone mode) instead of rejecting the config.
- Repo memory keys are normalized via realpath so symlinked/trailing-slash paths share one knowledge store.

### Fixed

- Working directory is injected into agentic prompts — models no longer guess absolute paths and get every file tool call rejected.
- bash tool failures now return stdout/stderr + exit code (grep "no match" was previously treated as a fatal error, causing infinite retries).
- `edit_file` result snippets now locate the edit via the unique `old_string` position (previously could show the wrong region).
- gpt/local adapters now forward the new guard options to the agentic loop.

## 0.4.4 — 2026-05-07

### Security

- Re-publish of 0.4.3 to ensure the `protobufjs` `^7.5.5` override (CVE-2026-41242 / GHSA-xq3m-2v4x-88gg, critical RCE, CVSS 9.8) is actually present in the npm tarball. The override was merged into `main` for 0.4.3 but was not included in the package that reached npm. No code changes beyond the version bump; the override entry already lives in `package.json`.

## 0.4.3 — 2026-05-07

### Fixed

- Fixed `ReferenceError: require is not defined` crash in `expandPath` that broke every `openswarm exec`/`run --path <absolute-path>` invocation. The package is ESM (`"type": "module"`) but `src/core/config.ts` lazily called CommonJS `require('node:path')` to import `resolve`. Hoisted `resolve` into the top-level `node:path` import. (#52, reported by @shuklatushar226)
- Fixed the same ESM-incompatible lazy `require('node:fs')` pattern in `src/automation/runnerState.ts` (`mkdirSync`), which would have crashed on the first daily-pace directory creation.

### Security

- Forced `protobufjs` to `^7.5.5` via `package.json` `overrides` to mitigate CVE-2026-41242 / GHSA-xq3m-2v4x-88gg (critical RCE via crafted protobuf descriptors). The vulnerable copy was pulled in transitively through `@xenova/transformers` → `onnxruntime-web` → `onnx-proto`. OpenSwarm itself loads only trusted HuggingFace models, but the override removes the dependency-tree exposure entirely.

## 0.4.2 — 2026-04-25 (addendum — shipped in 0.4.2 but previously unrecorded)

### Added

- Added a canonical OpenSwarm task-state store for hierarchy, dependencies, worktree ownership, and execution status.
- Added a Python/Pydantic mirror model for the canonical task-state schema.
- Added structured Linear state-sync comments for machine-readable issue snapshots.
- Added task-state rehydration from the latest Linear sync comment during autonomous fetch.

### Changed

- Planner decomposition now resolves child-task dependencies into canonical state instead of leaving them as description-only text.
- Dependent child issues are no longer all promoted immediately; only dependency-free children start runnable.
- Decomposed parent issues now stay active until all child issues complete, then close automatically.
