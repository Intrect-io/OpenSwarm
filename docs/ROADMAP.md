# OpenSwarm Roadmap

## CLI Adapter Architecture

OpenSwarm orchestrates autonomous coding agents through **CLI tool adapters**. Instead of managing API tokens, OAuth flows, or direct HTTP calls, OpenSwarm delegates execution to CLI tools that handle their own authentication.

### Design Philosophy

- **CLI-first**: Every agent backend is a CLI tool (e.g., `claude`, `codex`, `aider`)
- **No token management**: Each CLI tool manages its own auth (API keys, OAuth, session tokens)
- **Uniform interface**: All adapters implement `CliAdapter` — build command, parse output
- **Swap without rewiring**: Change the adapter in config, keep the same orchestration logic

### Security Model

OpenSwarm never touches API credentials directly. Each CLI tool is responsible for:
- Storing and refreshing tokens
- Authenticating with its respective API
- Managing permissions and rate limits

OpenSwarm only invokes the CLI binary, passes a prompt, and parses the output.

---

## Phases

### Phase 1 — Interface + Claude CLI Adapter (current)

- [x] Define `CliAdapter` interface (`src/adapters/types.ts`)
- [x] Extract shared spawn logic (`src/adapters/base.ts`)
- [x] Implement Claude CLI adapter (`src/adapters/claude.ts`)
- [x] Refactor `worker.ts` and `reviewer.ts` to use adapters
- [ ] Unit tests for adapter layer

### Phase 2 — Config-Driven Adapter Selection

- [ ] Add `adapter` field to `config.yaml` schema
- [ ] Per-agent adapter override (e.g., worker uses Claude, tester uses Codex)
- [ ] Migrate remaining agents: tester, documenter, auditor, skillDocumenter
- [ ] Adapter health check on startup (`isAvailable()`)

### Phase 3 — Additional CLI Adapters

- [ ] **Codex CLI** (`codex`) — OpenAI's coding agent
- [ ] **aider** (`aider`) — git-aware coding assistant (note: `managedGit: true`)
- [ ] **Goose** (`goose`) — Block's open-source coding agent
- [ ] Adapter capability negotiation (skip unsupported skills)

### Phase 4 — Advanced Features

- [ ] Multi-adapter pipelines (e.g., Claude writes, Codex reviews)
- [ ] Adapter performance benchmarking and auto-selection
- [ ] Fallback chains (if primary adapter fails, try secondary)

---

## Planned Adapters

| Adapter | CLI Binary | Auth Method | Streaming | JSON Output | Managed Git |
|---------|-----------|-------------|-----------|-------------|-------------|
| Claude CLI | `claude` | API key / OAuth | Yes | stream-json | No |
| Codex CLI | `codex` | API key | TBD | TBD | No |
| aider | `aider` | API key (various) | Yes | TBD | Yes |
| Goose | `goose` | API key | TBD | TBD | No |
