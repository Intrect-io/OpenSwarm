// ============================================
// OpenSwarm - CLI registration for the factory kill switch (AGT-4808)
// ============================================
//
// `openswarm pause [--project <path>] [--drain|--now] [--reason <text>] [--list]`
// `openswarm unpause [--project <path>]`
// `openswarm resume` keeps reopening the last chat session; with --factory or
// --project it lifts a pause instead, so `openswarm resume --project <path>`
// does what the kill-switch spec asks without breaking the chat command.

import type { Command } from 'commander';

async function liftPause(opts: { project?: string; json?: boolean }): Promise<void> {
  const { runResumeCommand } = await import('./pauseCommand.js');
  try {
    process.exitCode = runResumeCommand(opts).exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function registerPauseCommands(program: Command, launchChatTui: (sessionId?: string) => Promise<void>): void {
  program
    .command('resume')
    .description('Resume the most recently used chat session; with --factory or --project, lift a factory pause')
    .option('--factory', 'Lift the factory-wide pause (same as `openswarm unpause`)')
    .option('--project <path>', 'Lift the pause on this repository (same as `openswarm unpause --project`)')
    .option('--json', 'Emit JSON (with --factory / --project)')
    .action(async (opts: { factory?: boolean; project?: string; json?: boolean }) => {
      if (opts.factory || opts.project) {
        await liftPause({ project: opts.project, json: opts.json });
        return;
      }
      const { factoryPauseHint } = await import('./pauseCommand.js');
      const hint = factoryPauseHint();
      if (hint) console.log(hint);
      const { latestSession } = await import('../support/chatSession.js');
      const id = await latestSession();
      if (!id) {
        console.log('No saved chat sessions to resume. Run `openswarm chat` to start one.');
        return;
      }
      console.log(`Resuming session ${id}…`);
      await launchChatTui(id);
    });

  program
    .command('pause')
    .description('Stop the factory claiming new work (globally, or for one repository) without a restart')
    .option('--project <path>', 'Pause only this repository (default: the whole factory)')
    .option('--drain', 'Let in-flight runs finish (default)')
    .option('--now', 'Cancel in-flight runs on the next heartbeat')
    .option('--reason <text>', 'Why; shown in heartbeat logs and on the dashboard')
    .option('--list', 'Show the current pauses instead of setting one')
    .option('--json', 'Emit JSON')
    .action(async (opts: { project?: string; drain?: boolean; now?: boolean; reason?: string; list?: boolean; json?: boolean }) => {
      const { runPauseCommand } = await import('./pauseCommand.js');
      try {
        process.exitCode = runPauseCommand(opts).exitCode;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  program
    .command('unpause')
    .description('Lift a pause set by `openswarm pause` or the dashboard')
    .option('--project <path>', 'Lift the pause on this repository (default: the factory-wide pause)')
    .option('--json', 'Emit JSON')
    .action(liftPause);
}
