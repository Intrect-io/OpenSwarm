#!/usr/bin/env node
// ============================================
// OpenSwarm - CLI Entry Point
// `openswarm run`, `openswarm init`, `openswarm validate`, `openswarm chat`, `openswarm start`

import { Command } from 'commander';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './runners/cliRunner.js';
import { setDefaultAdapter } from './adapters/index.js';
import { readProviderOverride } from './core/providerOverride.js';
import { loadConfig, validateConfig, generateSampleConfig } from './core/config.js';
import { loadEnvFile } from './core/envFile.js';
import { initTelemetry, track } from './telemetry/telemetry.js';
import { maybeAutoUpdate } from './support/updateNotifier.js';
import { parsePositiveIntegerOption, parseTcpPortOption } from './cli/optionParsers.js';

// Load .env so CLI commands (e.g. `auth login --provider linear` reading
// LINEAR_OAUTH_CLIENT_ID) see the same env the daemon does. Idempotent; never
// overrides an already-set shell var.
loadEnvFile();

// Read version from package.json so it stays in sync with the published package.
// cli.js lives at <pkg>/dist/cli.js, so package.json is one directory up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

const program = new Command();

function loadTelemetryEnabledQuietly(quiet: boolean): boolean | undefined {
  if (!quiet) return loadConfig().telemetry?.enabled;
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    return loadConfig().telemetry?.enabled;
  } finally {
    console.log = originalLog;
  }
}

// Anonymous, opt-out usage telemetry (INT-1992). Honors OPENSWARM_TELEMETRY=0 /
// DO_NOT_TRACK / CI. One event per command invocation (command name only — never
// arguments). Fire-and-forget: not awaited, and track() never throws.
initTelemetry({ version: VERSION });
program.hook('preAction', (_thisCommand, actionCommand) => {
  // Honor config telemetry.enabled when a config exists (best-effort — `run`/`init`
  // may have none, in which case the env opt-out still applies).
  try {
    const opts = actionCommand.opts() as { json?: boolean };
    const quietConfigLoad = !!opts.json || actionCommand.name() === 'memory';
    initTelemetry({ version: VERSION, enabled: loadTelemetryEnabledQuietly(quietConfigLoad) });
  } catch {
    /* no/invalid config — leave the opt-out default */
  }
  // Align EVERY command's adapter with config + provider-override, so review/fix/run
  // don't fall back to the hardcoded 'codex' CLI default (only the daemon service &
  // dashboard called setDefaultAdapter). Without this, `review --max` spawned codex
  // CLI subprocesses even while the daemon ran codex-responses. Best-effort: a
  // command with no config (init) keeps the built-in default. (INT-2485)
  try {
    setDefaultAdapter(readProviderOverride() ?? loadConfig().adapter ?? 'codex');
  } catch {
    /* no/invalid config — keep the built-in default */
  }
  void track({ command: actionCommand.name() });
});

program
  .name('openswarm')
  .description('Autonomous Claude Code agents orchestrator')
  .version(VERSION);

// openswarm run <task>

program
  .command('run')
  .description('Run a task through the agent pipeline (no config.yaml needed)')
  .argument('<task>', 'Task description to execute')
  .option('-p, --path <path>', 'Project path (default: current directory)')
  .option('-m, --model <model>', 'Model override for worker agent')
  .option('--pipeline', 'Full pipeline: worker + reviewer + tester + documenter')
  .option('--worker-only', 'Worker only, no review')
  .option('--max-iterations <n>', 'Max retry iterations', parsePositiveIntegerOption)
  .option('-v, --verbose', 'Enable detailed execution logging')
  .option('--no-learn', 'Do not record this run into the repo knowledge memory')
  .action(async (task: string, opts: {
    path?: string;
    model?: string;
    pipeline?: boolean;
    workerOnly?: boolean;
    maxIterations?: number;
    verbose?: boolean;
    learn?: boolean;
  }) => {
    await runCli({
      task,
      projectPath: opts.path,
      model: opts.model,
      pipeline: opts.pipeline,
      workerOnly: opts.workerOnly,
      maxIterations: opts.maxIterations,
      verbose: opts.verbose,
      learn: opts.learn,
    });
  });

// openswarm init

