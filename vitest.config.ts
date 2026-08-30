import { defineConfig } from 'vitest/config';

const integrationBoundaryCoverageExcludes = [
  // External model/provider adapters and process wrappers are covered by smoke/e2e tests.
  'src/adapters/agenticLoop.ts',
  'src/adapters/base.ts',
  'src/adapters/claude.ts',
  'src/adapters/codex.ts',
  'src/adapters/codexResponses.ts',
  'src/adapters/envPath.ts',
  'src/adapters/gpt.ts',
  'src/adapters/index.ts',
  'src/adapters/local.ts',
  'src/adapters/openrouter.ts',
  'src/adapters/processRegistry.ts',
  'src/adapters/resultParsing.ts',
  'src/adapters/webTools.ts',
  'src/adapters/chatStream.ts',
  'src/adapters/codexModels.ts',
  'src/adapters/lmstudio.ts',
  'src/adapters/tools.ts',

  // Linux namespace/mount + Unix-socket companion boundary. Its protocol,
  // parsing, path, secret-mask, Git, lifecycle, and deployment contracts remain
  // unit-tested, while the effectful backend is proven by the fail-closed
  // startup probe inside the production companion (including concurrent
  // loopback-only netns) and a real AppArmor canary. Counting unreachable
  // macOS/ordinary-CI mount and socket branches as unit coverage would reward
  // mocks instead of the kernel boundary that matters.
  'src/cli/sandboxExecutorCommand.ts',
  'src/sandboxExecutor/bubblewrap.ts',
  'src/sandboxExecutor/client.ts',
  'src/sandboxExecutor/entrypoint.ts',
  'src/sandboxExecutor/server.ts',

  // Agent roles that shell out to providers or depend on full workflow integration.
  'src/agents/auditor.ts',
  'src/agents/cliStreamParser.ts',
  'src/agents/documenter.ts',
  'src/agents/pairMetrics.ts',
  'src/agents/pairWebhook.ts',
  'src/agents/reviewer.ts',
  'src/agents/worker.ts',
  'src/agents/agentBus.ts',
  'src/agents/agentPair.ts',
  'src/automation/runnerState.ts',

  // OAuth, service, CLI, and external issue/graph/memory persistence boundaries.
  'src/auth/oauthPkce.ts',
  'src/auth/oauthStore.ts',
  'src/auth/openrouterPkce.ts',
  'src/auth/linearPkce.ts',
  'src/auth/openBrowser.ts',
  'src/automation/taskSource.ts',
  'src/cli/initWizard.ts',
  // Self-documented effectful boundary (own header: "this file is the effectful
  // boundary" — ink render + readline + execFileSync + fs); orchestration lives
  // in the already-tested reviewAudit.ts.
  'src/cli/reviewMaxCommand.tsx',
  'src/core/envFile.ts',
  'src/core/service.ts',
  'src/core/config.ts',
  'src/core/eventHub.ts',
  'src/issues/graphql/resolvers.ts',
  'src/issues/graphql/server.ts',
  'src/issues/linearBridge.ts',
  'src/issues/memoryBridge.ts',
  'src/issues/sqliteStore.ts',
  'src/knowledge/analyzer.ts',
  'src/knowledge/gitInfo.ts',
  'src/knowledge/graph.ts',
  'src/knowledge/graphqlExporter.ts',
  'src/knowledge/index.ts',
  'src/knowledge/repository.ts',
  'src/knowledge/scanner.ts',
  'src/knowledge/store.ts',
  'src/linear/linear.ts',
  'src/linear/projectUpdater.ts',
  'src/locale/index.ts',
  'src/locale/prompts/en.ts',
  'src/locale/prompts/ko.ts',
  'src/mcp/mcpClient.ts',
  'src/notify/notifier.ts',
  'src/memory/codex.ts',
  'src/memory/compaction.ts',
  'src/memory/memoryCore.ts',
  'src/memory/memoryOps.ts',
  'src/registry/bsDetector.ts',
  'src/registry/graphql/resolvers.ts',
  'src/registry/memoryBridge.ts',
  'src/registry/sqliteStore.ts',
  'src/support/costTracker.ts',
  'src/support/gitTracker.ts',
  'src/support/planner.ts',
  'src/support/projectMapper.ts',
  'src/support/promptHelper.ts',
  'src/support/planCommand.ts',
  'src/support/chatSession.ts',
  'src/support/rateLimiter.ts',
  'src/support/repoMetadata.ts',
  'src/support/timeWindow.ts',
  'src/support/web.ts',
  'src/support/dev.ts',
  'src/support/chatBackend.ts',
  'src/support/gitStatus.ts',
  'src/github/github.ts',
  'src/discord/discordCore.ts',
  'src/discord/discordHandlers.ts',
  'src/discord/discordPair.ts',
  'src/taskState/store.ts',

  // Ink TUI boundaries — alt-screen entry, network SSE, and effect hooks
  // (real TTY / sockets); the pure parser+reducer carry the tested logic. EPIC INT-1813.
  'src/tui/index.tsx',
  'src/tui/sse.ts',
  'src/tui/hooks/usePipelineEvents.ts',
  'src/tui/hooks/useTerminalSize.ts',
  'src/tui/components/WorkingIndicator.tsx',
  'src/tui/panels/ChatPanel.tsx',
  'src/tui/monitorApi.ts',
  'src/tui/hooks/useMonitor.ts',
  'src/tui/panels/MonitorPanel.tsx',
  'src/tui/panels/LogsPanel.tsx',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.test.tsx', ...integrationBoundaryCoverageExcludes],
      // Ratcheted from the aspirational (and previously unenforced — CI never
      // passed --coverage, so this 100% target was dead config) 100% down to a
      // real floor a few points below the measured baseline (lines 92.95% /
      // statements 91.89% / functions 92.04% / branches 83.75% as of this
      // ratchet). Raise these as coverage improves; never lower them.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 80,
      },
    },
  },
});
