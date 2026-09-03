#!/usr/bin/env node
// ============================================
// OpenSwarm - Entry Point
// ============================================

// Prevent IPv6 ETIMEDOUT: external APIs (Linear SDK etc.) try IPv6 first → causes timeout
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Load .env before anything else — config.yaml uses ${LINEAR_API_KEY} etc.
// and would otherwise silently disable integrations when the daemon is
// launched from a non-interactive shell without those vars exported.
import { formatShadowWarning, loadEnvFile } from './core/envFile.js';
const envLoad = loadEnvFile();
if (envLoad.paths.length > 0) {
  console.log(`Loaded env from: ${envLoad.paths.join(', ')} (${envLoad.loadedKeys.length} keys)`);
}
for (const shadowed of envLoad.shadowedKeys) console.warn(formatShadowWarning(shadowed));

// Strip Claude Code session markers so child processes (worker, planner) can launch Claude CLI
// Without this, running the service from inside a Claude Code session blocks all CLI spawns.
delete process.env['CLAUDECODE'];
delete process.env['CLAUDE_CODE_ENTRYPOINT'];

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './core/config.js';
import { startService, stopService } from './core/service.js';
import { DAEMON_PATHS } from './cli/daemon.js';
import { cleanupDaemonPid, createShutdownHandler } from './core/daemonLifecycle.js';

// index.js lives at <pkg>/dist/index.js → package.json is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

async function main(): Promise<void> {
  // Render a fixed-width banner (41 chars inside the box) with the current version.
  const title = `🤖 OpenSwarm v${VERSION}`;
  const INNER_WIDTH = 40;
  // '🤖' counts as 2 display columns in most terminals, so pad assuming width = length + 1.
  const visualLen = title.length + 1;
  const padTotal = Math.max(0, INNER_WIDTH - visualLen);
  const padLeft = Math.floor(padTotal / 2);
  const padRight = padTotal - padLeft;
  console.log('╔════════════════════════════════════════╗');
  console.log(`║${' '.repeat(padLeft)}${title}${' '.repeat(padRight)}║`);
  console.log('║   Autonomous Claude Code Orchestrator  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Load configuration
  const config = loadConfig();

  // Apply the telemetry opt-out from config for this daemon process (the detached
  // daemon runs index.js directly, bypassing the CLI hook). (INT-1992)
  const { initTelemetry } = await import('./telemetry/telemetry.js');
  initTelemetry({ version: VERSION, enabled: config.telemetry?.enabled });

  // Validate configuration
  const validation = validateConfig(config);

  // Non-fatal warnings (e.g. an agent's project path is missing): surface them
  // and drop those agents so the runner doesn't choke, but keep the daemon up
  // so the web/monitor API (port 3847) stays available.
  if (validation.warnings.length > 0) {
    console.warn('Configuration warnings:');
    for (const warning of validation.warnings) {
      console.warn(`  - ${warning}`);
    }
    config.agents = config.agents.filter((a) => existsSync(a.projectPath));
    console.warn('');
  }

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
  const isDaemon = process.env.OPENSWARM_DAEMON === '1';
  const shutdown = createShutdownHandler({
    isDaemon,
    pidFile: DAEMON_PATHS.PID_FILE,
    stop: stopService,
    exit: (code) => process.exit(code),
    log: (message, error) => error === undefined ? console.log(message) : console.error(message, error),
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start service
  try {
    await startService(config);
    console.log('');
    console.log('OpenSwarm is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to start service:', err);
    cleanupDaemonPid(isDaemon, DAEMON_PATHS.PID_FILE);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  cleanupDaemonPid(process.env.OPENSWARM_DAEMON === '1', DAEMON_PATHS.PID_FILE);
  process.exit(1);
});