program
  .command('init')
  .description('Set up OpenSwarm (interactive wizard; --yes writes a sample config only)')
  .option('--force', 'Overwrite existing config file')
  .option('--yes, --non-interactive', 'Skip the wizard: write a sample config.yaml only (CI)')
  .action(async (opts: { force?: boolean; yes?: boolean; nonInteractive?: boolean }) => {
    // Non-interactive: keep the original config-only behavior for CI / scripting.
    if (opts.yes || opts.nonInteractive) {
      const configPath = join(process.cwd(), 'config.yaml');
      if (existsSync(configPath) && !opts.force) {
        console.error(`config.yaml already exists. Use --force to overwrite.`);
        process.exit(1);
      }
      writeFileSync(configPath, generateSampleConfig(), 'utf-8');
      console.log(`Created ${configPath}`);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Set environment variables (DISCORD_TOKEN, LINEAR_API_KEY, etc.)');
      console.log('  2. Edit config.yaml with your project paths');
      console.log('  3. Run: openswarm validate');
      console.log('  4. Run: openswarm start');
      return;
    }

    const { runInitWizard } = await import('./cli/initWizard.js');
    await runInitWizard({ force: opts.force });
  });

// openswarm doctor

program
  .command('doctor')
  .description('Diagnose the environment (runtime, native deps, providers, ports, config)')
  .action(async () => {
    const { handleDoctor } = await import('./cli/doctorHandler.js');
    await handleDoctor();
  });

// openswarm validate

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

// openswarm chat

program
  .command('chat')
  .description('Start the interactive chat TUI with the configured provider')
  .argument('[session]', 'Session name to load/create (optional)')
  .option('--tui', 'Deprecated — chat always uses the TUI now (kept for compatibility)')
  .action(async (session?: string) => {
    // Always launch the TUI — the legacy readline path is retired.
    await launchChatTui(session);
  });

// openswarm resume — reopen the most recent chat session

program
  .command('resume')
  .description('Resume the most recently used chat session (its conversation + goal)')
  .action(async () => {
    const { latestSession } = await import('./support/chatSession.js');
    const id = await latestSession();
    if (!id) {
      console.log('No saved chat sessions to resume. Run `openswarm chat` to start one.');
      return;
    }
    console.log(`Resuming session ${id}…`);
    await launchChatTui(id);
  });

// openswarm mcp add|list|remove

