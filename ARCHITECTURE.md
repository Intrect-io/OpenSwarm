# OpenSwarm Architecture

> Autonomous CI/CD Pipeline Agent Framework by Intrect

## Overview

OpenSwarm is an autonomous agent orchestrator that automatically processes Linear issues. It performs code changes through a Worker/Reviewer pair pipeline, monitors via Discord, and maintains long-term memory based on LanceDB.

```
                        ┌──────────────────────────┐
                        │       Linear API         │
                        │  (issues, state, comments)│
                        └───────────┬──────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
                v                   v                   v
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  AutonomousRunner │  │  DecisionEngine  │  │  TaskScheduler   │
│  (heartbeat loop) │→│  (scope guard)   │→│  (queue + slots)  │
└──────────┬───────┘  └──────────────────┘  └────────┬─────────┘
           │                                          │
           v                                          v
┌──────────────────────────────────────────────────────────────┐
│                     PairPipeline                              │
│  ┌──────┐    ┌──────────┐    ┌────────┐    ┌───────────┐    │
│  │Worker│───→│ Reviewer │───→│ Tester │───→│Documenter │    │
│  │(CLI) │←──│  (CLI)   │    │ (CLI)  │    │  (CLI)    │    │
│  └──────┘    └──────────┘    └────────┘    └───────────┘    │
│       ↕ StuckDetector                                        │
└──────────────────────────────────────────────────────────────┘
           │                    │                    │
           v                    v                    v
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Discord Bot │  │   Memory (v2.0)  │  │  Git Tracker     │
│ (cmd/report) │  │  LanceDB + E5   │  │  (diff tracking) │
└──────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Directory Structure (v2 - SRP Layer Hierarchy)

> Refactored 2026-02-17: Flat 49 files → 9 domain directories

```
src/
├── index.ts                # Entry point
├── core/                   # Core infrastructure & types
│   ├── types.ts            # Shared TypeScript types/interfaces
│   ├── config.ts           # Configuration loading & validation
│   └── service.ts          # Main service lifecycle (start/stop)
│
├── agents/                 # Agent role implementations
│   ├── agentBus.ts         # Inter-agent message bus
│   ├── agentPair.ts        # Pair session state management
│   ├── worker.ts           # Worker agent (task execution via Claude CLI)
│   ├── reviewer.ts         # Reviewer agent (code review via Claude CLI)
│   ├── tester.ts           # Tester agent (test execution)
│   ├── documenter.ts       # Documenter agent (doc generation)
│   ├── pairPipeline.ts     # Worker→Reviewer→Tester→Documenter pipeline
│   ├── pairMetrics.ts      # Session success/duration metrics
│   └── pairWebhook.ts      # Webhook notifications for pair events
│
├── orchestration/          # Workflow & decision making
│   ├── decisionEngine.ts   # Task selection & scope control
│   ├── taskParser.ts       # Task analysis & structured parsing
│   ├── taskScheduler.ts    # Parallel task queue management
│   ├── workflow.ts         # Workflow config & DAG definitions
│   └── workflowExecutor.ts # DAG-based workflow execution engine
│
├── automation/             # Autonomous execution & scheduling
│   ├── autonomousRunner.ts # Main autonomous loop (heartbeat→decide→execute)
│   ├── runnerExecution.ts  # Execution helpers & pipeline delegation
│   ├── runnerState.ts      # Task state, pipeline history, rejection tracking
│   ├── scheduler.ts        # Cron-based dynamic scheduler
│   └── prProcessor.ts      # PR auto-improvement pipeline
│
├── memory/                 # Cognitive memory system
│   ├── index.ts            # Barrel re-export
│   ├── memoryCore.ts       # LanceDB + Xenova embeddings, save/search
│   ├── memoryOps.ts        # Revision, formatting, background cognition
│   └── codex.ts            # Session recording & summary system
│
├── discord/                # Discord bot integration
│   ├── index.ts            # Barrel re-export
│   ├── discordCore.ts      # Bot init, routing, history, event reporting
│   ├── discordHandlers.ts  # Command handlers (!status, !dev, etc.)
│   └── discordPair.ts      # Pair mode Discord commands & session UI
│
├── linear/                 # Linear project management
│   ├── index.ts            # Barrel re-export
│   ├── linear.ts           # Linear API client (issues, projects, state)
│   └── projectUpdater.ts   # PO agent: project status updates & overview
│
├── github/                 # GitHub CI/PR integration
│   ├── index.ts            # Barrel re-export
│   └── github.ts           # GitHub CLI wrapper (CI status, PRs)
│
├── knowledge/              # Code knowledge graph
│   ├── index.ts            # Public API, singleton cache, scan throttle
│   ├── graph.ts            # KnowledgeGraph data structure
│   ├── scanner.ts          # Project scanning (full + incremental)
│   ├── analyzer.ts         # Impact analysis, module health, review focus
│   ├── store.ts            # Graph persistence (save/load/list)
│   ├── gitInfo.ts          # Git churn & recent change enrichment
│   ├── repository.ts       # Module state, tech debt, issue linking
│   └── types.ts            # Zod schemas & TypeScript types
│
├── support/                # Utility & support tools
│   ├── chat.ts, dev.ts, editParser.ts, gitTracker.ts
│   ├── planner.ts, projectMapper.ts, rollback.ts
│   ├── stuckDetector.ts, timeWindow.ts, tmux.ts
│   ├── web.ts, workflowLinear.ts, delete-beliefs.ts
│   └── index.ts            # Barrel re-export
│
├── __tests__/              # Test suite
│   ├── agentPair.test.ts
│   ├── pairIntegration.test.ts
│   ├── reviewer.test.ts
│   └── worker.test.ts
│
└── locale/                 # Internationalization (i18n)
    ├── en.ts, ko.ts, types.ts, index.ts
    └── prompts/ (en.ts, ko.ts)
