// ============================================
// OpenSwarm - Periodic read-only review jobs
// ============================================

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { getCoordinationStore } from './coordinationStore.js';
import { coordinationStateDir } from './coordinationPaths.js';
import { runReviewer } from '../agents/reviewer.js';
import type { AdapterName } from '../adapters/types.js';
import type { WorkerResult } from '../agents/agentPair.js';
import { withFileLock } from '../support/fileLock.js';
import { assignCallSign } from './agentNames.js';

const execFileAsync = promisify(execFile);

export type PeriodicReviewProfile = 'permissions' | 'hygiene' | 'security' | 'review';

export interface PeriodicReviewInput {
  repository: string;
  taskId: string;
  profile: PeriodicReviewProfile;
  adapter?: AdapterName;
}

export interface PeriodicReviewResult {
  success: boolean;
  profile: PeriodicReviewProfile;
  summary: string;
  fingerprint: string;
}

const running = new Set<string>();

function key(input: PeriodicReviewInput): string {
  return createHash('sha256').update(`${input.repository}\0${input.profile}`).digest('hex');
}

/**
 * Where one repository's periodic review takes its lock.
 *
 * Deliberately not inside `.git`: in a linked worktree `.git` is a file, so a
 * path under it fails to create and the scheduled job throws instead of
 * skipping. Keyed by a hash of the repository path, and placed beside the
 * coordination board so it follows the same redirection under test.
 */
function lockPath(input: PeriodicReviewInput): string {
  return join(coordinationStateDir(), 'locks', `review-${input.profile}-${key(input).slice(0, 16)}.lock`);
}

async function command(executable: string, args: string[], cwd: string): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { cwd, timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { success: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (error) { // cxt-ignore: error_swallow,exception_hiding — a failing check is the review's finding, not a crash
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { success: false, output: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`.trim() };
  }
}

async function execute(input: PeriodicReviewInput): Promise<{ success: boolean; output: string }> {
  if (input.profile === 'permissions') return command('cxt', ['audit', '--json'], input.repository);
  if (input.profile === 'hygiene') return command('cxt', ['bs', '--json'], input.repository);
  if (input.profile === 'security') {
    // The CLI's hardened review path is read-only and includes deterministic
    // security review policy. It never applies fixes in this profile.
    return command('openswarm', ['review', '--read-only'], input.repository);
  }
  const workerResult: WorkerResult = {
    success: true,
    summary: 'Periodic repository review',
    filesChanged: [],
    commands: [],
    output: '',
    noChangesReason: 'Read-only periodic audit of the existing repository',
  };
  const callSign = assignCallSign({ repository: input.repository, executionId: input.profile, role: 'review-agent' });
  const review = await runReviewer({
    taskTitle: 'Periodic repository review',
    taskDescription: 'Audit the repository for correctness, security, permissions, and maintainability findings. Do not modify files.',
    workerResult,
    projectPath: input.repository,
    adapterName: input.adapter,
    mode: 'audit',
    readOnly: true,
    coordinationContext: {
      repository: input.repository,
      taskId: input.taskId,
      actor: callSign.address,
      actorName: callSign.name,
    },
  });
  return { success: review.decision === 'approve', output: review.feedback };
}

export async function runPeriodicReview(input: PeriodicReviewInput): Promise<PeriodicReviewResult | null> {
  const leaseKey = key(input);
  if (running.has(leaseKey)) return null;
  running.add(leaseKey);
  try {
    return await withFileLock(lockPath(input), async () => {
      const callSign = assignCallSign({ repository: input.repository, executionId: input.profile, role: 'review-agent' });
      await getCoordinationStore().publish({
        repository: input.repository, taskId: input.taskId, actor: callSign.address, actorName: callSign.name, kind: 'review-run', status: 'running', correlationId: leaseKey, summary: `Periodic ${input.profile} review started`,
      });
      const result = await execute(input);
      const summary = result.output.slice(-4_000) || `${input.profile} review produced no output`;
      const fingerprint = createHash('sha256').update(`${input.profile}\0${summary}`).digest('hex');
      await getCoordinationStore().publish({
        repository: input.repository, taskId: input.taskId, actor: callSign.address, actorName: callSign.name, kind: 'review-run', status: result.success ? 'completed' : 'failed', correlationId: leaseKey, summary, metadata: { profile: input.profile, fingerprint, agent: callSign.name },
      });
      return { success: result.success, profile: input.profile, summary, fingerprint };
    }, { timeoutMs: 50 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Timed out waiting for file lock')) return null;
    throw error;
  } finally {
    running.delete(leaseKey);
  }
}