program
  .command('mcp')
  .description('Manage MCP servers (~/.openswarm/mcp.json) available to the worker/CLI')
  .argument('<action>', 'add | list | remove')
  .argument('[name]', 'server name (for add/remove)')
  .argument('[target...]', 'command + args, or a URL (for add)')
  .option('--preset <preset>', 'use a built-in preset (e.g. linear) instead of a command/URL')
  .action(async (action: string, name: string | undefined, target: string[], opts: { preset?: string }) => {
    const { runMcpCommand } = await import('./cli/mcpCommand.js');
    try {
      console.log(runMcpCommand(action, name, target ?? [], { preset: opts.preset }));
      if (action === 'add' || action === 'remove') {
        const { resetMcpTools } = await import('./mcp/mcpClient.js');
        resetMcpTools();
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm memory status|compact|reembed

program
  .command('memory')
  .description('Inspect and maintain the repo knowledge memory DB')
  .argument('<action>', 'status | compact | reembed')
  .option('--json', 'Print JSON')
  .option('--force', 'Allow compact/reembed while the daemon is running')
  .action(async (action: string, opts: { json?: boolean; force?: boolean }) => {
    const { runMemoryCommand } = await import('./cli/memoryCommand.js');
    try {
      console.log(await runMemoryCommand(action, opts));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm schedule add|list|remove|pause

program
  .command('schedule')
  .description('Schedule agent tasks on a cron/interval (run by the daemon)')
  .argument('<action>', 'add | list | remove | pause')
  .argument('[args...]', 'add: <name> <cron|interval> <task...>; remove/pause: <name>')
  .option('--path <path>', 'Project path for the task (default: cwd)')
  .action(async (action: string, args: string[], opts: { path?: string }) => {
    const { runScheduleCommand } = await import('./cli/scheduleCommand.js');
    try {
      console.log(await runScheduleCommand(action, args ?? [], { path: opts.path }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm design-pipeline

program
  .command('design-pipeline')
  .description('Analyze the project and generate a CI workflow (.github/workflows/ci.yml)')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--dry-run', 'Print the generated workflow without writing')
  .option('--force', 'Overwrite an existing ci.yml')
  .action(async (opts: { path?: string; dryRun?: boolean; force?: boolean }) => {
    const { runDesignPipeline } = await import('./cli/designPipeline.js');
    try {
      const r = runDesignPipeline({ path: opts.path, dryRun: opts.dryRun, force: opts.force });
      if (r.wrote) console.log(`Wrote ${r.path}`);
      else console.log(r.yaml);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm review

program
  .command('review')
  .description('Review the working-tree changes; --max audits the whole codebase with reviewer subagents')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--base <ref>', 'Review the committed diff against this ref (e.g. origin/main) instead of working-tree changes — for CI on a checked-out PR branch')
  .option('--issues [parent]', 'File follow-ups as Linear sub-issues (parent inferred from the git branch, or pass an id)')
  .option('--issues-per-area [parent]', 'For --max: legacy per-area follow-up fan-out (skips the PM synthesis)')
  .option('--file [parent]', 'Alias for --issues (back-compat)')
  .option('--adapter <name>', 'Adapter override for the reviewer')
  .option('--debug', 'Verbose logging')
  // --max: full-codebase multi-agent audit (INT-2006)
  .option('--max', 'Audit the whole codebase: fan reviewer subagents out over directory-shaped areas')
  .option('--concurrency <n>', 'Max reviewer subagents in flight for --max (default 4)', parsePositiveIntegerOption)
  .option('--max-files-per-area <n>', 'Files per area before chunking, for --max (default 12)', parsePositiveIntegerOption)
  .option('--yes', 'Skip the --max cost-confirmation prompt')
  .option('--dry-run', 'For --max: print the area partition plan and exit (no subagents)')
  .option('--out <file>', 'For --max: write the markdown report here (default .openswarm/audit/audit-<ts>.md)')
  .option('--no-linear', 'For --max: skip creating the default Linear master audit issue')
  .option('--fallback <adapter>', 'For --max: retry usage-limited areas on this adapter (default: claude for codex)')
  .option('--no-fallback', 'For --max: disable the automatic usage-limit fallback')
  .option('--fix', 'For --max: apply dependency-aware fixes in isolated sandboxes; publish a PR only after re-review and deterministic verification pass')
  .option('--in-place', 'For --max --fix: edit the current working tree instead of an isolated worktree (no branch, no PR)')
  .option('--fix-rounds <n>', 'For --max --fix: optional round cap (default: until clean, with a two-hour safety budget)', parsePositiveIntegerOption)
  .option('--no-learn', 'For --max: do not record the audit findings into the repo knowledge memory')
  .action(async (opts: {
    path?: string; base?: string; issues?: string | boolean; issuesPerArea?: string | boolean; file?: string | boolean; adapter?: string; debug?: boolean;
    max?: boolean; concurrency?: number; maxFilesPerArea?: number; yes?: boolean; dryRun?: boolean;
    out?: string; linear?: boolean; fallback?: string | boolean; fix?: boolean; inPlace?: boolean; fixRounds?: number; learn?: boolean;
  }) => {
    try {
      if (opts.max) {
        const { runReviewMaxCommand, reviewMaxResultFailed } = await import('./cli/reviewMaxCommand.js');
        const result = await runReviewMaxCommand({
          path: opts.path,
          concurrency: opts.concurrency,
          maxFilesPerArea: opts.maxFilesPerArea,
          adapter: opts.adapter,
          fileIssue: opts.issues ?? opts.file,
          issuesPerArea: opts.issuesPerArea,
          yes: opts.yes,
          dryRun: opts.dryRun,
          out: opts.out,
          // commander sets opts.linear=false for --no-linear
          noLinear: opts.linear === false,
          // --fallback <adapter> → string; --no-fallback → false; default → undefined (auto)
          fallbackAdapter: typeof opts.fallback === 'string' ? opts.fallback : undefined,
          noFallback: opts.fallback === false,
          fix: opts.fix,
          inPlace: opts.inPlace,
          fixRounds: opts.fixRounds,
          learn: opts.learn,
        });
        // Exit contract (INT-3100): 2 = the gate did not run at all (no area
        // reviewed — quota/infra), 1 = it ran and failed. CI reads only this.
        const { REVIEW_EXIT_GATE_NOT_RUN } = await import('./cli/reviewExit.js');
        if (result && !result.gateRan) process.exitCode = REVIEW_EXIT_GATE_NOT_RUN;
        else if (reviewMaxResultFailed(result, !!opts.fix)) process.exitCode = 1;
        return;
      }
      const { runReviewCommand } = await import('./cli/reviewCommand.js');
      const result = await runReviewCommand({ path: opts.path, base: opts.base, fileIssue: opts.issues ?? opts.file, adapter: opts.adapter, debug: opts.debug });
      if (result && result.decision === 'reject') process.exitCode = 1;
    } catch (e) {
      // A throw means no verdict was produced — the gate did NOT run. Exit 2,
      // never 0/1, so CI can distinguish "couldn't review" from "reviewed and
      // rejected" and neither reads as a pass. (INT-3100)
      const { REVIEW_EXIT_GATE_NOT_RUN, describeReviewGateFailure } = await import('./cli/reviewExit.js');
      console.error(describeReviewGateFailure(e));
      process.exitCode = REVIEW_EXIT_GATE_NOT_RUN;
    }
  });

// openswarm fix — CI/test gate fan-out auto-fix (INT-2267)

program
  .command('fix')
  .description('Run the CI/test checks and fan a fix-worker out over the failures, re-running until green')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--checks <list>', 'Comma list of checks (lint,type,build,test or script/config names); default: auto-detected from openswarm.json "checks", package.json scripts, Cargo.toml, or Python config', (v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--concurrency <n>', 'Max fix workers in flight (default 4)', (v) => parseInt(v, 10))
  .option('--rounds <n>', 'Max check → fix → re-check rounds (default 3)', (v) => parseInt(v, 10))
  .option('--adapter <name>', 'Adapter override for the fix workers')
  .option('--timeout <ms>', 'Per-area fix worker timeout in ms (default 900000 = 15 min)', parsePositiveIntegerOption)
  .option('--no-learn', 'Do not record a successful fix into the repo knowledge memory')
  .action(async (opts: { path?: string; checks?: string[]; concurrency?: number; rounds?: number; adapter?: string; timeout?: number; learn?: boolean }) => {
    try {
      const { runFixCommand } = await import('./cli/fixCommand.js');
      const report = await runFixCommand({
        path: opts.path,
        checks: opts.checks,
        concurrency: opts.concurrency,
        rounds: opts.rounds,
        adapter: opts.adapter as import('./adapters/types.js').AdapterName | undefined,
        timeoutMs: opts.timeout,
        learn: opts.learn,
      });
      if (!report.green) process.exitCode = 1;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm exec <prompt>

program
  .command('exec')
  .description('Execute a task via the running daemon (auto-starts if needed)')
  .argument('<prompt>', 'Task prompt to execute')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--timeout <seconds>', 'Timeout in seconds (default: 600)', parsePositiveIntegerOption)
  .option('--no-auto-start', 'Do not auto-start the service')
  .option('--local', 'Execute locally without daemon')
  .option('--pipeline', 'Full pipeline: worker + reviewer + tester + documenter')
  .option('--worker-only', 'Worker only, no review')
  .option('-m, --model <model>', 'Model override for worker')
  .option('-v, --verbose', 'Enable detailed execution logging')
  .action(async (prompt: string, opts: {
    path?: string;
    timeout?: number;
    autoStart?: boolean;
    local?: boolean;
    pipeline?: boolean;
    workerOnly?: boolean;
    model?: string;
    verbose?: boolean;
  }) => {
    const { executePrompt } = await import('./cli/promptHandler.js');
    await executePrompt({ prompt, ...opts });
  });

// openswarm start

program
  .command('start')
  .description('Start the full daemon in the background (use --foreground to stay attached)')
  .option('-F, --foreground', 'Run in the foreground instead of detaching (for debugging / LaunchAgent)')
  .action(async (opts: { foreground?: boolean }) => {
    if (opts.foreground) {
      // Dynamic import triggers the top-level main() in index.ts
      await import('./index.js');
      return;
    }

    const { startDaemon, getDaemonStatus, readLogTail } = await import('./cli/daemon.js');
    try {
      const { pid, logFile } = await startDaemon();
      // The child can die immediately on a startup error (bad config, port in
      // use, throwing dependency). Spawning only proves the OS forked it — wait
      // briefly and confirm it's actually alive before claiming success, so we
      // never print "started" for a daemon that `status` will call "not running".
      await new Promise((r) => setTimeout(r, 1500));
      if (!getDaemonStatus().running) {
        console.error('OpenSwarm exited during startup. Recent log:');
        console.error('────────────────────────────────────────');
        console.error(readLogTail(25));
        console.error('────────────────────────────────────────');
        console.error(`Full log: ${logFile}`);
        process.exit(1);
      }
      console.log(`OpenSwarm started in background (pid ${pid}).`);
      console.log(`  logs:    ${logFile}`);
      console.log(`  stop:    openswarm stop`);
      console.log(`  status:  openswarm status`);
    } catch (err) {
      console.error(`Failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// openswarm stop

program
  .command('stop')
  .description('Stop the background daemon (sends SIGTERM)')
  .option('-t, --timeout <ms>', 'Max time to wait for graceful shutdown (default 10000)', '10000')
  .action(async (opts: { timeout: string }) => {
    const timeoutMs = parseInt(opts.timeout, 10);
    const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : 10_000;
    const { stopDaemon, probeDaemonPort, stopExternalDaemon, LAUNCHD_LABEL } = await import('./cli/daemon.js');
    try {
      const stopped = await stopDaemon(effectiveTimeout);
      if (stopped) {
        console.log('OpenSwarm stopped.');
        return;
      }
      // No PID file — an externally managed (launchd) daemon may still be serving.
      // Drive `launchctl bootout` ourselves instead of leaving the user to do it.
      if (await probeDaemonPort()) {
        const result = await stopExternalDaemon(effectiveTimeout);
        if (result.outcome === 'stopped') {
          console.log('OpenSwarm stopped (launchd service booted out).');
          console.log('  It will start again at next login; restart now with:');
          console.log(`  launchctl kickstart -k gui/$UID/${LAUNCHD_LABEL}`);
          return;
        }
        // Couldn't stop it automatically — fall back to actionable guidance.
        console.log('OpenSwarm is running but externally managed (no PID file — e.g. launchd).');
        if (result.outcome === 'failed') {
          console.log(`  Automatic bootout failed (${result.detail}). Stop it manually:`);
        } else if (result.outcome === 'not-managed') {
          console.log(`  No launchd job under ${LAUNCHD_LABEL}; it was started another way. Stop it manually:`);
        } else {
          console.log('  Stop it manually:');
        }
        console.log(`  stop: launchctl bootout gui/$UID/${LAUNCHD_LABEL}`);
        console.log(`  restart: launchctl kickstart -k gui/$UID/${LAUNCHD_LABEL}`);
        return;
      }
      console.log('OpenSwarm is not running.');
    } catch (err) {
      console.error(`Failed to stop: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// openswarm status

program
  .command('status')
  .description('Report daemon status (pid, uptime, log path)')
  .action(async () => {
    const { getDaemonStatusFull } = await import('./cli/daemon.js');
    const status = await getDaemonStatusFull();
    if (!status.running) {
      console.log('OpenSwarm is not running.');
      console.log(`  pid file: ${status.pidFile}`);
      console.log(`  log file: ${status.logFile}`);
      return;
    }
    if (status.external) {
      console.log('OpenSwarm is running (externally managed — e.g. launchd).');
      console.log('  port 3847 is responding; no PID file for this instance.');
      console.log(`  restart: launchctl kickstart -k gui/$UID/com.intrect.openswarm`);
      return;
    }
    const uptime = status.uptimeSeconds ?? 0;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    console.log(`OpenSwarm is running.`);
    console.log(`  pid:    ${status.pid}`);
    console.log(`  uptime: ${h}h ${m}m ${s}s`);
    console.log(`  logs:   ${status.logFile}`);
  });

// openswarm provider

program
  .command('provider')
  .description('Show or switch the active AI provider (interactive picker when no name is given)')
  .argument('[name]', 'Provider to switch to — omit for the picker')
  .action(async (name?: string) => {
    const { runProviderCommand } = await import('./cli/providerCommand.js');
    process.exitCode = await runProviderCommand(name);
  });

// openswarm dash

program
  .command('dash')
  .description('Open the web dashboard in a browser')
  .option('-p, --port <port>', 'Port number', parseTcpPortOption, 3847)
  .option('--no-open', 'Start server without opening browser')
  .action(async (opts: { port: number; open: boolean }) => {
    const port = opts.port;
    const { startWebServer, stopWebServer } = await import('./support/web.js');
    await startWebServer(port);
    console.log(`Dashboard running at http://localhost:${port}`);

    if (opts.open) {
      const { exec } = await import('node:child_process');
      const url = `http://localhost:${port}`;
      const cmd = process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, (err) => {
        if (err) console.log(`Open ${url} in your browser`);
      });
    }

    // Keep process alive
    let stopping = false;
    process.once('SIGINT', () => {
      if (stopping) return;
      stopping = true;
      void stopWebServer()
        .catch((error) => console.error('[Dashboard] graceful shutdown failed:', error))
        .finally(() => {
          console.log('\nDashboard stopped.');
          process.exitCode = 0;
        });
    });
  });

// openswarm check

program
  .command('check')
  .description('Check code registry for a file or show registry stats')
  .argument('[filePath]', 'File path to inspect (relative to project root)')
  .option('--stats', 'Show overall registry statistics')
  .option('--deprecated', 'List all deprecated entities')
  .option('--untested', 'List all untested entities')
  .option('--high-risk', 'List all high-risk entities')
  .option('--tag <tag>', 'List entities with a specific tag')
  .option('--search <query>', 'Full-text search entities')
  .option('--scan', 'Scan entire repository and sync to registry')
  .option('--bs', 'Scan for BS patterns (bad code smells)')
  .option('--tree', 'Display codebase tree with entity counts and risk')
  .option('--ci', 'CI/CD mode: JSON output, exit 1 on critical issues')
  .option('-v, --verbose', 'Verbose output (with --scan)')
  .option('--project <id>', 'Filter by project ID')
  .action(async (filePath: string | undefined, opts: {
    stats?: boolean;
    deprecated?: boolean;
    untested?: boolean;
    highRisk?: boolean;
    tag?: string;
    search?: string;
    scan?: boolean;
    bs?: boolean;
    tree?: boolean;
    ci?: boolean;
    verbose?: boolean;
    project?: string;
  }) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(filePath, opts);
  });

// openswarm check annotate <qualifiedName>

program
  .command('annotate')
  .description('Annotate a code entity in the registry')
  .argument('<qualifiedName>', 'Entity qualified name (file::name) or search term')
  .option('--deprecate [reason]', 'Mark as deprecated')
  .option('--status <status>', 'Set status (active|experimental|planned|broken)')
  .option('--tag <tag>', 'Add a tag (key or key=value)')
  .option('--untag <tag>', 'Remove a tag')
  .option('--note <text>', 'Add a note')
  .option('--risk <level>', 'Set risk level (low|medium|high)')
  .option('--warn <message>', 'Add a warning (format: severity/category: message)')
  .action(async (qualifiedName: string, opts: {
    deprecate?: string | boolean;
    status?: string;
    tag?: string;
    untag?: string;
    note?: string;
    risk?: string;
    warn?: string;
  }) => {
    const { handleAnnotate } = await import('./cli/checkHandler.js');
    await handleAnnotate(qualifiedName, opts);
  });

// openswarm auth

const authCmd = program
  .command('auth')
  .description('Manage OAuth authentication for providers');

authCmd
  .command('login')
  .description('Login via OAuth/PKCE (gpt, openrouter, linear)')
  .option('--provider <provider>', 'Provider to authenticate (gpt | openrouter | linear)', 'gpt')
  .option('--client-id <clientId>', 'GPT only: override OAuth Client ID (defaults to the public Codex client)')
  .option('--port <port>', 'Callback server port', parseTcpPortOption)
  .action(async (opts: { provider: string; clientId?: string; port?: number }) => {
    const { handleAuthLogin } = await import('./cli/authHandler.js');
    await handleAuthLogin(opts.provider, opts);
  });

authCmd
  .command('status')
  .description('Show stored auth profiles')
  .action(async () => {
    const { handleAuthStatus } = await import('./cli/authHandler.js');
    handleAuthStatus();
  });

authCmd
  .command('models')
  .description('List available Codex models (live via OAuth, offline fallback otherwise)')
  .action(async () => {
    const { handleAuthModels } = await import('./cli/authHandler.js');
    await handleAuthModels();
  });

authCmd
  .command('logout')
  .description('Remove stored auth tokens')
  .option('--provider <provider>', 'Provider to remove (gpt | openrouter | linear)', 'gpt')
  .action(async (opts: { provider: string }) => {
    const { handleAuthLogout } = await import('./cli/authHandler.js');
    handleAuthLogout(opts.provider);
  });

// Work-repo management — register which repos the daemon operates on

program
  .command('add')
  .description('Register a repository as a work repo (enabled + pinned)')
  .argument('<path>', 'Path to the git repository')
  .action(async (path: string) => {
    const { handleProjectAdd } = await import('./cli/projectHandler.js');
    await handleProjectAdd(path);
  });

program
  .command('projects')
  .description('List registered work repositories')
  .action(async () => {
    const { handleProjectList } = await import('./cli/projectHandler.js');
    handleProjectList();
  });

program
  .command('remove')
  .description('Unregister a work repository (adds it to the denylist)')
  .argument('<path>', 'Path to the repository')
  .action(async (path: string) => {
    const { handleProjectRm } = await import('./cli/projectHandler.js');
    handleProjectRm(path);
  });

// 서브커맨드 없이 `openswarm`만 입력 시 → TUI chat 실행 (`openswarm chat`과 동일)

async function launchChatTui(sessionId?: string): Promise<void> {
  // Auto-start the background daemon so the monitor tabs (Projects/Tasks/Stuck/
  // Issues) — which are read-only clients of the daemon's :3847 API — have data
  // to show. If it's already running or fails to start, just continue: the chat
  // agent itself doesn't depend on the daemon. Done before console muting so the
  // one-line status is visible.
  try {
    const { getDaemonStatus, getDaemonStatusFull, startDaemon } = await import('./cli/daemon.js');
    // Port-probe-aware check: a launchd-managed daemon has no PID file, and
    // spawning a second daemon next to it double-processes the same task
    // queue (INT-2473). Only spawn when neither the PID file nor the API port
    // shows a live daemon.
    if (!(await getDaemonStatusFull()).running) {
      const { pid } = await startDaemon();
      process.stdout.write(`Starting OpenSwarm daemon (pid ${pid}) for the monitor tabs…\n`);
      await new Promise((r) => setTimeout(r, 1500));
      if (!getDaemonStatus().running) {
        process.stdout.write('Daemon did not stay up; monitor tabs may be empty. Run `openswarm status` to see why.\n');
      }
    }
  } catch {
    // Non-fatal — chat works without the daemon.
  }

  // Ink cockpit (EPIC INT-1813): React reconciler diffs the screen, so there's
  // no blessed terminfo noise to mute and no manual redraw/flicker. The old
  // console-mute hack is gone with blessed.
  const { startInkTui } = await import('./tui/index.js');
  const { loadDefaultProvider, loadSession, generateSessionId } = await import('./support/chatSession.js');
  const { getDefaultChatModel } = await import('./support/chatBackend.js');

  // Resume an existing session when an id is given, else start a fresh one. A
  // missing id falls back to a new session rather than erroring. (INT-2014)
  let provider = loadDefaultProvider();
  let model = getDefaultChatModel(provider);
  let initialHistory: import('./tui/chatModel.js').ChatLine[] | undefined;
  let goal: string | undefined;
  let resolvedSessionId = sessionId ?? generateSessionId();
  if (sessionId) {
    const sess = await loadSession(sessionId);
    if (sess) {
      provider = sess.provider;
      model = sess.model;
      goal = sess.goal;
      const { messagesToHistory } = await import('./tui/chatModel.js');
      initialHistory = messagesToHistory(sess.messages);
      resolvedSessionId = sess.id;
    } else {
      process.stdout.write(`Session "${sessionId}" not found — starting a new session.\n`);
    }
  }
  const cwd = process.cwd();
  let branch: string | undefined;
  try {
    const { execFileSync } = await import('node:child_process');
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || undefined;
  } catch {
    // not a git repo — omit the branch
  }
  await startInkTui({ version: VERSION, provider, model, port: 3847, cwd, branch, sessionId: resolvedSessionId, initialHistory, goal });
}

program.action(launchChatTui);

// Parse & Execute

// Auto-update from npm before dispatching: if a newer version is published,
// `npm i -g` it and re-exec on the new binary (default ON; opt out with
// OPENSWARM_NO_AUTO_UPDATE → passive notice). Cached 24h, skips CI/non-TTY/meta,
// never blocks the CLI. (INT-2394, extends INT-2270)
await maybeAutoUpdate(VERSION);
program.parse();
