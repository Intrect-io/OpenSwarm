import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureBeforeIteration,
  createSnapshotState,
  discardSnapshots,
  rollbackStagnantIteration,
  type SnapshotHost,
} from './iterationSnapshot.js';
import { snapshotDir } from '../support/worktreeSnapshot.js';

let base: string;
let worktree: string;
const previousDir = process.env.OPENSWARM_SNAPSHOT_DIR;
const previousFlag = process.env.OPENSWARM_SNAPSHOT;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const task = { id: 'uuid-1', issueId: 'uuid-1', issueIdentifier: 'AX-4460' };

function host(iteration: number): SnapshotHost & { snapshots: ReturnType<typeof createSnapshotState> } {
  return {
    projectPath: worktree,
    currentIteration: iteration,
    taskPrefix: 'TEST',
    snapshots: state,
  };
}
let state: ReturnType<typeof createSnapshotState>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'iter-snap-')));
  process.env.OPENSWARM_SNAPSHOT_DIR = join(base, 'snapshots');
  delete process.env.OPENSWARM_SNAPSHOT;
  const main = join(base, 'main');
  worktree = join(base, 'wt');
  mkdirSync(main);
  git(main, 'init', '--quiet', '.');
  git(main, 'config', 'user.email', 't@t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'edit.txt'), 'orig\n');
  git(main, 'add', '-A');
  git(main, 'commit', '--quiet', '-m', 'base');
  git(main, 'worktree', 'add', '--quiet', worktree, '-b', 'feature');
  state = createSnapshotState(task);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDir === undefined) delete process.env.OPENSWARM_SNAPSHOT_DIR;
  else process.env.OPENSWARM_SNAPSHOT_DIR = previousDir;
  if (previousFlag === undefined) delete process.env.OPENSWARM_SNAPSHOT;
  else process.env.OPENSWARM_SNAPSHOT = previousFlag;
  rmSync(base, { recursive: true, force: true });
});

describe('capture', () => {
  it('records a tree per iteration', async () => {
    await captureBeforeIteration(host(1));
    writeFileSync(join(worktree, 'edit.txt'), 'changed\n');
    await captureBeforeIteration(host(2));

    expect(state.byIteration.get(1)).toMatch(/^[0-9a-f]{40}$/);
    expect(state.byIteration.get(2)).not.toBe(state.byIteration.get(1));
  });

  it('is a no-op when snapshots are switched off', async () => {
    process.env.OPENSWARM_SNAPSHOT = '0';
    const off = createSnapshotState(task);
    await captureBeforeIteration({ ...host(1), snapshots: off });
    expect(off.runId).toBeUndefined();
    expect(off.byIteration.size).toBe(0);
  });

  it('does not throw into the loop when the worktree is not a repository', async () => {
    const notARepo = join(base, 'plain');
    mkdirSync(notARepo);
    await expect(
      captureBeforeIteration({ ...host(1), projectPath: notARepo }),
    ).resolves.toBeUndefined();
    expect(state.byIteration.size).toBe(0);
  });
});

describe('rollback', () => {
  it('restores the worktree to where the stagnating iteration found it', async () => {
    await captureBeforeIteration(host(1));
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    writeFileSync(join(worktree, '_apply_edit.py'), 'junk\n');

    const outcome = await rollbackStagnantIteration(host(1), false);

    expect(outcome?.iteration).toBe(1);
    expect(readFileSync(join(worktree, 'edit.txt'), 'utf8')).toBe('orig\n');
    expect(existsSync(join(worktree, '_apply_edit.py'))).toBe(false);
  });

  it('does nothing when the iteration made progress — a revise is work worth keeping', async () => {
    await captureBeforeIteration(host(1));
    writeFileSync(join(worktree, 'edit.txt'), 'reviewer asked for this\n');

    expect(await rollbackStagnantIteration(host(1), true)).toBeUndefined();
    expect(readFileSync(join(worktree, 'edit.txt'), 'utf8')).toBe('reviewer asked for this\n');
  });

  it('rolls back at most once per run', async () => {
    await captureBeforeIteration(host(1));
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    expect(await rollbackStagnantIteration(host(1), false)).toBeTruthy();

    await captureBeforeIteration(host(2));
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG AGAIN\n');
    // Stagnating again is not an accumulation problem, so the loop should abort
    // rather than spend another iteration reaching the same place.
    expect(await rollbackStagnantIteration(host(2), false)).toBeUndefined();
    expect(readFileSync(join(worktree, 'edit.txt'), 'utf8')).toBe('WRONG AGAIN\n');
  });

  it('does nothing when the iteration was never snapshotted', async () => {
    expect(await rollbackStagnantIteration(host(1), false)).toBeUndefined();
  });

  it('says that ignored files were not part of the restore', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await captureBeforeIteration(host(1));
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    await rollbackStagnantIteration(host(1), false);

    const said = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('Rolled back to the start of iteration 1');
    expect(said).toContain('.gitignore');
  });
});

describe('cleanup', () => {
  it('discards the run store', async () => {
    await captureBeforeIteration(host(1));
    expect(existsSync(snapshotDir('AX-4460'))).toBe(true);
    await discardSnapshots(state);
    expect(existsSync(snapshotDir('AX-4460'))).toBe(false);
  });

  it('is a no-op when snapshots are off', async () => {
    process.env.OPENSWARM_SNAPSHOT = '0';
    await expect(discardSnapshots(createSnapshotState(task))).resolves.toBeUndefined();
  });
});
