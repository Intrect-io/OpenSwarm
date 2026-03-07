# OpenSwarm Comprehensive Unit Test Plan

## Overview
- **Total Source Files**: 99 TypeScript files
- **Current Test Coverage**: 5 test files (~5%)
- **Testing Framework**: Vitest
- **Target Coverage**: 80%+ for critical modules

---

## Test Priority Matrix

### P0 - Critical (Core System)
Core system functionality that must be tested first.

#### 1. Core Module (`src/core/`)
- **config.ts** (P0)
  - Config loading and validation
  - Environment variable parsing
  - Schema validation with Zod
  - Default value handling
  - Config merge logic (base + environment specific)

- **service.ts** (P0)
  - Service lifecycle management
  - Component initialization order
  - Error handling during startup
  - Graceful shutdown
  - Resource cleanup

- **eventHub.ts** (P0)
  - Event emission and subscription
  - Event filtering
  - Async event handling
  - Memory leak prevention
  - Error isolation between handlers

- **traceCollector.ts** (P0) ✅ EXISTING
  - Trace collection logic
  - Trace storage and retrieval
  - Performance metrics

#### 2. Orchestration Module (`src/orchestration/`)
- **decisionEngine.ts** (P0)
  - Task source prioritization
  - Agent selection logic
  - Conflict resolution decisions
  - Resource allocation

- **taskScheduler.ts** (P0)
  - Task queue management
  - Priority-based scheduling
  - Concurrent execution limits
  - Task timeout handling
  - Retry logic

- **taskParser.ts** (P0)
  - Linear issue parsing
  - Discord command parsing
  - GitHub PR context parsing
  - Task metadata extraction

- **workflow.ts** (P0)
  - Worker-Reviewer pipeline
  - State transitions
  - Error propagation
  - Rollback mechanisms

---

### P1 - High Priority (Core Features)

#### 3. Agents Module (`src/agents/`)
- **agentPair.ts** (P1) ✅ EXISTING
  - Pair creation and management
  - Communication protocol
  - State synchronization

- **worker.ts** (P1) ✅ EXISTING
  - Task execution
  - Code generation
  - Error recovery

- **reviewer.ts** (P1) ✅ EXISTING
  - Code review logic
  - Approval/rejection criteria
  - Feedback generation

- **auditor.ts** (P1)
  - Code quality checks
  - Security vulnerability detection
  - Pattern matching
  - Report generation

- **documenter.ts** (P1)
  - Documentation generation
  - Markdown formatting
  - Code snippet extraction

- **agentBus.ts** (P1)
  - Inter-agent messaging
  - Message routing
  - Delivery guarantees

- **cliStreamParser.ts** (P1)
  - Claude CLI output parsing
  - Tool use extraction
  - Error detection

#### 4. Automation Module (`src/automation/`)
- **autonomousRunner.ts** (P1)
  - Heartbeat scheduling
  - Linear issue fetching
  - Task state management
  - Retry logic
  - Failure tracking

- **prProcessor.ts** (P1)
  - PR detection and processing
  - CI status checking
  - Review feedback handling
  - Conflict detection
  - Auto-retry on CI failure

- **conflictResolver.ts** (P1)
  - Git conflict detection
  - Auto-resolution strategies
  - Cascade checking
  - Attempt tracking

- **ciWorker.ts** (P1)
  - CI status monitoring
  - Failure log extraction
  - Notification delivery

- **longRunningMonitor.ts** (P1)
  - Task timeout detection
  - Stuck task identification
  - Auto-intervention triggers

- **dailyReporter.ts** (P1)
  - Statistics aggregation
  - Report formatting
  - Delivery scheduling

#### 5. Memory Module (`src/memory/`)
- **memoryCore.ts** (P1)
  - LanceDB initialization
  - Vector embedding generation
  - Semantic search
  - Memory compaction

- **memoryOps.ts** (P1)
  - CRUD operations
  - Query optimization
  - Index management

- **codex.ts** (P1)
  - Code context storage
  - Retrieval relevance
  - Duplicate detection

- **compaction.ts** (P1)
  - Old memory cleanup
  - Statistics preservation
  - Storage optimization

#### 6. Integration Modules

##### GitHub (`src/github/`)
- **github.ts** (P1)
  - PR listing and filtering
  - CI check retrieval
  - Review fetching
  - Comment posting
  - Branch management
  - Diff retrieval

##### Linear (`src/linear/`)
- **linear.ts** (P1)
  - Issue querying
  - State transitions
  - Comment additions
  - Project mapping