```

## Layer Dependency Flow

```
index.ts
  └→ core/service.ts (Main Service)
       ├→ core/config.ts (YAML/JSON + Zod validation + env substitution)
       ├→ discord/ (Discord bot + chat history + project context)
       ├→ linear/ (Linear SDK wrapper + pair mode logging)
       ├→ support/tmux.ts (Legacy: tmux session management)
       ├→ github/ (CI failure monitoring via gh CLI)
       ├→ automation/scheduler.ts (Cron job scheduling)
       ├→ support/web.ts (Web dashboard)
       └→ automation/autonomousRunner.ts (Main autonomous loop)
            ├→ orchestration/decisionEngine.ts (Task filtering + scope validation)
            │    ├→ orchestration/workflow.ts (DAG workflow engine)
            │    ├→ orchestration/taskParser.ts (Issue decomposition to subtasks)
            │    ├→ orchestration/workflowExecutor.ts (Step execution)
            │    └→ support/timeWindow.ts (Trading hours restriction)
            ├→ orchestration/taskScheduler.ts (Parallel task queue + slot management)
            ├→ agents/pairPipeline.ts (Worker → Reviewer → Tester → Documenter)
            │    ├→ agents/worker.ts (Claude CLI spawner + output parser)
            │    ├→ agents/reviewer.ts (Code review agent)
            │    ├→ agents/tester.ts (Test execution agent)
            │    ├→ agents/documenter.ts (Documentation agent)
            │    ├→ support/stuckDetector.ts (Infinite loop detection)
            │    └→ agents/agentPair.ts (Session state management)
            ├→ support/projectMapper.ts (Linear project → local path fuzzy matching)
            ├→ support/planner.ts (Large task decomposition via Claude CLI)
            ├→ memory/ (Cognitive memory: LanceDB + Xenova embeddings)
            ├→ linear/ (Issue state + comment management)
            └→ linear/projectUpdater.ts (PO agent: metrics + knowledge graph → Linear updates)
