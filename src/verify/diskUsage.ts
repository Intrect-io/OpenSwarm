import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function directoryBytes(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path); } catch { return 0; }
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry);
    try {
      const info = await lstat(child);
      if (info.isDirectory()) bytes += await directoryBytes(child);
      else if (info.isFile()) bytes += info.size;
    } catch { /* A concurrent cleanup is expected during a usage sample. */ }
  }
  return bytes;
}

export async function logVerifySandboxUsage(root: string, phase: 'create' | 'remove'): Promise<void> {
  const [bytes, entries] = await Promise.all([
    directoryBytes(root), readdir(dirname(root)).catch(() => []),
  ]);
  const live = entries.filter((entry) => entry.startsWith('.openswarm-verify-')).length;
  console.log(`[Verify] sandbox usage phase=${phase} bytes=${bytes} live=${live} root=${root}`);
}

export async function logPeriodicDiskUsage(projectPath: string, scratchRoot?: string): Promise<void> {
  const { stdout = '' } = await execFileAsync('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'])
    .catch(() => ({ stdout: '' }));
  const worktrees = stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
  const [sessionsBytes, verifyBytes] = await Promise.all([
    directoryBytes(join(homedir(), '.openswarm', 'sessions')),
    (async () => {
      const root = scratchRoot ?? tmpdir();
      let entries: string[];
      try { entries = await readdir(root); } catch { return 0; }
      const verifyRoots = entries.filter((entry) => entry.startsWith('.openswarm-verify-'));
      return (await Promise.all(verifyRoots.map((entry) => directoryBytes(join(root, entry)))))
        .reduce((total, bytes) => total + bytes, 0);
    })(),
  ]);
  console.log(`[Verify] disk usage period=5m repo=${basename(projectPath)} worker_worktrees=${worktrees} sessions_bytes=${sessionsBytes} verify_tmp_bytes=${verifyBytes}`);
}
