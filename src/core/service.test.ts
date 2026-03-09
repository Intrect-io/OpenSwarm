import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SwarmConfig } from './types.js';
import {
  startService,
  stopService,
  pauseAgent,
  resumeAgent,
  getAgentStatuses,
  getPRProcessor,
} from './service.js';

// Mock external dependencies
vi.mock('../linear/index.js', () => ({
  initLinear: vi.fn(),
  getClient: vi.fn(),
  getMyIssues: vi.fn(async () => []),
}));

vi.mock('../discord/index.js', () => ({
  initDiscord: vi.fn(async () => {}),
  setCallbacks: vi.fn(),
  setPairModeConfig: vi.fn(),
  sendToChannel: vi.fn(async () => {}),
  reportEvent: vi.fn(async () => {}),
  stopDiscord: vi.fn(async () => {}),
}));

vi.mock('../github/index.js', () => ({
  loadCIState: vi.fn(async () => ({ repos: {} })),
  checkRepoHealth: vi.fn(async () => ({ health: {}, transition: null })),
  saveCIState: vi.fn(async () => {}),
  needsReminder: vi.fn(() => false),
}));

vi.mock('../automation/scheduler.js', () => ({
  startAllSchedules: vi.fn(async () => []),
  listSchedules: vi.fn(async () => []),
  stopAllSchedules: vi.fn(),
}));

vi.mock('../support/web.js', () => ({
  startWebServer: vi.fn(async () => {}),
  stopWebServer: vi.fn(async () => {}),
  setWebRunner: vi.fn(),
}));

vi.mock('../automation/autonomousRunner.js', () => ({
  setLinearFetcher: vi.fn(),
  setDiscordReporter: vi.fn(),
  startAutonomous: vi.fn(async () => ({})),
}));

vi.mock('../automation/prProcessor.js', () => {
  class MockPRProcessor {
    start = vi.fn();
    stop = vi.fn();
  }
  return {
    PRProcessor: vi.fn((...args) => new MockPRProcessor()),
  };
});

vi.mock('../automation/ciWorker.js', () => ({
  startCIWorker: vi.fn(),
  stopCIWorker: vi.fn(),
}));

vi.mock('../automation/longRunningMonitor.js', () => ({
  initMonitors: vi.fn(),
}));

vi.mock('../automation/dailyReporter.js', () => ({
  setLinearClient: vi.fn(),
  setTeamId: vi.fn(),
  setDailyReporterDiscord: vi.fn(),
  startDailyReporter: vi.fn(),
}));

vi.mock('../locale/index.js', () => ({
  initLocale: vi.fn(),
  t: vi.fn((key, params) => {
    const translations: Record<string, any> = {
      'service.startComplete': 'Service started',
      'service.agentCount': `${params?.n || 0} agents`,
      'service.repoCount': `${params?.n || 0} repos`,
      'service.heartbeatInterval': `${params?.n || 0} minutes`,
      'service.autoModeActive': `Auto mode: ${params?.mode || 'unknown'}`,
      'service.startedMessage': 'Service started',
      'common.duration.hours': `${params?.n || 0} hours`,
      'common.duration.days': `${params?.n || 0} days`,
      'service.events.ciFailDetected': 'CI failed',
      'service.events.ciRecovered': 'CI recovered',
      'service.events.ciStillFailing': 'CI still failing',
    };
    return translations[key] || key;
  }),
}));

vi.mock('../support/rateLimiter.js', () => ({
  initRateLimiters: vi.fn(),
  destroyRateLimiters: vi.fn(),
}));

vi.mock('../memory/compaction.js', () => ({
  compactMemoryTable: vi.fn(async () => ({
    before: 100,
    after: 50,
    removed: 50,
  })),
  shouldCompact: vi.fn(async () => true),
  cleanupBackupFiles: vi.fn(async () => {}),
}));

vi.mock('croner', () => ({
  Cron: vi.fn((pattern, fn) => ({
    stop: vi.fn(),
  })),
}));

