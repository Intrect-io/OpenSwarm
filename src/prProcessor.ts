// ============================================
// Claude Swarm - PR Auto-Improvement Processor
// Open PR 자동 개선 (Worker-Reviewer 반복 루프)
// ============================================

import { Cron } from 'croner';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getOpenPRs,
  getPRContext,
  commentOnPR,
  type PRInfo,
} from './github.js';
import {
  createPipelineFromConfig,
} from './pairPipeline.js';
import { getScheduler } from './taskScheduler.js';
import { reportEvent } from './discord.js';
import type { TaskItem } from './decisionEngine.js';
import type { DefaultRolesConfig } from './types.js';

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

export interface PRProcessorConfig {
  repos: string[];
  schedule: string;
  cooldownHours: number;
  maxIterations: number;
  roles?: DefaultRolesConfig;
}

type PRStateEntry = {
  repo: string;
  prNumber: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  iterations: number;
  lastProcessed?: string;
  lastError?: string;
};

type PRState = {
  prs: Record<string, PRStateEntry>;
  updatedAt: string;
};

// ============================================
// Constants
// ============================================

const PR_STATE_PATH = resolve(homedir(), '.claude-swarm', 'pr-state.json');

// ============================================
// PR Processor
// ============================================

export class PRProcessor {
  private config: PRProcessorConfig;
  private cronJob: Cron | null = null;
  private processing = false;

  constructor(config: PRProcessorConfig) {
    this.config = config;
  }

  /**
   * 스케줄 시작
   */
  start(): void {
    console.log(`[PRProcessor] Starting (schedule: ${this.config.schedule})`);

    this.cronJob = new Cron(this.config.schedule, async () => {
      await this.processPRs();
    });

    // 30초 후 초기 실행
    setTimeout(() => {
      void this.processPRs().catch((err) => {
        console.error('[PRProcessor] Initial run error:', err);
      });
    }, 30_000);
  }