```

---

## Core Components

### 1. Service Layer (`service.ts`)

Entry point. Initializes and connects all subsystems.

- Linear/Discord/Web initialization
- Agent state management (`ServiceState`)
- GitHub CI monitoring (5-minute interval)
- Heartbeat timer (legacy)
- AutonomousRunner auto-start

### 2. Autonomous Runner (`autonomousRunner.ts`)

Core execution loop. Fetches and executes tasks via cron-based heartbeat.

**Flow:**
1. `Cron(schedule)` → triggers `heartbeat()`
2. `TimeWindow` check (blocks during trading hours)
3. `Linear.getMyIssues()` → fetches assigned issues
4. `DecisionEngine.heartbeat()` → selects executable tasks
5. `resolveProjectPath()` → maps Linear project name to local path
6. `PairPipeline.run()` → runs Worker/Reviewer loop
7. Discord report + Linear state update

**Parallel processing:** `heartbeatParallel()` → `DecisionEngine.heartbeatMultiple()` → `TaskScheduler` queue

### 3. Decision Engine (`decisionEngine.ts`)

Gatekeeper that limits autonomous behavior scope.

- **Scope Validation**: `allowedProjects` whitelist, explicit issueId/workflowId required
- **Rate Limiting**: cooldown (300s), consecutive task limit (3), time window
- **Task Prioritization**: priority → dueDate → createdAt order
- **Workflow Mapping**: auto-parses issues via taskParser → creates workflows

### 4. Pair Pipeline (`pairPipeline.ts`)

Worker → Reviewer → Tester → Documenter staged pipeline.

- **Iteration Loop**: max N iterations (default 3) Worker ↔ Reviewer cycle
- **Stuck Detection**: detects repeated errors, infinite REVISE loops, repeated output
- **Stage Roles**: configurable model/timeout per role
- **Events**: `stage:start`, `stage:complete`, `stage:fail`, etc.

### 5. Worker Agent (`worker.ts`)

Spawns Claude CLI to perform actual code work.

- Creates prompt file → executes `claude -p`
- Parses JSON output (success/failure, changed files, executed commands)
- Git diff-based file change tracking (`gitTracker.ts`)
- Text fallback parsing (when JSON fails)

### 6. Reviewer Agent (`reviewer.ts`)

Reviews Worker results and decides APPROVE/REVISE/REJECT.

- 5 evaluation criteria: correctness, code quality, tests, security, completeness
- JSON output parsing + decision normalization
- Injects feedback into Worker prompt on revision

### 7. Memory System (`memory.ts`)

Cognitive memory system based on PRD v2.0.

- **Storage**: LanceDB (vector DB) + Xenova/multilingual-e5-base (768D local embeddings)
- **Types**: belief, strategy, user_model, system_pattern, constraint + legacy (decision, repomap, journal, fact)
- **Retrieval**: Hybrid Score = 0.55*similarity + 0.20*importance + 0.15*recency + 0.10*frequency
- **Background Cognition**: decay (forgetting), consolidation (duplicate merging), contradiction detection
- **Distillation**: pre-storage noise filtering (removes chatter, short text, ephemeral emotions)

### 8. Project Mapper (`projectMapper.ts`)

Maps Linear project names to local filesystem paths.

- Scans subdirectories under ~/dev
- Fuzzy matching based on Levenshtein distance
- 5-minute TTL cache
- Fallback on mapping failure: tries direct path (with case conversion)

### 9. Discord Bot (`discord.ts`)

User interface + reporting channel.

- Commands: `!status`, `!run`, `!pair`, `!issues`, `!memory`, `!auto`, `!schedule`, `!decompose`, etc.
- OpenClaw-style chat history (per-channel LRU, 30 messages)
- Auto-detection of project context (issue prefix → project mapping)
- Access control based on allowed user IDs

### 10. Task Scheduler (`taskScheduler.ts`)

Parallel task queue management.

- Priority-based insertion sort
- Per-project concurrent execution limits (prevents duplicate project runs)
- Slot management: `maxConcurrent` setting
- Event-based: `started`, `completed`, `failed`, `slotFreed`

### 11. Planner Agent (`planner.ts`)

Decomposes large issues into 30-minute sub-tasks.

- Performs analysis only via Claude CLI (no code writing)
- Keyword-based time estimation heuristic
- Auto-creates Linear sub-issues

---

## Data Flow

### Issue Processing Flow

```
Linear (Todo/InProgress)
  → getMyIssues()
  → linearIssueToTask()
  → DecisionEngine.heartbeat()
  → [filterExecutable → prioritize → validateScope → taskToWorkflow]
  → resolveProjectPath() via projectMapper
  → PairPipeline.run()
  → [Worker → parse → Reviewer → approve/revise/reject]
  → Linear state update (Done/Blocked)
  → Discord report
