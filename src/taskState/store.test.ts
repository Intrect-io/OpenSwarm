import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  upsertTaskState,
  getTaskState,
  getTaskReadiness,
  releaseDependentTasks,
  enrichTaskFromState,
  markTaskDone,
  markTaskInProgress,
  updateTaskLinearState,
  completeParentIfChildrenDone,
  buildTaskStateSyncComment,
  hydrateTaskStateFromComments,
  markTaskBacklog,
  resetTaskStateStoreForTests,
  buildLockPayload,
  type OpenSwarmTaskState,
} from './store.js';
import { PROCESS_STARTED_AT_MS, isProofCapableSpace, processNamespaceId } from '../support/processLiveness.js';
import { getInstanceId } from '../support/healthEndpoint.js';

// The fast-path proof needs a REAL pid space, which only Linux can give (boot
// id + pid-namespace inode). Elsewhere the recorded id is a machine hint, good
// for ruling a record out but never for the proof — so these cases cannot arise
// there at all. Asserted on Linux in CI.
const itWithPidSpace = isProofCapableSpace(processNamespaceId()) ? it : it.skip;


describe('task state store', () => {
  let stateFile: string;
  let stateDir: string;

  function taskState(
    issueId: string,
    status: OpenSwarmTaskState['execution']['status'],
    linearState: string,
  ): OpenSwarmTaskState {
    return {
      version: 1,
      issueId,
      childIssueIds: [],
      dependencyIssueIds: [],
      dependencyTitles: [],
      fileScope: [],
      execution: { status, retryCount: 0 },
      worktree: {},
      linearState,
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-task-state-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
  });

  it('carries a block reason across a reload and clears it again', () => {
    // A dependency block outlives the process that noticed it, so the reason has
    // to survive a reload — and clearing it has to survive one too, or a task
    // stays labelled as blocked after the thing it waited for is done.
    upsertTaskState('AGT-1', { execution: { status: 'in_progress', retryCount: 0 } });
    upsertTaskState('AGT-1', { execution: { blockedReason: 'Waiting on dependencies: AGT-2' } });

    resetTaskStateStoreForTests();
    expect(getTaskState('AGT-1')?.execution.blockedReason).toBe('Waiting on dependencies: AGT-2');
    // Merged, not replaced: recording the block must not cost the task its status.
    expect(getTaskState('AGT-1')?.execution.status).toBe('in_progress');

    upsertTaskState('AGT-1', { execution: { blockedReason: undefined } });
    resetTaskStateStoreForTests();
    expect(getTaskState('AGT-1')?.execution.blockedReason).toBeUndefined();
  });

  afterEach(() => {
    resetTaskStateStoreForTests();
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    delete process.env.OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS;
  });

  it('enriches a task with canonical dependency data', () => {
    upsertTaskState('ISSUE-2', {
      issueIdentifier: 'INT-2',
      dependencyIssueIds: ['ISSUE-1'],
      parentIssueId: 'PARENT-1',
      topoRank: 1,
      execution: { status: 'blocked', retryCount: 0 },
      updatedAt: new Date().toISOString(),
    });

    const task = enrichTaskFromState({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });

    expect(task.parentId).toBe('PARENT-1');
    expect(task.blockedBy).toEqual(['ISSUE-1']);
    expect(task.topoRank).toBe(1);
  });

  it('persists and enriches planner-declared file scope', () => {
    upsertTaskState('ISSUE-SCOPE', {
      issueIdentifier: 'INT-SCOPE',
      fileScope: ['src/a.ts', 'src/a.test.ts'],
      execution: { status: 'todo', retryCount: 0 },
      updatedAt: new Date().toISOString(),
    });

    const enriched = enrichTaskFromState({
      id: 'ISSUE-SCOPE',
      source: 'linear',
      title: 'scoped task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-SCOPE',
    });

    expect(enriched.fileScope).toEqual(['src/a.ts', 'src/a.test.ts']);

    // An explicit scope already on the task wins over the stored one.
    const overridden = enrichTaskFromState({
      id: 'ISSUE-SCOPE',
      source: 'linear',
      title: 'scoped task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-SCOPE',
      fileScope: ['src/override.ts'],
    });
    expect(overridden.fileScope).toEqual(['src/override.ts']);
  });

  it('serializes two process writers without losing either update', async () => {
    const fixture = fileURLToPath(new URL('./storeClaimProcess.fixture.ts', import.meta.url));
    const run = (issueId: string, delay: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, stateFile, issueId, String(delay)], {
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });

    await Promise.all([run('PROCESS-A', 0), run('PROCESS-B', 0)]);
    resetTaskStateStoreForTests();
    expect(getTaskState('PROCESS-A')?.title).toBe('PROCESS-A');
    expect(getTaskState('PROCESS-B')?.title).toBe('PROCESS-B');
  });

  it('keeps tasks blocked until dependencies are done, then releases them', () => {
    upsertTaskState('ISSUE-1', {
      execution: { status: 'in_progress', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('ISSUE-2', {
      dependencyIssueIds: ['ISSUE-1'],
      execution: { status: 'blocked', retryCount: 0 },
      linearState: 'Backlog',
      updatedAt: new Date().toISOString(),
    });

    const blocked = getTaskReadiness({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(['ISSUE-1']);

    markTaskDone('ISSUE-1');
    const released = releaseDependentTasks('ISSUE-1');
    expect(released).toHaveLength(1);
    expect(released[0].issueId).toBe('ISSUE-2');
    expect(released[0].execution.status).toBe('todo');
    expect(released[0].linearState).toBe('Todo');
  });

  it('gates on TaskItem.blockedBy (Linear-fetched deps) until the blocker is done', () => {
    // INT-1809: blockedBy now arrives on the TaskItem from the Linear fetch
    // (relations + "블로커:" prose), not just from local taskState.dependencyIssueIds.
    // getTaskReadiness must prefer it and gate execution.
    upsertTaskState('KT-307', {
      execution: { status: 'in_progress', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });

    const task = {
      id: 'KT-308',
      source: 'linear' as const,
      title: '[하네스이식 8] eval 회귀 검증',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'KT-308',
      blockedBy: ['KT-307'],
    };

    const blocked = getTaskReadiness(task);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(['KT-307']);
    expect(blocked.reason).toContain('Waiting on dependencies');

    // Blocker completes → dependent becomes ready.
    markTaskDone('KT-307');
    const ready = getTaskReadiness(task);
    expect(ready.ready).toBe(true);
    expect(ready.blockedBy).toEqual([]);
  });

  it('reconciles stale in_progress against Linear state (R5)', () => {
    // Operator parks an actively-running issue → local in_progress is stale.
    markTaskInProgress('KT-400', { linearState: 'In Progress' });
    const parked = updateTaskLinearState('KT-400', 'Backlog');
    expect(parked.linearState).toBe('Backlog');
    expect(parked.execution.status).toBe('backlog');

    // Completed externally → mark done locally.
    markTaskInProgress('KT-401', { linearState: 'In Progress' });
    const done = updateTaskLinearState('KT-401', 'Done');
    expect(done.execution.status).toBe('done');

    // Still actively In Progress → execution status is left untouched.
    markTaskInProgress('KT-402', { linearState: 'In Progress' });
    const running = updateTaskLinearState('KT-402', 'In Progress');
    expect(running.execution.status).toBe('in_progress');
  });

  it('parks a claimed task back in backlog and clears stale worktree data', () => {
    markTaskInProgress('KT-450', {
      issueIdentifier: 'KT-450',
      title: 'Cancel running task',
      linearState: 'In Progress',
      sessionId: 'pipeline-1',
      branchName: 'fix/kt-450',
      worktreePath: '/tmp/openswarm/kt-450',
    });

    const parked = markTaskBacklog('KT-450', {
      issueIdentifier: 'KT-450',
      title: 'Cancel running task',
    });

    expect(parked.execution.status).toBe('backlog');
    expect(parked.execution.lastSessionId).toBe('pipeline-1');
    expect(parked.linearState).toBe('Backlog');
    expect(parked.worktree.branchName).toBeUndefined();
    expect(parked.worktree.worktreePath).toBeUndefined();
  });

  it('preserves existing top-level metadata when convenience patches omit it', () => {
    markTaskInProgress('KT-451', {
      issueIdentifier: 'KT-451',
      title: 'Preserve metadata',
      projectId: 'project-1',
      projectName: 'OpenSwarm',
      linearState: 'In Progress',
      branchName: 'fix/kt-451',
    });

    const done = markTaskDone('KT-451');
    expect(done.issueIdentifier).toBe('KT-451');
    expect(done.title).toBe('Preserve metadata');
    expect(done.projectId).toBe('project-1');
    expect(done.projectName).toBe('OpenSwarm');
    expect(done.linearState).toBe('Done');
  });

  it('completes decomposed parent only after all child issues are done', () => {
    upsertTaskState('PARENT-1', {
      childIssueIds: ['CHILD-1', 'CHILD-2'],
      execution: { status: 'decomposed', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-1', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'done', retryCount: 0 },
      linearState: 'Done',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-2', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'todo', retryCount: 0 },
      linearState: 'Todo',
      updatedAt: new Date().toISOString(),
    });

    expect(completeParentIfChildrenDone('CHILD-1')).toBeNull();

    markTaskDone('CHILD-2');
    const parent = completeParentIfChildrenDone('CHILD-2');
    expect(parent?.issueId).toBe('PARENT-1');
    expect(parent?.execution.status).toBe('done');
    expect(parent?.linearState).toBe('Done');
  });

  it('hydrates canonical state from the latest Linear sync comment', () => {
    const older = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Backlog',
        execution: { status: 'blocked', retryCount: 0 },
      }),
      'Task blocked'
    );

    const latest = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Done',
        execution: { status: 'done', retryCount: 0 },
      }),
      'Task completed'
    );

    const hydrated = hydrateTaskStateFromComments('ISSUE-9', [
      { body: older, createdAt: '2026-03-18T00:00:00.000Z', source: 'openswarm' },
      { body: latest, createdAt: '2026-03-18T01:00:00.000Z', source: 'openswarm' },
    ]);

    expect(hydrated?.execution.status).toBe('done');
    expect(hydrated?.linearState).toBe('Done');
  });

  it('does not grant execution authority to an authorless copied sync comment', () => {
    const body = buildTaskStateSyncComment(taskState('ISSUE-COPY', 'done', 'Done'), 'Task completed');
    expect(hydrateTaskStateFromComments('ISSUE-COPY', [
      { body, createdAt: '2026-03-18T01:00:00.000Z' },
    ])).toBeUndefined();
  });

  it('ignores untrusted or mismatched task-state sync comments', () => {
    const olderTrusted = buildTaskStateSyncComment(
      taskState('ISSUE-10', 'blocked', 'Backlog'),
      'Task blocked'
    );
    const newerUntrusted = buildTaskStateSyncComment(
      taskState('ISSUE-10', 'done', 'Done'),
      'Task completed'
    );
    const otherIssue = buildTaskStateSyncComment(
      taskState('ISSUE-OTHER', 'done', 'Done'),
      'Task completed'
    );

    const hydrated = hydrateTaskStateFromComments('ISSUE-10', [
      { body: olderTrusted, createdAt: '2026-03-18T00:00:00.000Z', user: 'OpenSwarm Bot' },
      { body: newerUntrusted, createdAt: '2026-03-18T01:00:00.000Z', user: 'Mallory' },
      { body: otherIssue, createdAt: '2026-03-18T02:00:00.000Z', user: 'OpenSwarm Bot' },
    ]);

    expect(hydrated?.execution.status).toBe('blocked');
    expect(hydrated?.linearState).toBe('Backlog');
  });

  it('allows explicitly configured task-state sync comment authors', () => {
    process.env.OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS = 'unohee';
    const body = buildTaskStateSyncComment(taskState('ISSUE-11', 'done', 'Done'), 'Task completed');

    const hydrated = hydrateTaskStateFromComments('ISSUE-11', [
      { body, createdAt: '2026-03-18T01:00:00.000Z', user: 'unohee' },
    ]);

    expect(hydrated?.execution.status).toBe('done');
  });

  it('fails closed on corrupt persisted task-state files without overwriting them', () => {
    writeFileSync(stateFile, '{not-json', 'utf8');

    expect(() => getTaskState('ISSUE-CORRUPT')).toThrow(/Task state store is corrupt/);
    expect(readFileSync(stateFile, 'utf8')).toBe('{not-json');
  });

  describe('stale lock reclamation (AGT-4023)', () => {
    // Measured on vela: a container recreate left a well-formed lock behind,
    // the new daemon came up on the SAME pid (a container assigns it
    // deterministically), so the pid probe answered "alive" for the daemon's
    // own ghost. Fifteen straight heartbeats died on it, zero tasks ran for 75
    // minutes, and a manual rm was the only way out.
    const lockFile = () => `${stateFile}.lock`;

    it('reclaims a well-formed lock left at our own pid once it is long expired', () => {
      writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, token: 'ghost-token' }), 'utf8');
      const longAgo = new Date(Date.now() - 900_000);
      utimesSync(lockFile(), longAgo, longAgo);

      upsertTaskState('ISSUE-LOCK-1', { execution: { status: 'todo', retryCount: 0 } });

      expect(getTaskState('ISSUE-LOCK-1')?.execution.status).toBe('todo');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('respects a well-formed lock right up to the expiry, on its own clock', () => {
      // Pins the policy from below: a lock older than the 30s malformed clock
      // but inside the 10-minute one is still someone's — it may belong to a
      // live writer in another pid namespace sharing the mounted state file.
      // Shortening LOCK_ABANDON_MS toward LOCK_STALE_MS fails here.
      writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, token: 'possibly-live' }), 'utf8');
      const almostExpired = new Date(Date.now() - 570_000);
      utimesSync(lockFile(), almostExpired, almostExpired);

      expect(() => upsertTaskState('ISSUE-LOCK-2', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    // AGT-4068: the 10-minute wait above is a timer, not evidence, and it cost
    // ten minutes of dead heartbeats after every container restart — measured
    // on vela 2026-08-29, where the new daemon came up on pid 7 holding a lock
    // pid 7 had written 0.7s before the container was recreated. A pid is
    // unique among live processes, so a lock carrying OUR pid that predates our
    // start belongs to a process that has exited. No wait required.
    itWithPidSpace('reclaims a same-namespace lock at our own pid that predates this process, well inside the expiry', () => {
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid, token: 'prior-generation', ns: processNamespaceId(),
      }), 'utf8');
      const beforeWeStarted = new Date(PROCESS_STARTED_AT_MS - 60_000); // and only a minute old
      utimesSync(lockFile(), beforeWeStarted, beforeWeStarted);

      upsertTaskState('ISSUE-LOCK-5', { execution: { status: 'todo', retryCount: 0 } });

      expect(getTaskState('ISSUE-LOCK-5')?.execution.status).toBe('todo');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('does not reason about a pid from another pid space, however old the lock', () => {
      // Two containers sharing this mounted state file each have their own
      // pid 1, so a matching pid number means nothing across them. Such a lock
      // gets the age rule and nothing else — it may be a live writer.
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid, token: 'other-container', ns: 'some-other-host:pid:[4026531999]',
      }), 'utf8');
      const beforeWeStarted = new Date(PROCESS_STARTED_AT_MS - 60_000);
      utimesSync(lockFile(), beforeWeStarted, beforeWeStarted);

      expect(() => upsertTaskState('ISSUE-LOCK-6', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    it('does not reclaim a foreign-namespace lock just because its pid is dead here (AGT-4068)', () => {
      // The pid probe runs before any age rule, so an ESRCH answer reclaims
      // outright. That pid belongs to another container's space, where it may
      // be a live writer; our local probe is answering a different question.
      writeFileSync(lockFile(), JSON.stringify({
        pid: 2_147_483_647, // certainly not alive HERE
        token: 'other-container',
        ns: 'some-other-host:pid:[4026531999]',
      }), 'utf8');
      const recent = new Date(Date.now() - 60_000);
      utimesSync(lockFile(), recent, recent);

      expect(() => upsertTaskState('ISSUE-LOCK-7', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    it('still reclaims a legacy lock with no namespace recorded when its pid is dead', () => {
      // Locks written before the field existed keep the original behaviour.
      writeFileSync(lockFile(), JSON.stringify({ pid: 2_147_483_647, token: 'legacy' }), 'utf8');
      const recent = new Date(Date.now() - 60_000);
      utimesSync(lockFile(), recent, recent);

      upsertTaskState('ISSUE-LOCK-8', { execution: { status: 'todo', retryCount: 0 } });

      expect(getTaskState('ISSUE-LOCK-8')?.execution.status).toBe('todo');
    });

    it('does not probe a lock whose writer could name no pid space at all (AGT-4068)', () => {
      // `ns: null` is a writer that could not read its own pid namespace, so
      // our pid table is not its pid table and a local ESRCH means nothing.
      // Distinct from an ABSENT ns, which predates the field and keeps the
      // original probe — an omitted key would have conflated the two.
      writeFileSync(lockFile(), JSON.stringify({
        pid: 2_147_483_647, token: 'unknown-space', ns: null,
      }), 'utf8');
      const recent = new Date(Date.now() - 60_000);
      utimesSync(lockFile(), recent, recent);

      expect(() => upsertTaskState('ISSUE-LOCK-9', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    it('withholds the fast-path proof from a lock with no named pid space (AGT-4068)', () => {
      // Our own pid, written before we started — the proof would reclaim this
      // at once if the space were named and matched. Unnamed, it must wait out
      // the age rule like any pre-field lock.
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid, token: 'unknown-space-live-pid', ns: null,
      }), 'utf8');
      const beforeWeStarted = new Date(PROCESS_STARTED_AT_MS - 60_000);
      utimesSync(lockFile(), beforeWeStarted, beforeWeStarted);

      expect(() => upsertTaskState('ISSUE-LOCK-10', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    it('does not let a matching machine HINT license the pid proof (AGT-4068)', () => {
      // `host:<name>` matches ours, which keeps the local probe — but it does
      // not establish that our pid numbering is the writer's, so the proof
      // stays off and the age rule governs.
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid, token: 'hint-not-proof', ns: `host:${hostname()}`,
      }), 'utf8');
      const beforeWeStarted = new Date(PROCESS_STARTED_AT_MS - 60_000);
      utimesSync(lockFile(), beforeWeStarted, beforeWeStarted);

      expect(() => upsertTaskState('ISSUE-LOCK-11', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    itWithPidSpace('reclaims a prior-generation lock written half a second before we started (AGT-4071)', () => {
      // The production case, at production timing: the outgoing container wrote
      // this at 17:12:12.670 and its successor started at 17:12:13.231. The
      // timestamp path cannot see 0.561 s past a 1 s margin; the owner id can.
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid,
        token: 'prior-generation',
        ns: processNamespaceId(),
        instance: 'a-previous-boot',
      }), 'utf8');
      const justBeforeWeStarted = new Date(PROCESS_STARTED_AT_MS - 500);
      utimesSync(lockFile(), justBeforeWeStarted, justBeforeWeStarted);

      upsertTaskState('ISSUE-LOCK-12', { execution: { status: 'todo', retryCount: 0 } });

      expect(getTaskState('ISSUE-LOCK-12')?.execution.status).toBe('todo');
      expect(existsSync(lockFile())).toBe(false);
    });

    itWithPidSpace('does not reclaim a lock this very process holds, however its mtime reads (AGT-4071)', () => {
      // A coarse-granularity filesystem can report our own fresh lock as older
      // than our start. The owner id keeps that from mattering.
      writeFileSync(lockFile(), JSON.stringify({
        pid: process.pid,
        token: 'ours-right-now',
        ns: processNamespaceId(),
        instance: getInstanceId(),
      }), 'utf8');
      const impossiblyOld = new Date(PROCESS_STARTED_AT_MS - 500);
      utimesSync(lockFile(), impossiblyOld, impossiblyOld);

      expect(() => upsertTaskState('ISSUE-LOCK-13', { execution: { status: 'todo', retryCount: 0 } }))
        .toThrow(/Timed out waiting for task state lock/);
    });

    it('records who holds it, so a successor can decide ownership without a clock (AGT-4071)', () => {
      const payload = buildLockPayload('tok-1');
      expect(payload.pid).toBe(process.pid);
      expect(payload.token).toBe('tok-1');
      expect(payload.instance).toBe(getInstanceId());
      // `null`, not absent: an omitted key reads as "written before the field
      // existed", which is entitled to a local pid probe.
      expect('ns' in payload).toBe(true);
      expect(payload.ns).toBe(processNamespaceId() ?? null);
    });

    it('still ages out a lock with no readable owner on the shorter clock', () => {
      writeFileSync(lockFile(), 'not-json-at-all', 'utf8');
      const longAgo = new Date(Date.now() - 120_000);
      utimesSync(lockFile(), longAgo, longAgo);

      upsertTaskState('ISSUE-LOCK-4', { execution: { status: 'todo', retryCount: 0 } });

      expect(getTaskState('ISSUE-LOCK-4')?.execution.status).toBe('todo');
    });
  });
});
