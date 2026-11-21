// Created: 2026-11-21
// Purpose: `openswarm steward-merge <pr>` — run the default-off merge steward executor for one PR (AGT-4803)
// Dependencies: ./stewardCommand (parsePrRef), ../automation/mergeStewardExecutor (lazy)
// Test Status: stewardMergeCommand.test.ts

/**
 * Exit codes: 0 when the merge write completed; 3 refused (a gate or guard
 * said no, nothing was written); 1 infrastructure (snapshot unreadable, write
 * failed or state unknown); 2 usage. The repository must come from a PR URL or
 * `--repo`; it is never inferred from the cwd. Automation accounts come only
 * from the operator's steward config, never from a flag.
 */

import type { Command } from 'commander';

import type { StewardMergeInput, StewardMergeResult } from '../automation/mergeStewardExecutor.js';
import { parsePrRef } from './stewardCommand.js';

export interface StewardMergeCommandOptions {
  repo?: string;
}

export interface StewardMergeCommandDeps {
  execute?: (input: StewardMergeInput) => Promise<StewardMergeResult>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const EXIT: Record<StewardMergeResult['status'], number> = { merged: 0, refused: 3, infra: 1 };

/** Run the command; resolves the exit code. */
export async function runStewardMergeCommand(
  prRef: string | undefined,
  opts: StewardMergeCommandOptions,
  deps: StewardMergeCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  if (!prRef) {
    err('openswarm steward-merge: a PR number or URL is required');
    return 2;
  }
  let parsed: { repo?: string; prNumber: number };
  try {
    parsed = parsePrRef(prRef, opts.repo);
  } catch (error) {
    err(`openswarm steward-merge: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (!parsed.repo) {
    err('openswarm steward-merge: pass a PR URL or --repo owner/name; the repository is never inferred');
    return 2;
  }

  let result: StewardMergeResult;
  try {
    const execute = deps.execute ?? (await import('../automation/mergeStewardExecutor.js')).executeStewardMerge;
    result = await execute({ repo: parsed.repo, prNumber: parsed.prNumber });
  } catch (error) {
    err(`[steward merge] PR #${parsed.prNumber}: infrastructure failure — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const label = result.status === 'merged' ? 'MERGED' : result.status === 'refused' ? 'REFUSED' : 'FAILED';
  out(`[steward merge] PR #${result.prNumber}${result.headSha ? ` @ ${result.headSha.slice(0, 12)}` : ''}: ${label} — ${result.reason}`);
  out(result.audit);
  if (result.auditError) err(`[steward merge] ${result.auditError}`);
  return EXIT[result.status] ?? 1;
}

/** `openswarm steward-merge <pr> [--repo owner/name]` */
export function registerStewardMergeCommand(program: Command): void {
  program
    .command('steward-merge')
    .description('Merge steward: merge one factory PR if the operator enabled it and every gate and guard passes (default off)')
    .argument('[pr]', 'PR number or GitHub PR URL')
    .option('--repo <owner/name>', 'Repository (required unless a PR URL is given)')
    .action(async (pr: string | undefined, opts: StewardMergeCommandOptions) => {
      process.exitCode = await runStewardMergeCommand(pr, opts);
    });
}
