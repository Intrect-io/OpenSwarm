#!/usr/bin/env node
// ============================================
// OpenSwarm - Entry Point
// ============================================

// IPv6 ETIMEDOUT 방지: 외부 API(Linear SDK 등)에서 IPv6 우선 시도 → 타임아웃 문제 해결
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { loadConfig, validateConfig } from './core/config.js';
import { startService, stopService } from './core/service.js';

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════╗');
  console.log('║         🤖 OpenSwarm v0.1.0         ║');
  console.log('║   Autonomous Claude Code Orchestrator  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Load configuration
  const config = loadConfig();

  // Validate configuration
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error('Configuration errors:');
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
    console.error('');
    console.error('Please check config.json or environment variables.');
    process.exit(1);
  }

  console.log('Configuration loaded:');
  console.log(`  - Agents: ${config.agents.map((a) => a.name).join(', ')}`);
  console.log(`  - Default heartbeat: ${config.defaultHeartbeatInterval / 60000}min`);
  console.log('');

  // Signal handlers
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await stopService();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start service
  try {
    await startService(config);
    console.log('');
    console.log('OpenSwarm is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to start service:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
