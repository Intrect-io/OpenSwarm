#!/usr/bin/env tsx
/**
 * Create Linear issues for comprehensive unit test plan
 */
import { LinearClient } from '@linear/sdk';

const LINEAR_API_KEY = process.env.LINEAR_API_KEY!;
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID!;

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

interface TestIssue {
  title: string;
  description: string;
  priority: 0 | 1 | 2 | 3 | 4; // 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
  estimate: number; // story points
  labels: string[];
}

const testIssues: TestIssue[] = [
  // P0 - Critical Infrastructure
  {
    title: '[Test] Core Module - Unit Tests',
    priority: 2, // High
    estimate: 8,
    labels: ['test', 'p0', 'core'],
    description: `## Objective
Implement comprehensive unit tests for Core module (config, service, eventHub, traceCollector).

## Scope
- **config.ts**: Config loading, validation, environment parsing, schema validation, merge logic
- **service.ts**: Lifecycle management, initialization order, error handling, graceful shutdown
- **eventHub.ts**: Event emission/subscription, filtering, async handling, memory leak prevention
- **traceCollector.ts**: ✅ Already exists - review and enhance

## Acceptance Criteria
- [ ] config.ts: 90%+ coverage
- [ ] service.ts: 90%+ coverage
- [ ] eventHub.ts: 90%+ coverage
- [ ] traceCollector.test.ts: Enhanced with edge cases
- [ ] All tests pass in <2s
- [ ] Mock external dependencies (fs, process.env)

## Testing Patterns
\`\`\`typescript
// Example: config.test.ts
describe('config', () => {
  it('should load default config', () => {});
  it('should merge environment-specific config', () => {});
  it('should validate schema with Zod', () => {});
  it('should throw on invalid config', () => {});
});
\`\`\`

## Dependencies
- Vitest
- Config fixtures in \`src/__tests__/fixtures/\`

## Reference
See: docs/TEST_PLAN.md - P0 Core Module
`,
  },
  {
    title: '[Test] Orchestration Module - Unit Tests',
    priority: 2, // High
    estimate: 13,
    labels: ['test', 'p0', 'orchestration'],
    description: `## Objective
Implement comprehensive unit tests for Orchestration module (decisionEngine, taskScheduler, taskParser, workflow).

## Scope
- **decisionEngine.ts**: Task prioritization, agent selection, conflict resolution, resource allocation
- **taskScheduler.ts**: Queue management, priority scheduling, concurrency limits, timeout/retry
- **taskParser.ts**: Linear/Discord/GitHub parsing, metadata extraction
- **workflow.ts**: Worker-Reviewer pipeline, state transitions, error propagation, rollback

## Acceptance Criteria
- [ ] decisionEngine.ts: 90%+ coverage
- [ ] taskScheduler.ts: 90%+ coverage
- [ ] taskParser.ts: 90%+ coverage
- [ ] workflow.ts: 90%+ coverage
- [ ] All tests pass in <3s
- [ ] Mock external dependencies (Linear SDK, gh CLI)

## Key Test Cases
\`\`\`typescript
// decisionEngine
- Should prioritize CHANGES_REQUESTED PRs over conflicts
- Should select appropriate agent for task type
- Should handle resource exhaustion gracefully

// taskScheduler
- Should respect concurrent execution limits
- Should timeout stuck tasks
- Should retry failed tasks with exponential backoff

// taskParser
- Should parse Linear issue description
- Should extract PR context from GitHub
- Should handle malformed input

// workflow
- Should execute Worker → Reviewer pipeline
- Should rollback on Reviewer rejection
- Should propagate errors correctly
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P0 Orchestration Module
`,
  },

  // P1 - Agents
  {
    title: '[Test] Agents Module - Unit Tests',
    priority: 2, // High
    estimate: 13,
    labels: ['test', 'p1', 'agents'],
    description: `## Objective
Implement comprehensive unit tests for Agents module (agentPair, worker, reviewer, auditor, documenter, agentBus, cliStreamParser).

## Scope
- **agentPair.ts**: ✅ Exists - enhance
- **worker.ts**: ✅ Exists - enhance
- **reviewer.ts**: ✅ Exists - enhance
- **auditor.ts**: Quality checks, vulnerability detection, report generation
- **documenter.ts**: Doc generation, markdown formatting, code snippets
- **agentBus.ts**: Inter-agent messaging, routing, delivery guarantees
- **cliStreamParser.ts**: Claude CLI output parsing, tool use extraction, error detection

## Acceptance Criteria
- [ ] Enhance existing tests (agentPair, worker, reviewer)
- [ ] auditor.ts: 80%+ coverage
- [ ] documenter.ts: 80%+ coverage
- [ ] agentBus.ts: 80%+ coverage
- [ ] cliStreamParser.ts: 90%+ coverage (critical for parsing)
- [ ] All tests pass in <4s

## Key Test Cases
\`\`\`typescript
// cliStreamParser (CRITICAL)
- Should parse tool use blocks correctly
- Should extract error messages
- Should handle malformed JSON
- Should detect task completion

// auditor
- Should detect common anti-patterns
- Should flag security vulnerabilities
- Should generate structured reports

// agentBus
- Should route messages to correct agent
- Should handle delivery failures
- Should prevent message loops
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P1 Agents Module
`,
  },

  // P1 - Automation
  {
    title: '[Test] Automation Module - Unit Tests',
    priority: 2, // High
    estimate: 13,
    labels: ['test', 'p1', 'automation'],
    description: `## Objective
Implement comprehensive unit tests for Automation module (autonomousRunner, prProcessor, conflictResolver, ciWorker, longRunningMonitor, dailyReporter).

## Scope
- **autonomousRunner.ts**: Heartbeat, Linear fetching, state management, retry logic
- **prProcessor.ts**: PR detection, CI checking, review feedback, conflict detection
- **conflictResolver.ts**: Conflict detection, auto-resolution, cascade checking
- **ciWorker.ts**: CI monitoring, failure log extraction, notifications
- **longRunningMonitor.ts**: Timeout detection, stuck task identification
- **dailyReporter.ts**: Statistics aggregation, report formatting

## Acceptance Criteria
- [ ] autonomousRunner.ts: 80%+ coverage
- [ ] prProcessor.ts: 85%+ coverage (complex logic)
- [ ] conflictResolver.ts: 80%+ coverage
- [ ] ciWorker.ts: 80%+ coverage
- [ ] longRunningMonitor.ts: 75%+ coverage
- [ ] dailyReporter.ts: 70%+ coverage
- [ ] All tests pass in <5s

## Key Test Cases
\`\`\`typescript
// prProcessor (CRITICAL)
- Should detect PRs with review feedback
- Should bypass cooldown for conflicts
- Should retry on CI failure (max 3 attempts)
- Should handle formal reviews + comments
- Should process review feedback iteratively (max 5)

// conflictResolver
- Should detect merge conflicts
- Should attempt auto-resolution
- Should cascade to dependent PRs
- Should respect max attempts (3)

// autonomousRunner
- Should fetch Linear issues on schedule
- Should track task state (completed/failed)
- Should retry failed tasks
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P1 Automation Module
`,
  },

  // P1 - Memory
  {
    title: '[Test] Memory Module - Unit Tests',
    priority: 2, // High
    estimate: 8,
    labels: ['test', 'p1', 'memory'],
    description: `## Objective
Implement comprehensive unit tests for Memory module (memoryCore, memoryOps, codex, compaction).

## Scope
- **memoryCore.ts**: LanceDB init, vector embeddings, semantic search, compaction
- **memoryOps.ts**: CRUD operations, query optimization, index management
- **codex.ts**: Code context storage, retrieval relevance, duplicate detection
- **compaction.ts**: Old memory cleanup, statistics preservation, storage optimization

## Acceptance Criteria
- [ ] memoryCore.ts: 80%+ coverage
- [ ] memoryOps.ts: 85%+ coverage
- [ ] codex.ts: 75%+ coverage
- [ ] compaction.ts: 80%+ coverage
- [ ] All tests pass in <3s
- [ ] Use in-memory LanceDB for tests

## Key Test Cases
\`\`\`typescript
// memoryCore
- Should initialize LanceDB with schema
- Should generate embeddings with Xenova
- Should perform semantic search
- Should compact old memories (>30 days)

// memoryOps
- Should insert memory records
- Should query by similarity
- Should handle duplicate insertions
- Should cleanup on error

// codex
- Should store code context
- Should retrieve relevant context
- Should detect duplicate code blocks

// compaction
- Should remove old memories
- Should preserve aggregated statistics
- Should optimize storage size
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P1 Memory Module
`,
  },

  // P1 - Integration (GitHub)
  {
    title: '[Test] GitHub Integration - Unit Tests',
    priority: 2, // High
    estimate: 8,
    labels: ['test', 'p1', 'integration', 'github'],
    description: `## Objective
Implement comprehensive unit tests for GitHub integration (github.ts).

## Scope
- **github.ts**: PR listing, CI checks, review fetching, commenting, branch management, diff retrieval

## Acceptance Criteria
- [ ] github.ts: 85%+ coverage
- [ ] All tests pass in <2s
- [ ] Mock gh CLI with fixtures
- [ ] Test error handling (API failures, rate limits)

## Key Test Cases
\`\`\`typescript
// PR operations
- Should list open PRs with filters
- Should get PR details (title, author, branch)
- Should retrieve PR diff
- Should post comments to PR
- Should handle PR not found

// CI checks
- Should get check runs for PR
- Should detect failed checks
- Should extract failure logs
- Should handle pending checks

// Reviews
- Should fetch PR reviews
- Should get latest review per user
- Should detect CHANGES_REQUESTED
- Should handle no reviews

// Error handling
- Should retry on API failures (3x)
- Should handle rate limits
- Should parse gh CLI errors
\`\`\`

## Testing Strategy
\`\`\`typescript
// Mock gh CLI
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, cb) => {
    if (args.includes('pr') && args.includes('list')) {
      return cb(null, { stdout: fixtures.prList });
    }
    // ... more fixtures
  })
}));
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P1 GitHub Module
`,
  },

  // P1 - Integration (Linear)
  {
    title: '[Test] Linear Integration - Unit Tests',
    priority: 2, // High
    estimate: 8,
    labels: ['test', 'p1', 'integration', 'linear'],
    description: `## Objective
Implement comprehensive unit tests for Linear integration (linear.ts, projectUpdater.ts).

## Scope
- **linear.ts**: Issue querying, state transitions, comment additions, project mapping
- **projectUpdater.ts**: Project status sync, progress tracking, metadata updates

## Acceptance Criteria
- [ ] linear.ts: 85%+ coverage
- [ ] projectUpdater.ts: 80%+ coverage
- [ ] All tests pass in <2s
- [ ] Mock Linear SDK with fixtures

## Key Test Cases
\`\`\`typescript
// Issue operations
- Should query issues by state (Todo, In Progress)
- Should filter by assignee
- Should transition issue states
- Should add comments to issues
- Should handle issue not found

// Project mapping
- Should map Linear project to local directory
- Should handle unknown projects
- Should update project metadata

// projectUpdater
- Should sync project status
- Should track progress (completed/total)
- Should update project description
- Should handle API failures

// Error handling
- Should retry on API failures (3x)
- Should handle rate limits
- Should parse SDK errors
\`\`\`

## Testing Strategy
\`\`\`typescript
// Mock Linear SDK
vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn(() => ({
    issues: vi.fn(() => ({
      fetch: vi.fn(() => fixtures.issues)
    })),
    // ... more mocks
  }))
}));
\`\`\`

## Reference
See: docs/TEST_PLAN.md - P1 Linear Module
`,
  },

  // Infrastructure
  {
    title: '[Test] Test Infrastructure Setup',
    priority: 2, // High
    estimate: 5,
    labels: ['test', 'infrastructure', 'p0'],
    description: `## Objective
Set up comprehensive test infrastructure for OpenSwarm project.

## Scope
1. **Test Configuration**
   - Vitest config with coverage
   - Test helpers and utilities
   - Fixture management
   - Mock factories

2. **CI Integration**
   - GitHub Actions workflow
   - Coverage reporting
   - Coverage gates (80% for P0/P1)

3. **Developer Tools**
   - Test watch mode
   - Coverage UI
   - Test debugging

## Tasks
- [ ] Install dependencies: @vitest/coverage-v8, @vitest/ui
- [ ] Create vitest.config.ts with coverage settings
- [ ] Create test helpers in src/__tests__/helpers/
- [ ] Create fixtures in src/__tests__/fixtures/
- [ ] Create mock factories for common services
- [ ] Add GitHub Actions workflow (.github/workflows/test.yml)
- [ ] Configure coverage gates (codecov or similar)
- [ ] Update npm scripts for test commands
- [ ] Document testing guidelines in docs/TESTING.md

## File Structure
\`\`\`
src/
  __tests__/
    helpers/
      mockGitHub.ts       # GitHub CLI mock factory
      mockLinear.ts       # Linear SDK mock factory
      mockDiscord.ts      # Discord.js mock factory
      testConfig.ts       # Test config fixtures
      testEventHub.ts     # EventHub test utilities
    fixtures/
      github/
        pr-list.json
        pr-detail.json
        ci-checks.json
      linear/
        issues.json
        projects.json
      config/
        base.yaml
        test.yaml
    integration/          # Integration tests (future)
vitest.config.ts
.github/workflows/test.yml
docs/TESTING.md
\`\`\`

## Acceptance Criteria
- [ ] All dependencies installed
- [ ] Vitest config working with coverage
- [ ] Test helpers documented and usable
- [ ] CI workflow running on PR
- [ ] Coverage report generated
- [ ] Developer documentation complete

## Reference
See: docs/TEST_PLAN.md - Test Infrastructure
`,
  },

  // Epic for P2/P3
  {
    title: '[Epic] Additional Module Tests (P2/P3)',
    priority: 3, // Medium
    estimate: 21,
    labels: ['test', 'epic', 'p2', 'p3'],
    description: `## Objective
Track additional module tests for P2 and P3 priority modules.

## P2 Modules (Medium Priority)
- **Discord Module** (discordCore, discordHandlers, discordPair) - 5 points
- **Adapters Module** (claude, processRegistry, base) - 5 points
- **Support Module** (web, costTracker, chat, rollback, worktreeManager) - 8 points

## P3 Modules (Low Priority)
- **Knowledge Module** (graph, analyzer, repository) - 5 points
- **Locale Module** (i18n) - 3 points

## Total Estimate
26 story points (P2: 18, P3: 8)

## Schedule
- P2 modules: Sprint 4
- P3 modules: Sprint 5

## Notes
These modules are supporting features. Tests should focus on:
- Happy path coverage (70%+)
- Error handling
- Integration points

Detailed test plans will be created as separate issues when P0/P1 tests are complete.

## Reference
See: docs/TEST_PLAN.md - P2/P3 Modules
`,
  },
];

