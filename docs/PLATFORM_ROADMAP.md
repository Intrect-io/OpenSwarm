# OpenSwarm Platform Roadmap

**Status**: accepted (2026-08-19) · **Epic**: [INT-3764](https://linear.app/intrect/issue/INT-3764)

This document records a repositioning decision and the architecture that follows from it.
It is the reference for what OpenSwarm is becoming and — just as importantly — what it has
decided not to become.

## 1. The decision

OpenSwarm moves from **"autonomous AI agent orchestrator"** to an **agentic developer
platform**: a system that, without a human at the keyboard, periodically inspects the
codebases you register — code review, SAST, hygiene checks — and routes what it finds to
reports, your issue tracker, and your pull requests.

The autonomous issue-pickup daemon is not demoted. Inspection and pickup are the two pillars,
and they compose: an inspection finding becomes a tracker issue, the daemon picks it up, and
the worker/reviewer pair closes it with a verified fix.

### Why now

Most of the machinery already exists. What was missing is a product identity and an
unattended execution path.

- The review lineage is the most hardened path in the codebase: area fan-out
  (`src/cli/reviewAudit.ts`), cross-run finding dedupe (`src/cli/reviewHistory.ts`), a
  documented exit-code contract (`src/cli/reviewExit.ts`), JSON and SARIF output
  (`src/cli/reviewOutput.ts`), GitHub Action packaging (`action.yml`), and a fix→verify loop
  (`runFixVerifyLoop`).
- A prior pivot in the same direction (epic INT-3099) shipped completely: fail-closed quota
  gating, headless token auth plus a GitHub Action, machine-readable output, and bubblewrap
  handling on Linux CI.
- CodeQL/Ruff SAST (`src/verify/securityAudit.ts`) and a whole-codebase deterministic quality
  harness (`src/verify/qualityHarness.ts`) are written.
- A zero-LLM deterministic path already exists behind
  `openswarm review --max --harness-only`.

## 2. Measured gaps

Findings from a survey of the repository on 2026-08-19.

| ID | Gap | Evidence |
|----|-----|----------|
| G1 | The inspection engine is not in git | `qualityHarness.ts` exists on no branch (dirty working tree only); `securityAudit.ts` only on the open PR #406 branch |
| G2 | No unattended periodic inspection | Nothing in the repository schedules `review`, `review --max`, `check --scan`, or the quality harness. The only automated review triggers are the PR processor cron and a manual-dispatch workflow |
| G3 | The scheduler does not run OpenSwarm | `src/automation/scheduler.ts` spawns `claude -p <prompt> --permission-mode bypassPermissions --max-turns 15`. It bypasses the adapter and verify layers entirely, requires the `claude` CLI, and grants unattended jobs full write permission |
| G4 | The scheduler has zero real usage | No `~/.openswarm/schedules.json` exists — not one job registered |
| G5 | No editor integration | No VSCode extension. LSP integration was rejected on measured evidence (`src/adapters/diagnosticsTool.ts`, N=48, no uplift) |
| G6 | Three UI generations ship simultaneously | Legacy dashboard, cockpit SPA, and issue board are all served; both `openswarm dash` and the Tauri shell land on the legacy dashboard |

## 3. Architecture decisions

### AD-1 — `openswarm inspect` is the first-class unattended command

`review --max --harness-only` already performs the deterministic inspection. What is new is
the orchestration around it: profiles, multiple repositories, baselines, and routing.

```
openswarm inspect [--repo <path>...] [--profile hygiene|security|review|full]
                  [--out <md>] [--json] [--sarif <file>]
                  [--file-issues] [--new-only]
```

| Profile | Composed from | LLM cost |
|---------|---------------|----------|
| `hygiene` | tracked-source static scan, BS detector, code registry scan, configured verify commands | none |
| `security` | CodeQL + Ruff via `runSecurityAudit` | none |
| `review` | agent area fan-out via `runMaxReview` | paid |
| `full` | all of the above | paid |

**The load-bearing argument**: most of the value of periodic unattended inspection comes from
the profiles that cost nothing per run. That sidesteps quota exhaustion, spend, and
fail-closed complexity, which is what makes nightly inspection across many repositories
practical at all. Agent review stays an opt-in escalation.

### AD-2 — Baselines, so periodic scanning does not become spam

The dominant failure mode of scheduled scanning is reporting the same eight hundred findings
every night. The rule is: **every finding goes in the report, only new findings get routed.**

A per-repository baseline (`.openswarm/inspect-baseline.json`) stores finding fingerprints.
The first run establishes the baseline and routes nothing. Fingerprinting reuses
`securityFindingFingerprint` / `newSecurityFindings`; writes are serialised with the existing
`withFileLock` helper. A corrupt baseline fails closed rather than silently reporting "zero
new findings".

### AD-3 — Isolated worktree snapshots, never the user's tree

Inspection iterates the repositories already registered in the daemon's own registry, skips
any repository whose `HEAD` has not moved since the last run, and works inside a
`git worktree add --detach` snapshot — the pattern the PR processor's fresh review already
uses. It never mutates a working tree, and `git stash` round-trips are prohibited.

### AD-4 — Routing goes through `ITaskSource`, never Linear directly

Findings are filed through the `ITaskSource` interface so that users on the built-in SQLite
tracker get the same behaviour as Linear users. Issue synthesis reuses the existing audit PM
path: one master issue plus a bounded set of sub-issues.

This is what closes the loop: **inspect → tracker issue → daemon pickup → worker/reviewer →
fix→verify → pull request.**

### AD-5 — Typed scheduled jobs

`ScheduledJob` becomes a discriminated union. The legacy free-text `prompt` job is preserved;
a new `inspect` job runs in-process, read-only, with no child process and no permission
bypass. The security characteristics of the legacy job are documented and surfaced by
`openswarm doctor`.

The daemon's own periodic inspection is wired as a cron in `src/core/service.ts` alongside the
PR processor and daily reporter — not through the user-facing scheduler.

### AD-6 — The VSCode extension is a diagnostics client, not a language server

LSP integration was measured and rejected: an A/B run at N=48 showed no uplift, and the
diagnostics tool that replaced it remains opt-in with no production caller. The extension is a
client of the daemon's existing read APIs — SARIF mapped into the VSCode `Diagnostic` API, a
findings tree, a status bar fed by the health and quota endpoints, and dispatch of a fix back
into the work API.

## 4. Milestones

| Milestone | Content | Issues |
|-----------|---------|--------|
| **M0** | Land the inspection engine in git; triage the dirty working tree | INT-3765, INT-3766 |
| **M1** | `openswarm inspect`: profiles, baselines, multi-repo isolation | INT-3767, INT-3768, INT-3769 |
| **M2** | Unattended execution: typed jobs, daemon cron, tracker routing | INT-3770, INT-3771, INT-3772 |
| **M3** | CI and PR surfaces: a zero-LLM Action mode, merged PR reporting | INT-3773, INT-3774 |
| **M4** | Positioning: README, package metadata, this document | INT-3776, INT-3777 |
| **M5** | VSCode extension (deferred) | INT-3778, INT-3779, INT-3780 |

M0 blocks everything else: the modules M1–M3 build on are not yet versioned.

## 5. UI policy: frozen, not removed

Three web generations and a desktop shell ship today. The policy is **freeze**: they keep
working and are not deleted, but they receive no new features. The daemon's read API layer is
explicitly excluded from the freeze — it is the backend the VSCode extension will reuse, so it
continues to be maintained and extended.

| Surface | Size | Disposition |
|---------|------|-------------|
| Legacy dashboard (`src/support/dashboardHtml.ts`) | ~2.3k lines | Frozen; still the default landing page for `openswarm dash` and the desktop shell |
| Cockpit SPA (`web/static/`) | ~2.8k lines | Frozen |
| Issue board (`src/issues/issueBoardHtml.ts`) | ~0.7k lines | Frozen |
| Tauri desktop shell (`desktop/`) | ~1.8k lines of Rust | Frozen prototype |
| Daemon read APIs | — | **Maintained** — extension backend |

One open question is tracked in INT-3777: whether the desktop shell's default entry path
should flip from the legacy dashboard to the cockpit SPA.

## 6. Non-goals

- **LSP integration.** Rejected on measured evidence (N=48, no uplift). The VSCode extension
  consumes SARIF; it does not become a language server.
- **Removing the web or desktop UI.** Frozen, not deleted.
- **Demoting the autonomous daemon.** It remains a first-class pillar.
- **Notification-channel digests** of inspection results. Out of scope for this epic; reports,
  tracker issues, and PR comments are the routing targets.