- **projectUpdater.ts** (P1)
  - Project status sync
  - Progress tracking
  - Metadata updates

---

### P2 - Medium Priority (Supporting Features)

#### 7. Discord Module (`src/discord/`)
- **discordCore.ts** (P2)
  - Bot initialization
  - Connection management
  - Event handling

- **discordHandlers.ts** (P2)
  - Command parsing
  - Message formatting
  - Error responses
  - Embed generation

- **discordPair.ts** (P2)
  - Pair mode commands
  - Context management
  - User session tracking

#### 8. Adapters Module (`src/adapters/`)
- **claude.ts** (P2)
  - Claude CLI invocation
  - Stream handling
  - Error parsing
  - Token tracking

- **processRegistry.ts** (P2)
  - Process tracking
  - Cleanup on exit
  - Resource monitoring

- **base.ts** (P2)
  - Base adapter interface
  - Common utilities
  - Error handling

#### 9. Support Module (`src/support/`)
- **web.ts** (P2)
  - Dashboard server
  - SSE event streaming
  - API endpoints
  - Health checks

- **costTracker.ts** (P2)
  - Token counting
  - Cost calculation
  - Budget tracking

- **chat.ts** (P2)
  - Chat interface
  - Message history
  - Context management

- **rollback.ts** (P2)
  - State restoration
  - Git reset logic
  - Safety checks

- **worktreeManager.ts** (P2)
  - Worktree creation
  - Cleanup
  - Isolation

---

### P3 - Low Priority (Optional Features)

#### 10. Knowledge Module (`src/knowledge/`)
- **graph.ts** (P3)
  - Graph construction
  - Relationship mapping
  - Query traversal

- **analyzer.ts** (P3)
  - Code analysis
  - Pattern detection
  - Metrics calculation

- **repository.ts** (P3)
  - Repo metadata
  - File indexing

#### 11. Locale Module (`src/locale/`)
- **index.ts** (P3)
  - Translation loading
  - Language switching
  - Fallback handling

---

## Test Coverage Goals

| Priority | Modules | Target Coverage | Timeline |
|----------|---------|----------------|----------|
| P0 | Core, Orchestration | 90%+ | Sprint 1 |
| P1 | Agents, Automation, Memory, Integrations | 80%+ | Sprint 2-3 |
| P2 | Discord, Adapters, Support | 70%+ | Sprint 4 |
| P3 | Knowledge, Locale | 60%+ | Sprint 5 |

---

## Test Types

### Unit Tests
- Individual function/method testing
- Mocked dependencies
- Fast execution (<100ms per test)

### Integration Tests
- Module interaction testing
- Real dependencies where feasible
- Slower execution acceptable

### E2E Tests (Future)
- Full workflow testing
- Real GitHub/Linear/Discord
- Manual trigger only

---

## Testing Patterns

### Mock Strategy
```typescript
// External services: Always mock
- GitHub API → gh CLI mock
- Linear API → Linear SDK mock
- Discord API → discord.js mock
- Claude CLI → process mock

// Internal services: Inject or spy
- EventHub → real instance with spy
- Config → test fixtures
- Memory → in-memory DB or fixture
```

### File Organization
```
src/
  core/
    config.ts
    config.test.ts       ← co-located with source
  __tests__/
    integration/          ← integration tests
    fixtures/             ← test data
    helpers/              ← test utilities
```

---

## CI Integration

### Pre-commit
- Lint (oxlint)
- Type check (tsc)
- Fast unit tests (<10s)

### PR Checks
- All unit tests
- Coverage report
- No coverage regression

### Post-merge
- Integration tests
- Performance benchmarks

---

## Dependencies for Testing

```json
{
  "devDependencies": {
    "vitest": "^4.0.18",          // ✅ Existing
    "@vitest/coverage-v8": "^4.0", // Coverage
    "@vitest/ui": "^4.0",          // UI dashboard
    "msw": "^2.0",                 // HTTP mocking
    "testcontainers": "^10.0"      // Docker for integration tests (optional)
  }
}
```

---

## Success Metrics

1. **Coverage**: >80% line coverage for P0/P1 modules
2. **Speed**: Unit test suite <30s
3. **Reliability**: <1% flaky test rate
4. **Maintainability**: Tests serve as documentation

---

## Next Steps

1. Create Linear issues for each module (grouped by priority)
2. Set up test infrastructure (mocks, fixtures, helpers)
3. Implement P0 tests first (Core + Orchestration)
4. Establish CI pipeline with coverage gates
5. Iterate through P1-P3 in subsequent sprints
