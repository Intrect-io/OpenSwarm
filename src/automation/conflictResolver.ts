// ============================================
// OpenSwarm - Self-Healing PR Conflict Resolver
// Detects and auto-resolves merge conflicts on bot-owned PRs
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConflictResolverConfig } from '../core/types.js';
import type { PRInfo } from '../github/github.js';
import { getPRBaseBranch, commentOnPR, waitForCICompletion } from '../github/github.js';
import { isOwnedPR, getOwnedPRsForRepo } from './prOwnership.js';
import { runWorker } from '../agents/worker.js';
import { broadcastEvent } from '../core/eventHub.js';
import { reportEvent } from '../discord/index.js';

const execFileAsync = promisify(execFile);

/** Safe git execution (no shell) */
async function gitExec(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

// ============================================
// Types
// ============================================

interface ResolutionAttempt {
  repo: string;
  prNumber: number;
  attempts: number;
  lastAttempt?: string;
}

// ============================================
// ConflictResolver
// ============================================

export class ConflictResolver {
  private config: ConflictResolverConfig;
  private attempts = new Map<string, ResolutionAttempt>();

  constructor(config: ConflictResolverConfig) {
    this.config = config;
  }

  /** Whether resolver is enabled */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Whether cascade checks are enabled */
  cascadeEnabled(): boolean {
    return this.config.cascadeCheck;
  }

  /**
   * Check if we can resolve conflicts for this PR
   * - Ownership check (auto mode: bot-created only, all mode: any PR)
   * - Attempt limit check
   */
  async canResolve(pr: PRInfo): Promise<boolean> {
    // Ownership check
    if (this.config.ownershipMode === 'auto') {
      const owned = await isOwnedPR(pr.repo, pr.number);
      if (!owned) {
        console.log(`[ConflictResolver] ${pr.repo}#${pr.number}: not owned, skipping`);
        return false;
      }
    }

    // Attempt limit
    const key = `${pr.repo}#${pr.number}`;
    const existing = this.attempts.get(key);
    if (existing && existing.attempts >= this.config.maxResolutionAttempts) {
      console.log(`[ConflictResolver] ${key}: max attempts reached (${existing.attempts}/${this.config.maxResolutionAttempts})`);
      return false;
    }

    return true;
  }

  /**
   * Resolve merge conflicts for a PR
   * @returns true if conflicts were resolved successfully
   */
  async resolve(pr: PRInfo, projectPath: string): Promise<boolean> {
    const key = `${pr.repo}#${pr.number}`;
    console.log(`[ConflictResolver] Resolving conflicts for ${key}...`);

    // Track attempt
    const existing = this.attempts.get(key) || { repo: pr.repo, prNumber: pr.number, attempts: 0 };
    existing.attempts++;
    existing.lastAttempt = new Date().toISOString();
    this.attempts.set(key, existing);

    // Broadcast event
    broadcastEvent({
      type: 'conflict:detected',
      data: { repo: pr.repo, prNumber: pr.number, branch: pr.branch },
    });

    await reportEvent({
      type: 'pr_conflict_detected',
      session: 'conflict-resolver',
      message: `**${pr.repo}#${pr.number}** "${pr.title}" has merge conflicts (attempt ${existing.attempts}/${this.config.maxResolutionAttempts})`,
      timestamp: Date.now(),
      url: pr.url,
    });

    // Save current branch for restoration
    let originalBranch = 'main';
    try {
      originalBranch = (await gitExec(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    } catch {
      // fallback to main
    }

    try {
      // 1. Get base branch
      const baseBranch = await getPRBaseBranch(pr.repo, pr.number);
      console.log(`[ConflictResolver] ${key}: base=${baseBranch}, head=${pr.branch}`);

      broadcastEvent({
        type: 'conflict:resolving',
        data: { repo: pr.repo, prNumber: pr.number, branch: pr.branch, attempt: existing.attempts },
      });

      await reportEvent({
        type: 'pr_conflict_resolving',
        session: 'conflict-resolver',
        message: `**${pr.repo}#${pr.number}** resolving conflicts (attempt ${existing.attempts})...`,
        timestamp: Date.now(),
        url: pr.url,
      });

      // 2. Fetch latest
      await gitExec(projectPath, 'fetch', 'origin');

      // 3. Checkout PR branch
      await gitExec(projectPath, 'checkout', pr.branch);
      await gitExec(projectPath, 'pull', 'origin', pr.branch);

      // 4. Try merge
      let autoMerged = false;
      try {
        await gitExec(projectPath, 'merge', `origin/${baseBranch}`, '--no-edit');
        autoMerged = true;
        console.log(`[ConflictResolver] ${key}: auto-merge succeeded`);
      } catch {
        // Merge conflicts exist — proceed to manual resolution
        console.log(`[ConflictResolver] ${key}: auto-merge failed, resolving manually...`);
      }

      if (!autoMerged) {
        // 5. Get conflicted files
        const conflictOutput = await gitExec(projectPath, 'diff', '--name-only', '--diff-filter=U');
        const conflictedFiles = conflictOutput.trim().split('\n').filter(Boolean);

        if (conflictedFiles.length === 0) {
          // No actual conflicts (maybe already resolved)
          console.log(`[ConflictResolver] ${key}: no conflicted files found, aborting merge`);
          await gitExec(projectPath, 'merge', '--abort').catch(() => {});
          return false;
        }

        console.log(`[ConflictResolver] ${key}: ${conflictedFiles.length} conflicted files: ${conflictedFiles.join(', ')}`);

        // 6. Spawn worker to resolve conflicts
        const workerResult = await runWorker({
          taskTitle: `Resolve merge conflicts: ${pr.title}`,
          taskDescription: [
            `## Merge Conflict Resolution`,
            ``,
            `**PR:** #${pr.number} - ${pr.title}`,
            `**Branch:** ${pr.branch} ← ${baseBranch}`,
            ``,
            `## Conflicted Files`,
            conflictedFiles.map((f) => `- ${f}`).join('\n'),
            ``,
            `## Instructions`,
            `1. Open each conflicted file and resolve the merge conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)`,
            `2. Keep BOTH sides' changes where possible. When the same line was modified by both sides, prefer the HEAD (PR branch) version.`,
            `3. After resolving each file, run \`git add <file>\` for each resolved file.`,
            `4. Do NOT run git commit — only resolve conflicts and stage files.`,
            `5. Do NOT modify any files that are not in the conflicted files list.`,
            `6. Ensure the resolved code compiles and makes logical sense.`,
          ].join('\n'),
          projectPath,
          model: this.config.workerModel,
          timeoutMs: this.config.workerTimeoutMs || 300_000,
        });

        if (!workerResult.success) {
          console.log(`[ConflictResolver] ${key}: worker failed - ${workerResult.error}`);
          await gitExec(projectPath, 'merge', '--abort').catch(() => {});
          await this.reportFailure(pr, `Worker failed: ${workerResult.error || 'unknown error'}`);
          return false;
        }

        // 7. Verify all conflicts are resolved
        const remaining = await gitExec(projectPath, 'diff', '--name-only', '--diff-filter=U').catch(() => '');
        if (remaining.trim()) {
          console.log(`[ConflictResolver] ${key}: unresolved files remain: ${remaining.trim()}`);
          await gitExec(projectPath, 'merge', '--abort').catch(() => {});
          await this.reportFailure(pr, `Unresolved conflicts remain: ${remaining.trim()}`);
          return false;
        }

        // 8. Commit the merge
        await gitExec(projectPath, 'commit', '-m', `chore: resolve merge conflicts with ${baseBranch}\n\n🤖 Auto-resolved by OpenSwarm ConflictResolver`);
        console.log(`[ConflictResolver] ${key}: merge committed`);
      }

      // 9. Push
      await gitExec(projectPath, 'push', 'origin', pr.branch);
      console.log(`[ConflictResolver] ${key}: pushed to origin`);

      // 10. Report success
      const filesResolved = autoMerged ? 0 : (await gitExec(projectPath, 'diff', '--name-only', 'HEAD~1')).trim().split('\n').filter(Boolean).length;

      broadcastEvent({
        type: 'conflict:resolved',
        data: { repo: pr.repo, prNumber: pr.number, branch: pr.branch, filesResolved },
      });

      await commentOnPR(
        pr.repo,
        pr.number,
        [
          `## ✅ Merge conflicts resolved`,
          '',
          autoMerged
            ? 'Conflicts were automatically resolved by Git.'
            : `Resolved ${filesResolved} conflicted file(s) using AI-assisted merge.`,
          '',
          `Attempt: ${existing.attempts}/${this.config.maxResolutionAttempts}`,
          '',
          '🤖 *OpenSwarm ConflictResolver*',
        ].join('\n'),
      );

      await reportEvent({
        type: 'pr_conflict_resolved',
        session: 'conflict-resolver',
        message: `**${pr.repo}#${pr.number}** "${pr.title}" conflicts resolved${autoMerged ? ' (auto-merge)' : ` (${filesResolved} files)`}`,
        timestamp: Date.now(),
        url: pr.url,
      });

      return true;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ConflictResolver] ${key} error:`, errorMsg);

      // Abort any pending merge
      await gitExec(projectPath, 'merge', '--abort').catch(() => {});
      await this.reportFailure(pr, errorMsg);
      return false;

    } finally {
      // Always restore original branch
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
      } catch (restoreErr) {
        console.error(`[ConflictResolver] Failed to restore branch ${originalBranch}:`, restoreErr);
      }
    }
  }

  /**
   * Check other owned PRs in the same repo for cascading conflicts
   */
  async checkCascade(repo: string): Promise<void> {
    if (!this.config.cascadeCheck) return;

    const ownedPRs = await getOwnedPRsForRepo(repo);
    if (ownedPRs.length <= 1) return;

    console.log(`[ConflictResolver] Cascade check: ${repo} has ${ownedPRs.length} owned PRs`);
    // Cascade check is informational — actual resolution happens in the next processPRs cycle
  }

  /** Report failure via events and PR comment */
  private async reportFailure(pr: PRInfo, reason: string): Promise<void> {
    const key = `${pr.repo}#${pr.number}`;
    const attempt = this.attempts.get(key);

    broadcastEvent({
      type: 'conflict:failed',
      data: { repo: pr.repo, prNumber: pr.number, branch: pr.branch, reason },
    });

    const isMaxAttempts = attempt && attempt.attempts >= this.config.maxResolutionAttempts;

    await commentOnPR(
      pr.repo,
      pr.number,
      [
        `## ⚠️ Conflict resolution failed`,
        '',
        `**Reason:** ${reason}`,
        `**Attempt:** ${attempt?.attempts ?? '?'}/${this.config.maxResolutionAttempts}`,
        '',
        isMaxAttempts
          ? '❌ Max attempts reached. Manual intervention required.'
          : '🔄 Will retry on next check cycle.',
        '',
        '🤖 *OpenSwarm ConflictResolver*',
      ].join('\n'),
    );

    await reportEvent({
      type: 'pr_conflict_failed',
      session: 'conflict-resolver',
      message: `**${pr.repo}#${pr.number}** "${pr.title}" conflict resolution failed: ${reason}${isMaxAttempts ? ' (MAX ATTEMPTS - escalation needed)' : ''}`,
      timestamp: Date.now(),
      url: pr.url,
    });
  }
}