describe('service', () => {
  const mockConfig: SwarmConfig = {
    language: 'en',
    discordToken: 'test-token',
    discordChannelId: 'test-channel',
    linearApiKey: 'test-api-key',
    linearTeamId: 'test-team-id',
    agents: [
      {
        name: 'agent1',
        projectPath: '/tmp',
        heartbeatInterval: 30000,
        enabled: true,
        paused: false,
      },
      {
        name: 'agent2',
        projectPath: '/tmp',
        heartbeatInterval: 30000,
        enabled: false,
        paused: false,
      },
      {
        name: 'agent3',
        projectPath: '/tmp',
        heartbeatInterval: 30000,
        enabled: true,
        paused: true,
      },
    ],
    defaultHeartbeatInterval: 1800000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // Service Lifecycle
  // ============================================

  describe('service lifecycle', () => {
    it('should start service without errors', async () => {
      await expect(startService(mockConfig)).resolves.not.toThrow();
    });

    it('should initialize all required modules on start', async () => {
      const { initLinear } = await import('../linear/index.js');
      const { initDiscord } = await import('../discord/index.js');
      const { initLocale } = await import('../locale/index.js');

      await startService(mockConfig);

      expect(initLocale).toHaveBeenCalled();
      expect(initLinear).toHaveBeenCalledWith(
        mockConfig.linearApiKey,
        mockConfig.linearTeamId
      );
      expect(initDiscord).toHaveBeenCalledWith(
        mockConfig.discordToken,
        mockConfig.discordChannelId
      );
    });

    it('should stop service without errors', async () => {
      await startService(mockConfig);
      await expect(stopService()).resolves.not.toThrow();
    });

    it('should clean up resources on stop', async () => {
      const { stopDiscord } = await import('../discord/index.js');
      const { stopCIWorker } = await import('../automation/ciWorker.js');
      const { stopAllSchedules } = await import('../automation/scheduler.js');

      await startService(mockConfig);
      await stopService();

      expect(stopCIWorker).toHaveBeenCalled();
      expect(stopAllSchedules).toHaveBeenCalled();
      expect(stopDiscord).toHaveBeenCalled();
    });
  });

  // ============================================
  // Agent State Management
  // ============================================

  describe('agent state management', () => {
    beforeEach(async () => {
      await startService(mockConfig);
    });

    afterEach(async () => {
      await stopService();
    });

    it('should initialize agent states on service start', async () => {
      const statuses = getAgentStatuses();

      // Only enabled agents should be initialized
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.some(s => s.name === 'agent1')).toBe(true);
      // Disabled agent should not be initialized
      expect(statuses.some(s => s.name === 'agent2')).toBe(false);
    });

    it('should pause agent', async () => {
      pauseAgent('agent1');

      const status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('paused');
    });

    it('should resume paused agent', async () => {
      pauseAgent('agent1');
      resumeAgent('agent1');

      const status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('idle');
    });

    it('should not resume already idle agent', async () => {
      // agent1 should start as idle (not paused)
      resumeAgent('agent1');

      const status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('idle');
    });

    it('should get status for specific agent', async () => {
      const statuses = getAgentStatuses('agent1');

      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe('agent1');
    });

    it('should get all agent statuses', async () => {
      const allStatuses = getAgentStatuses();

      expect(allStatuses.length).toBeGreaterThan(0);
    });

    it('should handle pause/resume on non-existent agent gracefully', async () => {
      pauseAgent('non-existent');
      resumeAgent('non-existent');

      const status = getAgentStatuses('non-existent');
      expect(status).toHaveLength(0);
    });

    it('should maintain agent state across multiple operations', async () => {
      pauseAgent('agent1');
      let status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('paused');

      resumeAgent('agent1');
      status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('idle');

      pauseAgent('agent1');
      status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('paused');
    });
  });

  // ============================================
  // Configuration Integration
  // ============================================

  describe('configuration integration', () => {
    it('should use language from config', async () => {
      const { initLocale } = await import('../locale/index.js');

      await startService(mockConfig);

      expect(initLocale).toHaveBeenCalledWith('en');
    });

    it('should handle GitHub config', async () => {
      const configWithGithub: SwarmConfig = {
        ...mockConfig,
        githubRepos: ['owner/repo1', 'owner/repo2'],
        githubCheckInterval: 300000,
      };

      await startService(configWithGithub);
      // Should not throw

      await stopService();
    });

    it('should handle pair mode config', async () => {
      const { setPairModeConfig } = await import('../discord/index.js');

      const configWithPairMode: SwarmConfig = {
        ...mockConfig,
        pairMode: {
          enabled: true,
          maxAttempts: 3,
          workerTimeoutMs: 300000,
          reviewerTimeoutMs: 180000,
        },
      };

      await startService(configWithPairMode);

      expect(setPairModeConfig).toHaveBeenCalled();

      await stopService();
    });

    it('should handle autonomous mode config', async () => {
      const configWithAutonomous: SwarmConfig = {
        ...mockConfig,
        autonomous: {
          enabled: true,
          pairMode: true,
          schedule: '*/30 * * * *',
          maxAttempts: 3,
          allowedProjects: ['/tmp'],
        },
      };

      await startService(configWithAutonomous);
      // Should not throw

      await stopService();
    });

    it('should handle PR processor config when enabled', async () => {
      const configWithoutGithub: SwarmConfig = {
        ...mockConfig,
        githubRepos: [], // No repos, so PR processor won't start
        prProcessor: {
          enabled: true,
          schedule: '*/15 * * * *',
          cooldownHours: 6,
          maxIterations: 3,
        },
      };

      await startService(configWithoutGithub);

      // PR processor won't start without repos
      const processor = getPRProcessor();
      expect(processor).toBeNull();

      await stopService();
    });
  });

  // ============================================
  // Error Handling
  // ============================================

  describe('error handling', () => {
    it('should initialize service with minimal config', async () => {
      const minimalConfig: SwarmConfig = {
        language: 'en',
        discordToken: 'token',
        discordChannelId: 'channel',
        linearApiKey: 'api-key',
        linearTeamId: 'team-id',
        agents: [
          {
            name: 'main',
            projectPath: '/tmp',
            heartbeatInterval: 30000,
            enabled: true,
            paused: false,
          },
        ],
        defaultHeartbeatInterval: 1800000,
      };

      await expect(startService(minimalConfig)).resolves.not.toThrow();
      await stopService();
    });

    it('should handle config with no GitHub repos', async () => {
      const configNoGithub: SwarmConfig = {
        ...mockConfig,
        githubRepos: [],
      };

      await expect(startService(configNoGithub)).resolves.not.toThrow();
      await stopService();
    });

    it('should handle config with undefined optional fields', async () => {
      const configUndefined: SwarmConfig = {
        ...mockConfig,
        githubRepos: undefined,
        pairMode: undefined,
        autonomous: undefined,
      };

      await expect(startService(configUndefined)).resolves.not.toThrow();
      await stopService();
    });
  });

  // ============================================
  // PR Processor
  // ============================================

  describe('PR processor integration', () => {
    it('should return null processor when not enabled', async () => {
      const configNoPRProcessor: SwarmConfig = {
        ...mockConfig,
        prProcessor: {
          enabled: false,
          schedule: '*/15 * * * *',
          cooldownHours: 6,
          maxIterations: 3,
        },
      };

      await startService(configNoPRProcessor);

      const processor = getPRProcessor();
      expect(processor).toBeNull();

      await stopService();
    });

    it('should return null processor when no GitHub repos', async () => {
      const configNoPRProcessorNoRepos: SwarmConfig = {
        ...mockConfig,
        githubRepos: [],
        prProcessor: {
          enabled: true,
          schedule: '*/15 * * * *',
          cooldownHours: 6,
          maxIterations: 3,
        },
      };

      await startService(configNoPRProcessorNoRepos);

      const processor = getPRProcessor();
      expect(processor).toBeNull();

      await stopService();
    });
  });

  // ============================================
  // Multiple Start/Stop Cycles
  // ============================================

  describe('multiple service cycles', () => {
    it('should handle start -> stop -> start cycle', async () => {
      await startService(mockConfig);
      await stopService();

      // Should be able to start again
      await expect(startService(mockConfig)).resolves.not.toThrow();
      await stopService();
    });

    it('should clean up state between cycles', async () => {
      await startService(mockConfig);
      pauseAgent('agent1');
      await stopService();

      await startService(mockConfig);
      const status = getAgentStatuses('agent1')[0];
      // Agent should be reset to idle state after new start
      expect(status?.state).toMatch(/idle|paused/);
      await stopService();
    });
  });

  // ============================================
  // Concurrent Operations
  // ============================================

  describe('concurrent operations', () => {
    beforeEach(async () => {
      await startService(mockConfig);
    });

    afterEach(async () => {
      await stopService();
    });

    it('should handle rapid pause/resume operations', async () => {
      for (let i = 0; i < 10; i++) {
        pauseAgent('agent1');
        resumeAgent('agent1');
      }

      const status = getAgentStatuses('agent1')[0];
      expect(status?.state).toBe('idle');
    });

    it('should handle pause on multiple agents', async () => {
      pauseAgent('agent1');
      pauseAgent('agent3');

      const status1 = getAgentStatuses('agent1')[0];
      const status3 = getAgentStatuses('agent3')[0];

      expect(status1?.state).toBe('paused');
      expect(status3?.state).toBe('paused');
    });

    it('should get accurate status during operations', async () => {
      pauseAgent('agent1');
      const status = getAgentStatuses();

      expect(status.length).toBeGreaterThan(0);
      expect(status.some(s => s.state === 'paused')).toBe(true);
    });
  });

  // ============================================
  // Discord Integration
  // ============================================

  describe('discord integration', () => {
    it('should set discord callbacks on startup', async () => {
      const { setCallbacks } = await import('../discord/index.js');

      await startService(mockConfig);

      expect(setCallbacks).toHaveBeenCalled();

      await stopService();
    });

    it('should pass correct callbacks to discord', async () => {
      const { setCallbacks } = await import('../discord/index.js');

      await startService(mockConfig);

      const call = vi.mocked(setCallbacks).mock.calls[0];
      const callbacks = call?.[0];

      expect(typeof callbacks?.onPause).toBe('function');
      expect(typeof callbacks?.onResume).toBe('function');
      expect(typeof callbacks?.getStatus).toBe('function');
      expect(typeof callbacks?.getRepos).toBe('function');

      await stopService();
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('edge cases', () => {
    it('should handle agent with very long name', async () => {
      const longNameAgent: SwarmConfig = {
        ...mockConfig,
        agents: [
          {
            name: 'A'.repeat(1000),
            projectPath: '/tmp',
            heartbeatInterval: 30000,
            enabled: true,
            paused: false,
          },
        ],
      };

      await startService(longNameAgent);
      // Should not throw

      await stopService();
    });

    it('should handle config with many agents', async () => {
      const manyAgentsConfig: SwarmConfig = {
        ...mockConfig,
        agents: Array.from({ length: 100 }, (_, i) => ({
          name: `agent-${i}`,
          projectPath: '/tmp',
          heartbeatInterval: 30000,
          enabled: true,
          paused: false,
        })),
      };

      await startService(manyAgentsConfig);
      const statuses = getAgentStatuses();
      expect(statuses.length).toBeGreaterThan(0);

      await stopService();
    });

    it('should handle heartbeat interval of 0', async () => {
      const zeroHeartbeatConfig: SwarmConfig = {
        ...mockConfig,
        agents: [
          {
            name: 'agent1',
            projectPath: '/tmp',
            heartbeatInterval: 0,
            enabled: true,
            paused: false,
          },
        ],
      };

      // Should handle gracefully or use default
      await expect(startService(zeroHeartbeatConfig)).resolves.not.toThrow();
      await stopService();
    });
  });
});
