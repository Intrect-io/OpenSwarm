# Product

<!-- impeccable:product-schema 1 -->

Scope: the OpenSwarm web dashboard (served by the daemon on port 3847 and by
`openswarm dash`, and wrapped by the Tauri desktop shell in `desktop/`). The CLI,
TUI and GitHub Action are separate surfaces and are not governed by this file.

## Platform

web

## Users

- **The operator (primary).** One developer who owns the daemon and the repositories it
  works on. They declare intent (Linear or local-tracker issues), merge PRs, and otherwise
  want to stay out of the loop. At a desk they use the dashboard on a large screen beside
  their editor; away from the desk they check it from a phone over Tailscale (≈390 px wide),
  usually to answer one question: "is the swarm OK, and does anything need me?"
- **The first-time OSS installer (secondary).** Someone who just ran
  `npm install -g @intrect/openswarm`, `openswarm init`, and opened the dashboard. They do not
  yet know the vocabulary (adapters, pair pipeline, exchanges, worktrees) and must not be
  stopped by it on the first run.

## Product Purpose

OpenSwarm runs autonomous coding agents: a daemon pulls issues from Linear or a local SQLite
tracker, runs Worker → Reviewer → Tester → Documenter pipelines in isolated git worktrees
through pluggable LLM adapters, verifies deterministically in an OS sandbox, and opens PRs.

The north star is **zero human touch**: agents should finish work without the operator.
The dashboard therefore is **an exception console, not a cockpit to fly by hand**. Its job is
to make three things impossible to miss and quick to act on:

1. whether the swarm is healthy (daemon, link, provider, cost);
2. what needs the operator (parked questions, failed or stuck work);
3. what the agents are doing right now, with enough evidence to trust or stop them.

Success is measured in fewer, shorter operator touches per shipped PR, not in time spent on
the dashboard.

## Positioning

Many concurrent agents, each in its own worktree, routed across cheap and frontier models by
cost, coordinating through a shared board (questions, advice, delegation) and gated by
deterministic verification. The dashboard is the one place that shows that whole floor at
once: who is working on what, who is waiting on whom, what it cost, and where a human is the
bottleneck.

## Operating Context

- Daemon runs on the operator's Mac (`openswarm start`) and on a Linux host (`vela`, Docker);
  the dashboard is reached at `http://<host>:3847` locally or over Tailscale, with a web token
  for non-local peers.
- `openswarm dash` serves the same pages with no runner attached (read-mostly; actions that
  need the runner refuse with a reason).
- The Tauri desktop shell (`desktop/`) wraps these pages; there is no `window.confirm`
  there, so destructive actions confirm in-page.
- Surfaces today: Supervisor `/` (legacy server-rendered `src/support/dashboardHtml.ts`),
  Cockpit `/app`, Chat `/chat`, Orchestration `/orchestration`, Threads `/threads`,
  Warehouse `/warehouse`, Usage `/usage`, and the local issue board `/issues`
  (`src/issues/issueBoardHtml.ts`). All are Operate-mode surfaces.
- Live data arrives over SSE (`/api/events`) with REST snapshots as the backstop.

## Capabilities and Constraints

- Plain static HTML + ES modules under `web/static/` (no framework, no bundler); the build
  copies them to `dist/web-static`. The running daemon serves the repository's `dist/`.
- One token file (`web/static/css/tokens.css`) holds every colour literal on the web surface;
  `tokens.test.ts` fails the build on a stray hex anywhere else.
- Dark is the default theme; light is a value swap. Both must stay first-class.
- State-changing controls (stop/restart, provider, thinking effort, deploy, restart stuck
  work) are fleet-wide or destructive and confirm in two presses, in place.
- Observability is read-only by default (docs/PLATFORM_ROADMAP.md §5).
- UI language: **English** on every page (decided 2026-10-19). Agent-authored content may be
  in any language and is shown as written.
- Terminology the UI must explain rather than assume: adapter/provider, worker/reviewer pair,
  heartbeat, exchange, parked question, worktree, warehouse.

## Brand Commitments

- Name: **OpenSwarm** (package `@intrect/openswarm`). The current mark is the 🐝 emoji;
  there is no binding logo asset yet.
- Agent roles (worker, reviewer, orchestrator, review agent, daemon, operator) each keep one
  consistent colour across every page, always paired with a text label.

## Evidence on Hand

- Real coordination history, usage ledger and project state from the operator's daemon
  (`~/.openswarm/`), visible through `openswarm dash`.
- Design review 2026-10-19: `.impeccable/critique/2026-10-19T02-41-27Z__web-static.md`
  (19/40) with captures in `.impeccable/review-20261019/` (not committed).
- No testimonials, customer logos or adoption numbers exist; do not invent them.

## Product Principles

1. **Exceptions first.** What needs the operator outranks everything else on every page; a
   healthy swarm should look calm and say so in one line.
2. **Say what the number measures.** Every status, count and colour names its source and
   scope; two pages never disagree about the same fact.
3. **Actions report their outcome where they were taken.** No silent success, no silent
   failure, no button that can hang.
4. **Human words, machine detail on demand.** Repository names, task labels and roles lead;
   UUIDs, hashes and adapter internals sit behind a copy or a disclosure.
5. **One shell.** Every page shares one navigation, one status line, one language and one
   set of interaction patterns.

## Accessibility & Inclusion

WCAG 2.2 AA: body text contrast ≥ 4.5:1 and UI component contrast ≥ 3:1 in both themes,
full keyboard operation with visible focus, touch targets ≥ 44 px on narrow viewports,
colour never the sole indicator, `prefers-reduced-motion` respected.
