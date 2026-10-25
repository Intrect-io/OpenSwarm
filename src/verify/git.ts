import { spawn } from 'node:child_process';

export const GIT_TIMEOUT_MS = 30_000;
/**
 * The head sandbox is a `--no-hardlinks` clone: a full copy of the object store,
 * because the sandbox runs the repository's own test commands and hardlinked
 * packs would share inodes with the real checkout. That copy is bounded by disk
 * throughput, not by git, and on a loaded host it outgrows the 30 s every other
 * git call gets — cgf-portal's 135 MB took 33 s at load 55, and the runner fell
 * back to the LLM tester 29 times in one day, which is how `ruff`-red code shipped
 * as ready PRs (AGT-4416). The clone gets its own budget.
 */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** The budget a git invocation gets: the sandbox clone's own, everything else the short default. */
export function gitTimeoutMsFor(args: readonly string[]): number {
  return args[0] === 'clone' ? CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS;
}
export async function git(projectPath: string, args: string[]): Promise<string> {
  const timeoutMs = gitTimeoutMsFor(args);
  return await new Promise((resolveResult, reject) => {
    const maxOutputBytes = 4 * 1024 * 1024;
    // Checkout hooks belong to the live developer environment. Running them in
    // a verification worktree can restore external data/secrets after filtering.
    const child = spawn('git', ['-C', projectPath, '-c', 'core.hooksPath=/dev/null', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      reject(error);
    };
    timer = setTimeout(() => fail(new Error(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`)), timeoutMs);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`git ${args[0] ?? ''} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`git exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
