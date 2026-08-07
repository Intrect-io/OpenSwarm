<h1 align="center">
  <img src="https://raw.githubusercontent.com/unohee/OpenSwarm/main/assets/openswarm_hero.png" alt="OpenSwarm" width="480" />
</h1>

[![Sponsored by Atlas Cloud](https://img.shields.io/badge/⚡_Sponsored_by-Atlas_Cloud-4F46E5?labelColor=0B1120)](https://www.atlascloud.ai)
[![npm version](https://img.shields.io/npm/v/@intrect/openswarm.svg)](https://www.npmjs.com/package/@intrect/openswarm)
[![npm downloads](https://img.shields.io/npm/dm/@intrect/openswarm.svg)](https://www.npmjs.com/package/@intrect/openswarm)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![SWE-bench Lite](https://img.shields.io/badge/SWE--bench_Lite-hybrid_3%2F3_resolved-2ea44f)](benchmarks/RUBRIC.md)
[![GitHub Discussions](https://img.shields.io/github/discussions/unohee/OpenSwarm?logo=github&label=discussions)](https://github.com/unohee/OpenSwarm/discussions)

> Autonomous AI agent orchestrator — Codex, GPT, **OpenRouter (any model)**, local models (Ollama/LM Studio), and Claude Code (`claude -p`)

> 💬 **Help shape OpenSwarm.** Share feature ideas, vote on the roadmap, and ask questions in [**GitHub Discussions**](https://github.com/unohee/OpenSwarm/discussions). The roadmap is built in the open — your feedback decides what ships next.

---

OpenSwarm orchestrates multiple AI agents as autonomous code workers. It picks up issues from **Linear or a built-in local tracker**, runs Worker/Reviewer pair pipelines, reports through a pluggable notifier (Discord, Slack, Telegram, webhook), and retains long-term memory via LanceDB. Workers run on **OpenAI Codex/GPT**, **any OpenRouter model**, **local open-source models** (Ollama, LM Studio), or **Claude Code** (`claude -p`, opt-in) — with cost-aware routing measured on an L0–L6 benchmark ladder.

**Verified on real GitHub issues**: the agentic harness solves SWE-bench Lite instances graded by the official harness. Hybrid mode — a frontier model diagnoses read-only, a lightweight model implements with a verification loop — resolved **3/3 attempted instances** that every single lightweight model had failed, at a fraction of frontier-only cost. Workers also **learn each repository over time**: task outcomes are stored as per-repo knowledge and recalled into future prompts. ([benchmark rubric & results](benchmarks/RUBRIC.md))

## Sponsors

OpenSwarm is proudly supported by **[Atlas Cloud](https://www.atlascloud.ai)** — an enterprise AI infrastructure platform serving fast, stable LLM, image, and video APIs (partnered with OpenRouter and SGLang).

As an **official provider sponsor**, Atlas Cloud ships as the built-in `atlascloud` adapter (OpenAI-compatible Chat Completions, `ATLASCLOUD_API_KEY`) and provides ongoing monthly API credits that keep the project's autonomous runs going. To run OpenSwarm on Atlas Cloud, grab a key at [atlascloud.ai](https://www.atlascloud.ai/console/api-keys), set `ATLASCLOUD_API_KEY`, and select `adapter: atlascloud`.

## Quick Start

```bash
npm install -g @intrect/openswarm
openswarm init         # interactive setup wizard — provider auth + Linear OAuth + config
openswarm doctor       # verify your environment (runtime, native deps, providers, ports)
openswarm              # launches the TUI chat
```

`openswarm init` walks you through provider authentication, optional Linear OAuth (team/project picker), and writes a validated `config.yaml`. Prefer wiring a provider by hand? You need **one** first: `openswarm auth login` (ChatGPT OAuth, used by `codex`/`gpt`), `openswarm auth login --provider openrouter` (or `export OPENROUTER_API_KEY=…`), or just have an authenticated `claude` on PATH. Check what's wired with `openswarm auth status`, and diagnose any gaps with `openswarm doctor`.

### What `openswarm init` sets up

The wizard asks three questions, detects what you already have, and writes the config for you:

1. **AI provider** (worker/reviewer) — it auto-detects existing auth and offers inline login:
   - `codex-responses` — ChatGPT subscription via OAuth (Codex models, native loop) — **easiest start**
   - `codex` — external `codex` CLI · `openrouter` — any model (API key/OAuth) · `gpt` — OpenAI OAuth
   - `lmstudio` / `local` — local servers, no account · `claude` — `claude -p` CLI (opt-in fallback)
2. **Task backend** — `local` SQLite issue store (no account) **or** `linear` (OAuth browser login or API key, then an arrow-key **team → project** picker for this repo)
3. **Notification channel** (optional) — `none` / `discord` / `slack` / `telegram` / `webhook`

It then writes **`.env`** (secrets, `chmod 600`), **`config.yaml`** (validated), and — if you mapped a Linear project — **`openswarm.json`** (this repo → Linear team/project). Finally it prints next steps and can launch browser OAuth.

> Re-running in a repo that already has `config.yaml` is refused unless you pass `--force`, and `init` refuses to overwrite a `config.yaml` that symlinks into the daemon's global config. For CI / non-interactive use, `openswarm init --yes` writes a sample config only.

![TUI Chat Interface](screenshots/tui.png)

### TUI keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Switch tabs (Chat / Projects / Tasks / Stuck / Issues / Logs) |
| `Enter` | Send message |
| `Shift+Enter` | Newline |
| `i` | Focus input |
| `Esc` | Exit input focus |
| `Ctrl+C` | Quit |

Status bar shows: provider · model · message count · cumulative cost

---

## CLI Commands

```bash
openswarm                        # TUI chat (default)
openswarm chat [session]         # Simple readline chat
openswarm resume                 # Reopen the most recent chat session (conversation + goal)
openswarm start                  # Start full daemon (requires config.yaml)
openswarm run "Fix the bug" -p ~/my-project   # Run a single task
openswarm exec "Run tests" --local --pipeline # Execute via daemon
openswarm init                   # Interactive setup wizard (provider auth, Linear OAuth, config)
openswarm provider               # Show/switch the active provider (interactive picker)
openswarm provider claude        # Switch straight to a provider — a running daemon switches in place
openswarm doctor                 # Diagnose environment (runtime, native deps, providers, ports)
openswarm validate               # Validate config.yaml

# Code review
openswarm review                 # Review the working-tree changes
openswarm review --max           # Full-codebase audit: fan reviewer subagents over areas
                                 #   → report at .openswarm/audit/ + PM-synthesized Linear
                                 #   issues by default (≤10 cohesive, master + sub-issues)
openswarm review --max --fix     # after the audit, dependency-related findings are grouped;
                                 #   independent fix units run in isolated sandboxes, then
                                 #   a PR is published only after every re-review and trusted
                                 #   deterministic repository check passes
                                 #   add --in-place to edit the current working tree instead
openswarm review --max --concurrency 8   # widen the fan-out — areas auto-split to fill the pool
                                 # more --max flags: --no-linear (report only) · --issues-per-area
                                 #   (legacy spray) · --issues <id> (set parent) · --fallback
                                 #   <adapter> · --out <file> · --dry-run (print the plan)

# CI / test gate auto-fix (npm / Cargo / Python auto-detected)
openswarm fix                    # Run the checks (package.json scripts, or cargo check+test,
                                 #   or ruff/mypy/pytest), fan a fix-worker out over the
                                 #   failures, re-run until green
openswarm fix --checks lint,test # only these checks · --concurrency <n> · --rounds <n> (default 3)
                                 # any language: put {"checks": {"test": "pytest -x"}} in openswarm.json

# PR autopilot (on-demand — conflict → comments → CI; does not merge)
openswarm pr status              # Snapshot: conflicts, CI, CHANGES_REQUESTED / critical comments
openswarm pr status --json       # Machine-readable; exit 0 only when merge-ready
openswarm pr fix                 # One-shot fix for the current branch's open PR (or --number N)
openswarm pr review              # Re-apply reviewer feedback only (Claude, Codex, or CHANGES_REQUESTED) — no conflict/CI work
openswarm pr review --fresh      # Run a brand-new code review of the PR diff and post it as a comment
openswarm pr review --all        # Review every open PR in the repo instead of just one (combine with --fresh)
openswarm pr watch               # Loop fix until merge-ready or --rounds exhausted (default 5)
openswarm pr create              # Local fix → commit → push → gh pr create (from feature branch)
openswarm pr create --no-fix --issue INT-123 --title "feat: …"  # skip local fix; set issue id

# Code Registry & BS Detector
openswarm check --scan           # Scan repo → register all entities
openswarm check src/foo.ts       # File brief (entities, tests, risk)
openswarm check --bs             # BS pattern scan (bad code smells)
openswarm check --stats          # Registry statistics
openswarm check --high-risk      # High-risk entities
openswarm check --search "name"  # Full-text search
openswarm annotate "funcName" --deprecate "reason"
openswarm annotate "funcName" --tag "needs-refactor"
openswarm annotate "funcName" --warn "error/security: SQL injection"
```

### `openswarm review` exit codes

`review` is designed to work as a CI merge gate, and CI reads nothing but the
exit code:

| Exit | Meaning |
|------|---------|
| `0`  | The gate ran and did not reject (approve/revise), or there was nothing to review |
| `1`  | The gate ran and the verdict is reject — with `--fix`, also when any area is left unresolved or deterministic verification did not pass |
| `2`  | The gate did **not** run — no verdict was produced (provider usage limit, adapter failure, unparseable reviewer output). Never treat this as a pass |

Treat any non-zero exit as a failed check. The `1`/`2` split lets a workflow
retry or alert differently when the gate could not run at all (e.g. a quota
window exhausted — stderr names the cause and, when known, the reset time).

### Running the gate in CI

A composite action wraps the whole flow — install, diff against the PR base,
review, and map the exit code onto the job result:

```yaml
permissions:
  contents: read
  security-events: write   # only needed for the SARIF upload

steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }   # the merge base has to be present to diff against
  - uses: actions/setup-node@v4
    with: { node-version: '22' }
  - id: review
    uses: unohee/OpenSwarm@main
    with:
      adapter: openrouter   # a hosted runner has no config; without this the CLI
                            # falls back to its `codex` default
    env:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  - if: always() && steps.review.outputs.sarif-file != ''
    uses: github/codeql-action/upload-sarif@v3
    with: { sarif_file: ${{ steps.review.outputs.sarif-file }} }
```

Inputs: `path` (which checkout to review), `base` (defaults to the merge base of
the PR head and its base branch), `adapter`, `read-only`, `version`,
`sarif-file`, and `fail-on-gate-not-run` — the last defaults to `true` because a
review that did not happen must not read as a pass.

Outputs: `decision`, `gate-ran`, `sarif-file`.

#### Reviewing pull requests safely

The reviewer reads attacker-authored files with your provider credential in the
environment. Two properties keep that from becoming code execution:

**`read-only` defaults to `true`**, which denies the reviewer every mutating tool
including `bash`. It is enforced per adapter, and an adapter that cannot enforce
it refuses to run rather than quietly ignoring the flag:

| Adapter | How read-only is enforced |
| --- | --- |
| `openrouter`, `atlascloud`, `gpt`, `codex-responses`, `local`/`lmstudio` | The agentic loop withholds the mutating, web, and MCP tools, and the executor refuses them if called anyway |
| `claude` | `--permission-mode default` with an allowlist of `Read`/`Grep`/`Glob`, instead of `bypassPermissions` |
| `codex` | `--sandbox read-only` instead of `workspace-write` |
| anything else | Refused — `spawnCli` will not start a read-only run on an adapter that has not declared enforcement |

**The reviewed checkout never becomes the working directory.** OpenSwarm looks
for its own `config.yaml` in the current directory first, so a config committed
to the pull request would otherwise choose the run's adapter, model, and MCP
servers. The action runs from the runner temp and points `--path` at the
checkout instead.

**Run the action's code from a trusted ref.** `uses: unohee/OpenSwarm@main`
already does this — the action code comes from this repository, not from the
pull request. It is only `uses: ./` that is unsafe, because after checking out a
pull request that path holds `action.yml` as the contributor wrote it, with your
secrets in scope. If you self-host the action, check it out from your default
branch into its own path and the pull request into another, then point `path` at
the latter — see
[`.github/workflows/review-gate.yml`](.github/workflows/review-gate.yml), which
does exactly that to dogfood this repository.

**To run it automatically, the trigger is `pull_request_target`.** A
`pull_request` run from a fork gets no secrets, so the provider key would be
empty and every fork PR would fail as gate-not-run.

For scripting without the action, `--json` prints the verdict on stdout under a
versioned schema (the human report is suppressed so `openswarm review --json |
jq` works), and `--sarif <file>` writes SARIF 2.1.0 for code scanning. Findings
are reported at `warning`: the verdict is what blocks, while individual
follow-ups are advisory and some accompany an approve.

`.github/workflows/review-gate.yml` in this repository dogfoods the action. It is
`workflow_dispatch` only — the gate calls a paid model on every run, so enabling
it for every pull request is left as an explicit choice.

### Deterministic verification

Autonomous pipelines enable baseline-diff verification by default: OpenSwarm runs repository test/typecheck commands once, compares a failing head against the merge base, and gives the reviewer structured evidence so pre-existing failures do not block unrelated work. Add `.openswarm/verify.yaml` for repository-specific commands (see [`templates/verify.example.yaml`](templates/verify.example.yaml)), or let OpenSwarm discover standard Node, Python, Rust, and Go checks. Configure the behavior under `autonomous.verify`; the legacy `guards.qualityGate` whole-tree check is deprecated.

#### The Linux sandbox

On Linux, verification runs each command inside bubblewrap and **fails closed
when it cannot** — running a worker's code unsandboxed to decide whether to
trust it defeats the point. On macOS it uses the platform sandbox and needs no
setup.

Installing the package is not always enough, and CI is where that bites:

| Environment | What it takes |
| --- | --- |
| GitHub Actions `ubuntu-latest` | `sudo apt-get install -y bubblewrap` **and** `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Measured 2026-08-01: the image sets that restriction to `1`, and with it set even `bwrap --unshare-user` fails at `setting up uid map: Permission denied`. This repository's own CI asserts the recipe so it cannot go stale. |
| Docker, default seccomp | `--security-opt seccomp=unconfined`; add `--cap-add SYS_ADMIN` if the runtime also drops the capability |
| Debian/Ubuntu host | `apt-get install -y bubblewrap`, usually nothing else |
| Alpine | `apk add bubblewrap` |

When the sandbox is unavailable, OpenSwarm says which of these applies rather
than reporting a bare failure: it runs bwrap to find out instead of guessing
from sysctls, quotes bwrap's own error, and prints the matching fix.

For crash recovery, fenced execution leases, outbox semantics, rollout modes, and
repository admission policy, see [Durable autonomous loop](docs/DURABLE_AUTONOMY.md).

### `openswarm exec` options

| Option | Description |
|--------|-------------|
| `--path <path>` | Project path (default: cwd) |
| `--timeout <seconds>` | Timeout in seconds (default: 600) |
| `--local` | Execute locally without daemon |
| `--pipeline` | Full pipeline: worker + reviewer + tester + documenter |
| `--worker-only` | Worker only, no review |
| `-m, --model <model>` | Model override for worker |

Exit codes: `0` success · `1` failure · `2` timeout

---

## Full Daemon Setup

For autonomous operation (Linear issue processing, Discord control, PR auto-improvement), you need a full config:

### Prerequisites

- **Node.js** >= 22
- **At least one LLM provider**:
  - **OpenAI Codex** — `codex-responses` (ChatGPT OAuth, native loop, no extra binary) is the smoothest start; `codex` delegates to the external Codex CLI. `openswarm auth login` handles the ChatGPT OAuth
  - **OpenRouter** — any model; `OPENROUTER_API_KEY` or `openswarm auth login --provider openrouter`
  - **OpenAI GPT** — `openswarm auth login --provider gpt`
  - **Local** — LM Studio (`lmstudio`, `:1234`) or Ollama (`local`, `:11434`), auto-detected, no auth
  - **Claude Code CLI** (`claude -p`) — opt-in fallback; an authenticated `claude` on PATH
- **Native build toolchain** — `better-sqlite3` and `@lancedb/lancedb` are native modules. Prebuilt binaries cover common platforms; if yours lacks one, `npm install` builds from source and needs `python3` + a C/C++ toolchain (`build-essential` on Linux, Xcode Command Line Tools on macOS)
- **For autonomous mode only** (optional): **Linear** — sign in with `openswarm auth login --provider linear` (OAuth PKCE) or use an API key + team ID; **Discord** bot token (message content intent); **GitHub CLI** (`gh`) for CI monitoring

### Configuration

After the global install, run the wizard **in the directory you want the daemon to manage** — it writes everything for you:

```bash
openswarm init      # writes config.yaml + .env (provider, task backend, notifications)
openswarm doctor    # verify providers, native deps, ports
```

See [What `openswarm init` sets up](#what-openswarm-init-sets-up) for the prompts. Prefer to edit by hand? `config.yaml` supports `${VAR}` / `${VAR:-default}` substitution (resolved from `.env`) and is validated with Zod. A minimal `.env` (the wizard writes only what your choices need):

```bash
LINEAR_API_KEY=your-linear-api-key      # or: openswarm auth login --provider linear
LINEAR_TEAM_ID=your-linear-team-id
DISCORD_TOKEN=your-discord-bot-token    # only if you chose the discord notifier
DISCORD_CHANNEL_ID=your-channel-id
```

### Key configuration sections

| Section | Description |
|---------|-------------|
| `discord` | Bot token, channel ID, webhook URL |
| `linear` | API key, team ID |
| `github` | Repos list for CI monitoring |
| `agents` | Agent definitions (name, projectPath, heartbeat interval) |
| `autonomous` | Schedule, pair mode, role models, decomposition settings |
| `prProcessor` | PR auto-improvement schedule, retry limits, conflict resolver config |

### CLI Adapter (Provider)

```yaml
adapter: codex   # one of: codex · codex-responses · gpt · openrouter · atlascloud · lmstudio · local  (default: codex)
```

`adapter` accepts one of the seven values below (validated by Zod). For a ChatGPT subscription, `codex-responses` is the smoothest first-run choice — it runs OpenSwarm's native loop over the Responses API with no extra binary. Switch at runtime via Discord, e.g. `!provider codex-responses` / `!provider openrouter`.

| Adapter | Backend | Models | Auth |
|---------|---------|--------|------|
| `codex-responses` | OpenAI Responses API (native loop, no CLI binary) | gpt-5.6-terra (default), gpt-5.6-sol, gpt-5.6-luna | ChatGPT OAuth |
| `codex` | OpenAI Codex CLI (delegated) | gpt-5-codex (default), o3, o4-mini | ChatGPT OAuth / `codex` CLI auth |
| `gpt` | OpenAI Chat API | gpt-4o (default), o3, … | OAuth PKCE |
| `openrouter` | OpenRouter API (native agentic loop) | any OpenRouter model — gpt-5, gemini-2.5, deepseek, glm, qwen, … | `OPENROUTER_API_KEY` or OAuth PKCE |
| `atlascloud` | Atlas Cloud API (native agentic loop) · [sponsor](#sponsors) | Atlas models — deepseek-v4-pro (default), qwen3.5-flash, … | `ATLASCLOUD_API_KEY` |
| `lmstudio` | LM Studio (OpenAI-compatible, local) | loaded LM Studio model (`LMSTUDIO_MODEL`) | None |
| `local` | Ollama (local, auto-detected) | gemma, llama, qwen, mistral, … | None |

> **Claude Code (`claude -p`)** is supported as an **opt-in fallback** (and powers the `claude -p` chat path) — install the `claude` CLI and authenticate it; `openswarm init` and `openswarm doctor` detect it. It is a valid `adapter:` value, but opt-in: nothing falls back to it automatically. Switch to it when another provider runs out of quota with `openswarm provider claude`.

The `openrouter` adapter runs OpenSwarm's own agentic tool loop (read/search/edit/bash with verification guards), enables ZDR (`data_collection: deny`) for non-OpenAI models, and applies Anthropic prompt caching automatically. Local backends are auto-detected on standard ports (Ollama `:11434`, LM Studio `:1234`); use `lmstudio` for a dedicated LM Studio endpoint (`LMSTUDIO_BASE_URL`, default `http://localhost:1234`).

Per-role adapter overrides (each role may pick its own valid adapter + model):

```yaml
autonomous:
  defaultRoles:
    worker:
      adapter: codex-responses
      model: gpt-5.6-terra
    reviewer:
      adapter: openrouter
      model: anthropic/claude-sonnet-4
```

Optional backlog grooming runs a read-only Planner over the fetched open queue
states for a mapped project (`Todo`, `In Progress`, `In Review`, and `Backlog`)
and compares them with the current repo. Keep `mode: comment` while validating
recommendations; `mode: apply` can update drifted descriptions and move strongly
stale issues to Done.

```yaml
autonomous:
  backlogGrooming:
    enabled: false
    cadenceHours: 24
    mode: comment
    plannerModel: gpt-5.6-terra
    maxIssues: 80
```

### Agent Roles

```yaml
autonomous:
  defaultRoles:
    worker:
      model: gpt-5.6-terra            # balanced default implementation
      escalateModel: gpt-5.6-sol      # frontier retry after a failed attempt
      escalateAfterIteration: 2
      timeoutMs: 1800000
    reviewer:
      model: gpt-5.6-sol              # correctness gate
      timeoutMs: 600000
    tester:
      enabled: false
      model: gpt-5.6-terra            # LLM fallback after deterministic verify
    documenter:
      enabled: false
      model: gpt-5.6-luna
    auditor:
      enabled: false
      model: gpt-5.6-sol
    skill-documenter:
      enabled: false
      model: gpt-5.6-luna
  jobProfiles:
    - name: light
      minMinutes: 1
      maxMinutes: 29
      effort: low
      roles:
        worker: gpt-5.6-luna
        reviewer: gpt-5.6-terra
    - name: heavy
      minMinutes: 30
      effort: high
      roles:
        worker: gpt-5.6-terra
        reviewer: gpt-5.6-sol
```

The native Codex adapter uses Terra when no model is pinned. Draft analysis uses
Luna because it runs for every task; decomposition and hard review stay on Sol.

### Running the daemon

With the global install, the `openswarm` CLI manages the daemon directly — no repo or `npm run` scripts needed:

```bash
openswarm start               # start the daemon in the background
openswarm start --foreground  # run attached (logs stream to the terminal)
openswarm status              # pid, uptime, log path
openswarm stop                # stop the daemon
openswarm dash                # open the web dashboard (:3847)
```

> **From source / development** (contributors): clone the repo and use the `npm run …` scripts (`npm run dev`, `npm start`, `npm run service:install` for a macOS launchd service, `docker compose up -d`). See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Architecture

```
                         ┌──────────────────────────┐
                         │       Linear API          │
                         │   (issues, state, memory) │
                         └─────────────┬────────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 │                     │                     │
                 v                     v                     v
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ AutonomousRunner │  │  DecisionEngine  │  │  TaskScheduler   │
  │ (heartbeat loop) │─>│  (scope guard)   │─>│  (queue + slots) │
  └────────┬─────────┘  └──────────────────┘  └────────┬─────────┘
           │                                            │
           v                                            v
  ┌──────────────────────────────────────────────────────────────┐
  │                      PairPipeline                            │
  │  ┌────────┐   ┌──────────┐   ┌────────┐   ┌─────────────┐  │
  │  │ Worker │──>│ Reviewer │──>│ Tester │──>│ Documenter  │  │
  │  │(Adapter│<──│(Adapter) │   │(Adapter│   │  (Adapter)  │  │
  │  └───┬────┘   └──────────┘   └────────┘   └─────────────┘  │
  │      │  ↕ StuckDetector                                      │
  │  ┌───┴────────────────────────────────────────────────────┐  │
  │  │ Adapters: Codex | GPT | OpenRouter | Local (Ollama)   │  │
  │  └────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
           │                     │                     │
           v                     v                     v
  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  Discord Bot │  │  Memory (LanceDB │  │  Knowledge Graph │
  │  (commands)  │  │  + Xenova E5)    │  │  (code analysis) │
  └──────────────┘  └──────────────────┘  └────────┬─────────┘
                                                    │
                                           ┌────────┴─────────┐
                                           │  Code Registry   │
                                           │  (SQLite + FTS5) │
                                           │  + BS Detector   │
                                           └──────────────────┘
```

## Features

- **Multi-Provider Adapters** — Pluggable adapter system: **OpenAI Codex/GPT**, **OpenRouter** (any model, native agentic loop), **local models** (Ollama, LM Studio), and **Claude Code** (`claude -p`, opt-in) with runtime provider switching
- **Code Registry** — SQLite-backed entity registry tracking every function/class/type across 8 languages, with complexity scoring, test mapping, and risk assessment
- **BS Detector** — Built-in static analysis engine that detects bad code patterns (empty catch, hardcoded secrets, `as any`, etc.) with pipeline guard integration
- **Autonomous Pipeline** — Cron-driven heartbeat fetches Linear issues, runs Worker/Reviewer pair loops, and updates issue state automatically
- **Worker/Reviewer Pairs** — Multi-iteration code generation with automated review, testing, and documentation stages
- **Codebase Audit (`review --max`)** — fans reviewer subagents out over directory-shaped areas (auto-split to fill `--concurrency`), aggregates a deduped verdict into a markdown report, and synthesizes ≤10 cohesive Linear issues via a PM agent. Both `review` modes consult repository-local prior review logs; resolved/stale findings are not repeated, and byte-identical duplicate follow-ups are suppressed while unresolved issues remain visible. `--fix` groups findings by repository dependency closure, injects the package manager/manifests/verification contract and repo knowledge, runs only independent fix units concurrently in isolated sandboxes, and promotes disjoint in-scope diffs into an audit worktree. It publishes the PR only when every area re-approves and trusted deterministic verification passes; unavailable dependencies/checks fail closed. `--in-place` keeps edits in the current working tree but uses the same gates. Language-agnostic; codex usage-limit aware with automatic `claude` fallback
- **CI / test gate auto-fix (`openswarm fix`)** — runs the project's objective checks (lint / typecheck / build / test), groups the failures by file into areas, fans a fix-worker out over each, then **re-runs the checks and repeats until green** (or the round budget). Deterministic convergence — unlike the review fix pass, it verifies its own work. Multi-language: auto-detects npm scripts, `Cargo.toml` (`cargo check`/`test`, clippy on request), and Python tooling (`ruff`/`mypy`/`pytest`, gated on the repo's config); any other toolchain via a `"checks"` map in `openswarm.json`
- **PR autopilot (`openswarm pr`)** — on-demand surface over the daemon's PRProcessor + `commitAndCreatePR`. `status` reports conflicts / review feedback / CI; `fix` runs one autopilot pass (conflict → comments → CI); `review` re-applies reviewer feedback only, skipping conflict/CI work — recognizes Claude, Codex, and any formal `CHANGES_REQUESTED` review; `review --fresh` instead runs a brand-new code review of the PR's current diff (the same reviewer `openswarm review` uses) and posts the verdict as a PR comment, independent of any existing feedback; `review --all` reviews every open PR in the repo sequentially (combine with `--fresh`) instead of just the current branch's PR or `--number`; `watch` loops until merge-ready; `create` publishes the current feature branch (local fix → commit → push → `gh pr create`). Never merges or enables auto-merge.
- **Decision Engine** — Scope validation, rate limiting, priority-based task selection, and workflow mapping
- **Cognitive Memory** — LanceDB vector store with Xenova/multilingual-e5-base embeddings for long-term recall across sessions
- **Repo Knowledge Loop** — workers learn each repository over time: task outcomes (success patterns, review-rejection pitfalls) are stored per-repo and recalled into the next worker prompt
- **SWE-bench Verified** — the agentic harness solves real SWE-bench Lite issues, graded by the official harness; hybrid mode (frontier diagnosis + lightweight implementer) resolved 3/3 attempted instances ([benchmarks/RUBRIC.md](benchmarks/RUBRIC.md))
- **Knowledge Graph** — Static code analysis, dependency mapping, impact analysis, and file-level conflict detection across concurrent tasks
- **Discord Control** — Full command interface for monitoring, task dispatch, scheduling, provider switching, and pair session management
- **Rich TUI Chat** — Claude Code inspired terminal interface with tabs, streaming responses, and geek-themed loading messages
- **Dynamic Scheduling** — Cron-based job scheduler with Discord management commands
- **PR Auto-Improvement** — Monitors open PRs, auto-fixes CI failures, auto-resolves merge conflicts, and retries until all checks pass
- **Long-Running Monitors** — Track external processes (training jobs, batch tasks) and report completion
- **Web Dashboard** — Real-time pipeline stages, cost tracking, worktree status, and live logs on port 3847
- **Pace Control** — 5-hour rolling window task caps, per-project limits, turbo mode, exponential backoff on failures
- **i18n** — English and Korean locale support

---

## How It Works

```
Linear (Todo/In Progress)
  → Fetch assigned issues
  → DecisionEngine filters & prioritizes
  → Resolve project path via projectMapper
  → PairPipeline.run()
    → Worker generates code (via the configured adapter)
    → Reviewer evaluates (APPROVE/REVISE/REJECT)
    → Loop up to N iterations
    → Optional: Tester → Documenter stages
  → Update Linear issue state (Done/Blocked)
  → Report to Discord
  → Save to cognitive memory
```

### Memory System

Hybrid retrieval: `0.60 × similarity + 0.25 × importance + 0.15 × recency`

Memory types: `belief` · `strategy` · `user_model` · `system_pattern` · `constraint`

Background: decay, consolidation, contradiction detection, distillation.

**Embeddings** run locally via `@huggingface/transformers` (ONNX, no external
service). The default is `Xenova/multilingual-e5-base` (768d, int8), stored text is
embedded as a `passage:` and searches as a `query:` per the E5 asymmetric
convention. Weights are cached in `~/.openswarm/models` so reinstalling OpenSwarm
does not discard them.

| Variable | Purpose |
| --- | --- |
| `OPENSWARM_EMBEDDING_MODEL` | Hugging Face repo id. Models outside the known table must also set `OPENSWARM_EMBEDDING_DIM`. |
| `OPENSWARM_EMBEDDING_DIM` | Vector dimension. Required for unknown models — a wrong value silently produces an unsearchable table. |
| `OPENSWARM_EMBEDDING_DTYPE` | ONNX weight variant: `q8` (default), `q4`, `q4f16`, `fp16`, `fp32`. |
| `OPENSWARM_MODEL_CACHE_DIR` | Override the weight cache location. |

Changing any of these invalidates every stored vector: the store records an
embedding signature and warns when it no longer matches the active encoder.
Rebuild with `openswarm memory reembed` (stop the daemon first, or pass `--force`).

**Repo knowledge loop** — every completed task writes repo-scoped knowledge
(success → `system_pattern` with files changed + approach, review rejection →
`constraint` pitfall), and the next task on the same repo recalls the most
relevant entries into the worker prompt as a "Repository Knowledge" section.
Workers get better at a codebase the more they work on it. Workers can also actively query accumulated repo knowledge mid-task via the `search_memory` tool.

### Benchmarks (L0–L6)

`benchmarks/` contains a difficulty ladder for routing models by measured
capability — synthetic L0–L5 tasks with deterministic grading, and L6 = real
GitHub issues (SWE-bench Lite) solved by the OpenSwarm harness and graded by
the official swebench harness. Headline: **hybrid mode** (frontier read-only
diagnosis + lightweight implementer with a verification loop) resolved 3/3
attempted instances that every single lightweight model had failed. See
[benchmarks/RUBRIC.md](benchmarks/RUBRIC.md) for the rubric, measured results,
and the harness defects the benchmark uncovered.

---

## Discord Commands

### Task Dispatch
| Command | Description |
|---------|-------------|
| `!dev <repo> "<task>"` | Run a dev task on a repository |
| `!dev list` | List known repositories |
| `!tasks` | List running tasks |
| `!cancel <taskId>` | Cancel a running task |

### Agent Management
| Command | Description |
|---------|-------------|
| `!status` | Agent and system status |
| `!pause <session>` | Pause autonomous work |
| `!resume <session>` | Resume autonomous work |
| `!log <session> [lines]` | View recent output |

### Linear Integration
| Command | Description |
|---------|-------------|
| `!issues` | List Linear issues |
| `!issue <id>` | View issue details |
| `!limits` | Agent daily execution limits |

### Autonomous Execution
| Command | Description |
|---------|-------------|
| `!auto` | Execution status |
| `!auto start [cron] [--pair]` | Start autonomous mode |
| `!auto stop` | Stop autonomous mode |
| `!auto run` | Trigger immediate heartbeat |
| `!approve` / `!reject` | Approve or reject pending task |

### Worker/Reviewer Pair
| Command | Description |
|---------|-------------|
| `!pair` | Pair session status |
| `!pair start [taskId]` | Start a pair session |
| `!pair run <taskId> [project]` | Direct pair run |
| `!pair stop [sessionId]` | Stop a pair session |
| `!pair history [n]` | View session history |
| `!pair stats` | View pair statistics |

### Scheduling
| Command | Description |
|---------|-------------|
| `!schedule` | List all schedules |
| `!schedule run <name>` | Run a schedule immediately |
| `!schedule toggle <name>` | Enable/disable a schedule |
| `!schedule add <name> <path> <interval> "<prompt>"` | Add a schedule |
| `!schedule remove <name>` | Remove a schedule |

### Other
| Command | Description |
|---------|-------------|
| `!ci` | GitHub CI failure status |
| `!provider <codex\|codex-responses\|openrouter\|gpt\|atlascloud\|lmstudio\|local>` | Switch CLI provider at runtime |
| `!codex` | Recent session records |
| `!memory search "<query>"` | Search cognitive memory |
| `!help` | Full command reference |

---

## Project Structure

```
src/
├── index.ts                 # Entry point
├── cli.ts                   # CLI entry point (run, exec, chat, init, validate, start)
├── cli/                     # CLI subcommand handlers
│   └── promptHandler.ts     # exec command: daemon submit, auto-start, polling
├── core/                    # Config, service lifecycle, types, event hub
├── adapters/                # Provider adapters (codex, codex-responses, gpt, openrouter, local, lmstudio), agentic loop
├── agents/                  # Worker, reviewer, tester, documenter, auditor
│   ├── pairPipeline.ts      # Worker → Reviewer → Tester → Documenter pipeline
│   ├── agentBus.ts          # Inter-agent message bus
│   └── cliStreamParser.ts   # Claude CLI output parser
├── orchestration/           # Decision engine, task parser, scheduler, workflow
├── automation/              # Autonomous runner, cron scheduler, PR processor
├── memory/                  # LanceDB + Xenova embeddings cognitive memory
├── knowledge/               # Code knowledge graph (scanner, analyzer, graph)
├── registry/                # Code entity registry, BS detector, entity scanner
├── issues/                  # Local issue tracker (SQLite + GraphQL + Kanban UI)
├── discord/                 # Bot core, command handlers, pair session UI
├── linear/                  # Linear SDK wrapper, project updater
├── github/                  # GitHub CLI wrapper for CI monitoring
├── support/                 # Web dashboard, planner, rollback, git tools
├── locale/                  # i18n (en/ko) with prompt templates
└── __tests__/               # Vitest test suite
```

## State & Data

| Path | Description |
|------|-------------|
| `~/.openswarm/` | State directory (memory, codex, metrics, workflows) |
| `~/.openswarm/registry.db` | Code entity registry (SQLite) |
| `~/.openswarm/issues.db` | Local issue tracker (SQLite) |
| `~/.claude/openswarm-*.json` | Pipeline history and task state |
| `~/.config/openswarm/telemetry.json` | Anonymous install id + opt-out notice flag |
| `config.yaml` | Main configuration |
| `dist/` | Compiled output |

---


## Privacy & Telemetry

OpenSwarm collects **anonymous, opt-out** usage telemetry to understand how it's
actually used (npm downloads and GitHub stars don't tell us). A single event is
sent per command invocation.

**What is sent** (and nothing else):

| Field | Example | Why |
|-------|---------|-----|
| Random install id | `V1StGXR8_Z5j...` (nanoid) | De-duplicate installs — anonymous, local-only |
| Command | `start`, `run`, `chat` | Which features are used |
| Version | `0.9.3` | Version adoption |
| OS / arch | `darwin` / `arm64` | Platform support priorities |
| Node version | `22.3.0` | Runtime support |
| Adapter family | `codex` | Which providers are popular |
| Error flag | `0` / `1` | Failure rate (boolean only) |

**Never sent:** source code, prompts, file paths, repo or issue names, Linear/Discord
content, environment variables, API keys, or any personal data.

**How to opt out** (any one):

```bash
export OPENSWARM_TELEMETRY=0      # or DO_NOT_TRACK=1
```
```yaml
# config.yaml
telemetry:
  enabled: false
```

CI environments (`CI` / `GITHUB_ACTIONS`) are excluded automatically. The collector
is a Cloudflare Worker writing to a private D1 table; telemetry never blocks or slows
the CLI (fire-and-forget with a short timeout, and failures are silently ignored).


## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript (strict mode) |
| Build | tsc |
| Agent Execution | Claude Code, OpenAI GPT/Codex, Ollama/LMStudio/llama.cpp |
| Local DB | better-sqlite3 (WAL mode, FTS5) |
| Task Management | Linear SDK (`@linear/sdk`) |
| Communication | Discord.js 14 |
| Vector DB | LanceDB + Apache Arrow |
| Embeddings | Xenova/transformers (multilingual-e5-base, 768D) |
| Scheduling | Croner |
| Config | YAML + Zod validation |
| Linting | oxlint |
| Testing | Vitest |

---

## Changelog

Full version history lives in **[CHANGELOG.md](CHANGELOG.md)** and the
[GitHub Releases](https://github.com/unohee/OpenSwarm/releases) page.

Latest — **v0.17.7**: `openswarm stop` now actually stops a launchd-managed
daemon, a dashboard project disable survives a daemon restart, failed-session
partial work is committed to its branch before the worktree is preserved, and
Lance memory writes retry instead of colliding under `review --max`. Adds the
Atlas Cloud provider adapter. See CHANGELOG.md for the rest.

---

## Troubleshooting

### Korean / multibyte input doubles over mobile SSH (e.g. Termius)

If the chat TUI shows each Hangul (or other multibyte) character twice —
`이이렇렇게 쓰쓰이는것` — while ASCII characters look fine, the cause is almost
always **client-side local / predictive echo** in the mobile SSH app drawing an
extra copy of wide characters. The keystroke reaches OpenSwarm once; the terminal
paints it twice.

Fix it in the SSH client:

- **Termius** → Host/Terminal settings → turn **Local Echo** (a.k.a. predictive
  echo) **off**, and ensure the encoding is **UTF-8**.
- Confirm the server side is fine by running with diagnostics:

  ```bash
  OPENSWARM_DEBUG_INPUT=1 openswarm chat
  ```

  Type a few Korean characters, then inspect `~/.openswarm/input-debug.log`. If a
  single keypress logs **one** code point (`cp=[51060]`) but you saw two glyphs,
  the doubling is terminal echo (client-side). If it logs the code point **twice**
  in one event, it's an app-level issue — please attach the log to
  [a bug report](https://github.com/unohee/OpenSwarm/issues/new?template=bug_report.md).

---

## Contributing

Contributions are welcome — OpenSwarm is MIT-licensed and accepts pull requests from anyone. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, the local check gates, branch/commit conventions, and the PR process. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

- 🐛 [Report a bug](https://github.com/unohee/OpenSwarm/issues/new?template=bug_report.md)
- 💡 [Share an idea](https://github.com/unohee/OpenSwarm/discussions) — the roadmap is built in the open
- 🔧 Fork the repo, branch from `main`, and open a PR (CI runs lint → typecheck → build → test)
- 🔒 Found a security issue? See [SECURITY.md](SECURITY.md) — please don't file it publicly

---

## License

[MIT](LICENSE) © Heewon Oh