```

### Memory Flow

```
Task completion/failure
  → saveCognitiveMemory('strategy'/'belief', ...)
  → Distillation (noise filter)
  → getEmbedding() via Xenova
  → LanceDB.add()

On search:
  → searchMemorySafe(query)
  → getEmbedding(query)
  → LanceDB.vectorSearch()
  → Hybrid scoring (similarity + importance + recency + frequency)
  → Return ranked results
```

---

## Configuration

```yaml
# Core configuration structure (config.yaml)
discord:        # Bot token, channel ID
linear:         # API key, team ID
github:         # CI monitoring repos
agents:         # Agent list (name, projectPath, heartbeatInterval)
autonomous:     # Autonomous mode settings
  schedule:     # Cron expression
  pairMode:     # Worker/Reviewer activation
  defaultRoles: # Model/timeout per role
  decomposition:# Planner settings
```

Performs environment variable substitution (`${VAR}`) + validation via Zod schema.

---

## Technology Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript (strict mode) |
| Build | tsc → dist/ |
| Agent Execution | Claude CLI (`claude -p`) via child_process.spawn |
| Task Queue | Linear SDK (@linear/sdk) |
| Communication | Discord.js 14 |
| Vector DB | LanceDB + Apache Arrow |
| Embeddings | Xenova/transformers (multilingual-e5-base, 768D) |
| Scheduling | Croner (cron parser) |
| Config Validation | Zod |
| Config Format | YAML |
| Linting | oxlint |
| Testing | Vitest |

---

## Known Issues & Improvement Areas

### ISSUE-1: Unstable Linear project → directory mapping

**Current implementation:**
1. `projectMapper.ts`: Scans ~/dev subdirectories + Levenshtein fuzzy matching (>=0.5)
2. `autonomousRunner.ts:resolveProjectPath()`: Tries mapper → direct path → lowercase path in order
3. `discordCore.ts`: Hard-coded `ISSUE_PREFIX_MAP` (`INT→OpenSwarm`, `STONKS→STONKS`, etc.)

**Problems:**
- Mapping logic is duplicated between `projectMapper` and `discord.ts` (managed separately in two places)
- `ISSUE_PREFIX_MAP` is hard-coded in discordCore.ts, requiring code changes for extension
- `projectMapper`'s Levenshtein 0.5 threshold is too low, creating potential for incorrect mapping
- `config.yaml`'s `allowedProjects` only has `~/dev/OpenSwarm` → missing entries for multi-project setups
- `projectAgents` config has `linearProjectId` but it's not utilized in actual mapping logic

**Recommended improvements:**
- Add explicit mapping table to `config.yaml`: `{ linearProjectName: localPath }`
- Convert `projectMapper` to config-based (fuzzy matching as fallback only)
- Remove hard-coded mapping from `discordCore.ts`, consolidate into shared module

### ISSUE-2: Agent reporting leaks

**Current implementation:**
- `saveCognitiveMemory()` calls are scattered across 5+ locations in `autonomousRunner.ts`:
  - On `executeTask()` success/failure
  - On `executeTaskPairMode()` success
  - In `scheduler.on('completed')` callback
  - Inside `reportExecutionResult()`
  - On `DecisionEngine.executeTask()` success/failure
- **Duplicate storage occurs**: Same task completion can be recorded 2-3 times in memory

**Memory leak patterns:**
1. **Unbounded growth**: Only `table.add()` with inefficient `cleanup`
   - `cleanupExpired()` finds expired records but doesn't actually delete them (Line 1243: logging only)
   - Background task (`applyMemoryDecay`) decays → archives but doesn't delete records
2. **reviseMemory/markContradiction/reconcileContradiction**: Recreates entire table (dropTable → createTable)
   - Searches with 10000 record limit → high memory usage
   - Possible race condition on concurrent access
3. **consolidateMemories()**: Also recreates entire table
4. **Embedding pipeline**: Xenova model runs on CPU without GPU → ~500MB resident memory
5. **LanceDB connection**: `db` and `table` are module-level singletons, not GC-eligible

**Recommended improvements:**
- Centralize memory storage into a unified function (currently scattered across 5+ call sites)
- Implement actual deletion logic in `cleanupExpired()` (or TTL-based LanceDB management)
- Use LanceDB's filter/delete API instead of full table recreation
- Schedule `runBackgroundCognition()` once daily (currently has no callers)
- Set memory total cap (current 10000 hard limit only applies to search)

### ISSUE-3: Legacy and new code coexistence

- `tmux.ts`: README describes tmux-based architecture, but actually transitioned to `spawn`-based (7a9dc51)
- `service.ts:runHeartbeat()`: Still uses tmux-based flow
- Both `autonomous mode` and `legacy heartbeat` execution paths coexist
- `models` (legacy) vs `defaultRoles` (new) configuration duplication

### ISSUE-4: Incomplete error handling

- Worker/Reviewer CLI execution truncates stderr to 500 characters
- `seenFailures` Set resets entirely when exceeding 1000 entries (no time-based cleanup)
- Async errors in `pairPipeline.ts` event handlers may be silently ignored

---

## File Structure

```
OpenSwarm/
├── src/
│   ├── index.ts              # Entry point
│   ├── core/                 # core/service.ts, config.ts, types.ts
│   ├── agents/               # worker, reviewer, tester, documenter, pairPipeline...
│   ├── orchestration/        # decisionEngine, workflow, workflowExecutor, taskParser...
│   ├── automation/           # autonomousRunner, runnerState, runnerExecution, scheduler, prProcessor
│   ├── memory/               # memoryCore, memoryOps, codex (LanceDB + Xenova)
│   ├── discord/              # discordCore, discordHandlers, discordPair
│   ├── linear/               # linear.ts, projectUpdater.ts (Linear SDK + PO agent)
│   ├── github/               # github.ts (CI monitoring via gh CLI)
│   ├── knowledge/            # Knowledge graph: scanner, analyzer, store, repository
│   ├── support/              # tmux, web, planner, projectMapper, timeWindow, ...
│   ├── __tests__/            # vitest test files
│   └── locale/               # i18n: en.ts, ko.ts, prompts/
│
├── config.yaml               # Main configuration
├── config.example.yaml       # Config template
├── docker-compose.yml        # Docker deployment
├── Dockerfile                # Container build
├── ARCHITECTURE.md           # This file
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
└── .claude/                  # Claude Code agent configs
    ├── agents/               # Specialized agent prompts
    └── settings.json         # MCP + permission settings
```

---

## Version History

| Commit | Description |
|--------|-------------|
| (current) | PO agent: projectUpdater rewrite with multi-signal health scoring + knowledge graph |
| 8518cf3 | SRP-based src/ layer hierarchy refactoring (flat 49 files → 9 domain dirs) |
| 48a35ea | TypeScript strict types + ESM import unification + locale i18n |
| 40c340b | Discord/Memory module separation (barrel re-export) |
| 38f8f71 | PR auto-improvement pipeline + interactive chat CLI |
| 60ff249 | Worker/Reviewer pair mode system implementation |
| 7a9dc51 | tmux pane → spawn-based execution transition |
| f3c4571 | Ollama → Xenova/transformers local embedding transition |
| 877cba2 | Decision Engine + scope constraints |
| 2433e7c | DAG-based workflow engine |

---

*Last updated: 2026-03-03*