  /**
   * 스케줄 중지
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    console.log('[PRProcessor] Stopped');
  }

  /**
   * 모든 레포의 open PR 처리
   */
  async processPRs(): Promise<void> {
    if (this.processing) {
      console.log('[PRProcessor] Already processing, skipping');
      return;
    }

    this.processing = true;
    console.log('[PRProcessor] Checking PRs...');

    try {
      const state = await this.loadState();

      for (const repo of this.config.repos) {
        const prs = await getOpenPRs(repo);
        if (prs.length === 0) continue;

        console.log(`[PRProcessor] ${repo}: ${prs.length} open PRs`);

        for (const pr of prs) {
          const key = `${repo}#${pr.number}`;

          // 쿨다운 체크
          const existing = state.prs[key];
          if (existing?.lastProcessed) {
            const hoursSince =
              (Date.now() - new Date(existing.lastProcessed).getTime()) / (1000 * 60 * 60);
            if (hoursSince < this.config.cooldownHours) {
              console.log(`[PRProcessor] ${key}: cooldown (${hoursSince.toFixed(1)}h < ${this.config.cooldownHours}h)`);
              continue;
            }
          }

          // CI 체크 상태 확인 — 실패한 PR만 처리
          const { getPRChecks } = await import('./github.js');
          const checks = await getPRChecks(repo, pr.number);
          const hasFailure = checks.some(
            (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
          );
          if (!hasFailure && checks.length > 0) {
            console.log(`[PRProcessor] ${key}: CI passing, skipping`);
            continue;
          }

          // 프로젝트 경로 매핑
          const projectPath = this.mapRepoToProject(repo);
          if (!projectPath) {
            console.log(`[PRProcessor] ${key}: no local project found, skipping`);
            continue;
          }

          // TaskScheduler 동시성 체크
          try {
            const scheduler = getScheduler();
            if (scheduler.isProjectBusy(projectPath)) {
              console.log(`[PRProcessor] ${key}: project busy (Linear task running)`);
              continue;
            }
            if (!scheduler.hasAvailableSlot()) {
              console.log(`[PRProcessor] ${key}: no available slots`);
              break; // 슬롯 없으면 전체 중단
            }
          } catch {
            // Scheduler 미초기화 시 무시하고 진행
          }

          // PR 처리
          state.prs[key] = {
            repo,
            prNumber: pr.number,
            status: 'processing',
            iterations: 0,
            lastProcessed: new Date().toISOString(),
          };
          await this.saveState(state);

          await this.processPR(pr, projectPath, state, key);
        }
      }

      await this.saveState(state);
    } catch (err) {
      console.error('[PRProcessor] Error:', err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * 단일 PR 처리
   */
  private async processPR(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string
  ): Promise<void> {
    console.log(`[PRProcessor] Processing ${key}: "${pr.title}"`);

    // 현재 브랜치 저장 (복원용)
    let originalBranch = 'main';
    try {
      const { stdout } = await execAsync(
        `git -C ${projectPath} rev-parse --abbrev-ref HEAD`
      );
      originalBranch = stdout.trim();
    } catch {
      // 실패 시 main 사용
    }

    try {
      // 1. PR 상세 컨텍스트 조회
      const details = await getPRContext(pr.repo, pr.number);
      if (!details) {
        state.prs[key].status = 'failed';
        state.prs[key].lastError = 'Failed to get PR context';
        return;
      }

      // 2. git fetch + checkout PR 브랜치
      await execAsync(
        `git -C ${projectPath} fetch origin ${pr.branch} && git -C ${projectPath} checkout ${pr.branch}`
      );

      // 3. TaskItem 구성
      const diffSnippet = details.diff.slice(0, 5000);
      const failedChecksList = details.failedChecks
        ?.map((c) => `- ${c.name}: ${c.conclusion}`)
        .join('\n') || 'N/A';
      const failedLogsSnippet = details.failedLogs?.slice(0, 3000) || '';

      const task: TaskItem = {
        id: `pr-${pr.repo}-${pr.number}`,
        source: 'github_pr',
        title: `Fix PR #${pr.number}: ${pr.title}`,
        description: [
          `## PR Context`,
          `**Title:** ${pr.title}`,
          `**Branch:** ${pr.branch}`,
          `**Author:** ${details.author}`,
          '',
          details.body ? `**Description:**\n${details.body}\n` : '',
          `## Failed CI Checks`,
          failedChecksList,
          '',
          failedLogsSnippet ? `## Failed Logs (last 3000 chars)\n\`\`\`\n${failedLogsSnippet}\n\`\`\`\n` : '',
          `## Diff (first 5000 chars)`,
          '```diff',
          diffSnippet,
          '```',
          '',
          '## Instructions',
          'Fix CI failures. Do NOT change the overall approach or architecture.',
          'Focus on: type errors, lint errors, test failures, build errors.',
          'Make minimal changes to get CI passing.',
        ].join('\n'),
        priority: 2,
        projectPath,
        issueId: `pr-${pr.number}`,
        workflowId: undefined,
        createdAt: Date.now(),
      };

      // 4. 파이프라인 실행
      const pipeline = createPipelineFromConfig(
        this.config.roles,
        this.config.maxIterations
      );
      const result = await pipeline.run(task, projectPath);

      state.prs[key].iterations = result.iterations;

      // 5. 결과 처리
      if (result.success) {
        // git push
        await execAsync(`git -C ${projectPath} push origin ${pr.branch}`);

        // PR 코멘트
        const summary = result.workerResult?.summary || 'CI issues fixed';
        const filesChanged = result.workerResult?.filesChanged?.join(', ') || 'N/A';
        await commentOnPR(
          pr.repo,
          pr.number,
          [
            `## 🤖 Auto-fix applied`,
            '',
            `**Summary:** ${summary}`,
            `**Files changed:** ${filesChanged}`,
            `**Iterations:** ${result.iterations}`,
            `**Duration:** ${(result.totalDuration / 1000).toFixed(0)}s`,
          ].join('\n')
        );

        // Discord 보고
        await reportEvent({
          type: 'pr_improved',
          session: 'pr-processor',
          message: `**${pr.repo}#${pr.number}** "${pr.title}" CI 수정 완료\n${summary}`,
          timestamp: Date.now(),
          url: pr.url,
        });

        state.prs[key].status = 'completed';
        console.log(`[PRProcessor] ${key}: SUCCESS`);

      } else {
        // 실패 시 PR 코멘트
        const reason = result.reviewResult?.feedback
          || result.workerResult?.error
          || 'Pipeline failed after max iterations';
        await commentOnPR(
          pr.repo,
          pr.number,
          [
            `## 🤖 Auto-fix attempted (failed)`,
            '',
            `**Status:** ${result.finalStatus}`,
            `**Iterations:** ${result.iterations}`,
            `**Reason:** ${reason}`,
          ].join('\n')
        );

        // Discord 보고
        await reportEvent({
          type: 'pr_failed',
          session: 'pr-processor',
          message: `**${pr.repo}#${pr.number}** "${pr.title}" 자동 수정 실패\n${reason}`,
          timestamp: Date.now(),
          url: pr.url,
        });

        state.prs[key].status = 'failed';
        state.prs[key].lastError = reason;
        console.log(`[PRProcessor] ${key}: FAILED - ${reason}`);
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PRProcessor] ${key} error:`, errorMsg);
      state.prs[key].status = 'failed';
      state.prs[key].lastError = errorMsg;

    } finally {
      // 브랜치 복원
      try {
        await execAsync(`git -C ${projectPath} checkout ${originalBranch}`);
      } catch (restoreErr) {
        console.error(`[PRProcessor] Failed to restore branch ${originalBranch}:`, restoreErr);
      }
    }
  }

  /**
   * 레포 → 로컬 프로젝트 경로 매핑
   */
  private mapRepoToProject(repo: string): string | null {
    // "Intrect-io/STONKS" → "STONKS"
    const repoName = repo.split('/').pop();
    if (!repoName) return null;

    const candidate = resolve(homedir(), 'dev', repoName);
    if (existsSync(candidate)) {
      return candidate;
    }

    console.log(`[PRProcessor] No local directory for ${repo} (tried: ${candidate})`);
    return null;
  }

  // ============================================
  // State Persistence
  // ============================================

  private async loadState(): Promise<PRState> {
    try {
      const data = await readFile(PR_STATE_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return { prs: {}, updatedAt: new Date().toISOString() };
    }
  }

  private async saveState(state: PRState): Promise<void> {
    await mkdir(resolve(homedir(), '.claude-swarm'), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(PR_STATE_PATH, JSON.stringify(state, null, 2));
  }
}
