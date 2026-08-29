import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBundledBinDir } from './envPath.js';
import { getPrompts } from '../locale/index.js';

/**
 * The worker prompt tells agents which `cxt` subcommands to use, and
 * `buildWorkerEnv` prepends the bundled `.bin` so the LOCAL cxt is the one they
 * get. Those two drifted: the prompt documented `impact`/`who-calls`/`export`
 * while package.json still pinned 0.1.0, which has none of them — an agent
 * would have been told to run commands that do not exist, which is the exact
 * failure this prompt change exists to stop. (AGT-4081, caught by the gate.)
 */
describe('the bundled cxt supports what the prompt documents (AGT-4081)', () => {
  const binDir = getBundledBinDir();
  const cxt = binDir ? join(binDir, 'cxt') : null;
  const available = Boolean(cxt && existsSync(cxt));

  it.runIf(available)('advertises every subcommand the worker prompt names', () => {
    const help = execFileSync(cxt!, ['--help'], { encoding: 'utf8', timeout: 30_000 });
    const prompt = getPrompts('en').buildWorkerPrompt({
      taskTitle: 't', taskDescription: 'd',
    });
    // Every `cxt <verb>` the prompt mentions must exist in the CLI's own help.
    const documented = [...new Set(
      [...prompt.matchAll(/`cxt ([a-z-]+)/g)].map((m) => m[1]),
    )];
    expect(documented.length).toBeGreaterThan(3); // the prompt really does name some
    for (const verb of documented) {
      expect(help, `prompt documents \`cxt ${verb}\` but the bundled CLI has no such command`)
        .toContain(verb);
    }
  });
});
