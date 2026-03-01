#!/usr/bin/env node
// ============================================
// OpenSwarm - CLI Entry Point
// `openswarm run`, `openswarm init`, `openswarm validate`, `openswarm chat`, `openswarm start`
// ============================================

import { Command } from 'commander';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './runners/cliRunner.js';
import { loadConfig, validateConfig, generateSampleConfig } from './core/config.js';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('openswarm')
  .description('Autonomous Claude Code agents orchestrator')
  .version(VERSION);

// ============================================
// openswarm run <task>
// ============================================

program
  .command('run')
  .description('Run a task through the agent pipeline (no config.yaml needed)')
  .argument('<task>', 'Task description to execute')
  .option('-p, --path <path>', 'Project path (default: current directory)')
  .option('-m, --model <model>', 'Model override for worker agent')
  .option('--pipeline', 'Full pipeline: worker + reviewer + tester + documenter')
  .option('--worker-only', 'Worker only, no review')
  .option('--max-iterations <n>', 'Max retry iterations', parseInt)
  .action(async (task: string, opts: {
    path?: string;
    model?: string;
    pipeline?: boolean;
    workerOnly?: boolean;
    maxIterations?: number;
  }) => {
    await runCli({
      task,
      projectPath: opts.path,
      model: opts.model,
      pipeline: opts.pipeline,
      workerOnly: opts.workerOnly,
      maxIterations: opts.maxIterations,
    });
  });

// ============================================
// openswarm init
// ============================================

program
  .command('init')
  .description('Generate a sample config.yaml in the current directory')
  .option('--force', 'Overwrite existing config file')
  .action((opts: { force?: boolean }) => {
    const configPath = join(process.cwd(), 'config.yaml');

    if (existsSync(configPath) && !opts.force) {
      console.error(`config.yaml already exists. Use --force to overwrite.`);
      process.exit(1);
    }

    const content = generateSampleConfig();
    writeFileSync(configPath, content, 'utf-8');
    console.log(`Created ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Set environment variables (DISCORD_TOKEN, LINEAR_API_KEY, etc.)');
    console.log('  2. Edit config.yaml with your project paths');
    console.log('  3. Run: openswarm validate');
    console.log('  4. Run: openswarm start');
  });

// ============================================
// openswarm validate
// ============================================

program
  .command('validate')
  .description('Validate the config.yaml file')
  .action(() => {
    try {
      const config = loadConfig();
      const validation = validateConfig(config);

      if (validation.valid) {
        console.log('Config is valid.');
        console.log(`  Agents: ${config.agents.map(a => a.name).join(', ')}`);
        if (config.autonomous?.enabled) {
          console.log(`  Autonomous mode: enabled`);
        }
        if (config.prProcessor?.enabled) {
          console.log(`  PR Processor: enabled`);
        }
      } else {
        console.error('Config validation errors:');
        for (const error of validation.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ============================================
// openswarm chat
// ============================================

program
  .command('chat')
  .description('Start interactive chat CLI with Claude')
  .argument('[session]', 'Session name to load/create (optional)')
  .action(async (session?: string) => {
    // Pass session argument via process.argv for chat.ts to pick up
    if (session) {
      process.argv = [process.argv[0], process.argv[1], session];
    }
    // Dynamic import triggers the main() in chat.ts
    await import('./support/chat.js');
  });

// ============================================
// openswarm start
// ============================================

program
  .command('start')
  .description('Start the full daemon (requires config.yaml with Discord + Linear)')
  .action(async () => {
    // Dynamic import triggers the top-level main() in index.ts
    await import('./index.js');
  });

// ============================================
// Parse & Execute
// ============================================

program.parse();