async function createIssues() {
  console.log('🚀 Creating Linear issues for OpenSwarm test plan...\n');

  // Get team
  const team = await client.team(LINEAR_TEAM_ID);
  const teamInfo = await team;
  console.log(`📋 Team: ${teamInfo.name}\n`);

  // Find OpenSwarm project
  const projects = await client.projects({ filter: { name: { contains: 'OpenSwarm' } } });
  const openswarmProject = projects.nodes.find(p => p.name.toLowerCase().includes('openswarm'));

  if (!openswarmProject) {
    console.error('❌ OpenSwarm project not found! Please create it first.');
    return;
  }

  console.log(`📦 Project: ${openswarmProject.name} (${openswarmProject.id})\n`);

  // Get or create labels
  const labelMap = new Map<string, string>();
  const labelNames = ['test', 'p0', 'p1', 'p2', 'p3', 'core', 'orchestration', 'agents', 'automation', 'memory', 'integration', 'github', 'linear', 'infrastructure', 'epic'];

  for (const labelName of labelNames) {
    try {
      const labels = await client.issueLabels({ filter: { name: { eq: labelName } } });
      const existing = labels.nodes[0];
      if (existing) {
        labelMap.set(labelName, existing.id);
      } else {
        // Create label
        const result = await client.createIssueLabel({
          name: labelName,
          teamId: LINEAR_TEAM_ID,
        });
        const label = await result.issueLabel;
        if (label) {
          labelMap.set(labelName, label.id);
        }
      }
    } catch (err) {
      console.warn(`⚠️  Could not create/fetch label ${labelName}:`, err);
    }
  }

  console.log(`✅ Labels ready: ${labelMap.size} labels\n`);

  // Create issues
  let created = 0;
  for (const issue of testIssues) {
    try {
      const labelIds = issue.labels
        .map(l => labelMap.get(l))
        .filter((id): id is string => !!id);

      const result = await client.createIssue({
        teamId: LINEAR_TEAM_ID,
        projectId: openswarmProject.id,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        estimate: issue.estimate,
        labelIds,
      });

      const createdIssue = await result.issue;
      if (createdIssue) {
        console.log(`✅ Created: ${createdIssue.identifier} - ${issue.title}`);
        created++;
      }
    } catch (err) {
      console.error(`❌ Failed to create issue "${issue.title}":`, err);
    }
  }

  console.log(`\n🎉 Done! Created ${created}/${testIssues.length} issues.`);
}

createIssues().catch(console.error);
