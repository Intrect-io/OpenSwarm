// ============================================
// OpenSwarm - PR Processor
// Created: 2026-04-03
// Purpose: PR conflict resolution, review feedback processing, CI monitoring
// Dependencies: git, gh CLI, @linear/sdk
// ============================================

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { withStoreLock } from '../taskState/store.js';

// ============================================
// Types & Interfaces
// ============================================

interface PRInfo {
  repo: string;
  number: number;
  title: string;
  branch: string;
  base: string;
  author: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

interface AutoStash {
  index: string;
  message: string;
}

interface PRIssueComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

interface IntegrationSiblingResult {
  prNumber: number;
  repo: string;
  status: string;
  error?: string;
}

interface PRState {
  prs: Record<string, {
    repo: string;
    prNumber: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    iterations: number;
    lastError?: string;
    lastReviewState?: string;
  }>;
  integrations: Record<string, IntegrationSiblingResult>;
  integrationBaselines: Record<string, string>;
  updatedAt: string;
}

interface PRProcessorConfig {
  projectPath: string;
  remoteUrl?: string;
  ghToken?: string;
  linearApiKey?: string;
  linearTeamId?: string;
}

// ============================================
// Constants
// ============================================

const STATE_FILE = '.openswarm-pr-state.json';
const FEEDBACK_ADDRESSED_MARKERS = [
  '<!-- openswarm:feedback-addressed -->',
  '<!-- openswarm:feedback-acknowledged -->',
];

// ============================================
// Utility Functions
// ============================================

function gitExec(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

function ghRepoView(cwd: string, remoteUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', ['repo', 'view', remoteUrl, '--json', 'name,owner'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gh repo view failed: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

function matchesCriticalKeyword(bodyLower: string): boolean {
  const keywords = [
    'security', 'vulnerability', 'cve', 'exploit', 'xss', 'sqli', 'rce',
    'remote code execution', 'sql injection', 'cross-site scripting',
    'authentication bypass', 'privilege escalation', 'data breach',
    'sensitive data exposure', 'insecure deserialization',
  ];
  return keywords.some((kw) => bodyLower.includes(kw));
}

function parseStashList(output: string): Array<{ index: string; message: string }> {
  if (!output.trim()) return [];
  return output.split('\n').map((line) => {
    const match = line.match(/^stash@\{(\d+)\}: (.+)$/);
    return match ? { index: match[1], message: match[2] } : null;
  }).filter(Boolean) as Array<{ index: string; message: string }>;
}

async function stashLocalChanges(cwd: string, message: string): Promise<AutoStash | null> {
  const status = await gitExec(cwd, 'status', '--porcelain');
  if (!status.trim()) return null;

  await gitExec(cwd, 'stash', 'push', '-u', '-m', message);
  const list = await gitExec(cwd, 'stash', 'list');
  const stashes = parseStashList(list);
  if (stashes.length === 0) return null;

  return { index: stashes[0].index, message };
}

async function restoreAutoStash(cwd: string, stash: AutoStash | null): Promise<void> {
  if (!stash) return;
  try {
    await gitExec(cwd, 'stash', 'pop', `stash@{${stash.index}}`);
  } catch {
    // Stash may have been popped already
  }
}

function isReviewBotComment(comment: PRIssueComment): boolean {
  const botAuthors = ['github-actions[bot]', 'openswarm[bot]', 'code-review[bot]'];
  return botAuthors.includes(comment.author) || comment.body.includes('<!-- openswarm:review -->');
}

function getActiveCriticalComments(comments: PRIssueComment[]): PRIssueComment[] {
  return comments.filter((c) => {
    if (!isReviewBotComment(c)) return false;
    const bodyLower = c.body.toLowerCase();
    return matchesCriticalKeyword(bodyLower);
  });
}

// ============================================
// Main PR Processor Class
// ============================================

class PRProcessor {
  private config: PRProcessorConfig;
  private currentPR: PRInfo | null = null;

  constructor(config: PRProcessorConfig) {
    this.config = config;
  }

  /**
   * Load PR state from disk
   */
  private async loadState(): Promise<PRState> {
    const statePath = join(this.config.projectPath, STATE_FILE);
    try {
      const data = readFileSync(statePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {
        prs: {},
        integrations: {},
        integrationBaselines: {},
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Save PR state to disk
   */
  private async saveState(state: PRState): Promise<void> {
    const statePath = join(this.config.projectPath, STATE_FILE);
    state.updatedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Get diff text for a PR
   */
  private async getDiffText(pr: PRInfo, projectPath: string): Promise<string> {
    try {
      // Fetch PR diff using gh CLI
      const diff = execSync(
        `gh pr diff ${pr.number} --repo ${pr.repo}`,
        { cwd: projectPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      return diff;
    } catch {
      return '';
    }
  }

  /**
   * Process review feedback for a PR
   */
  private async processReviewFeedback(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string,
    iteration: number
  ): Promise<void> {
    // Get PR comments
    const comments = await this.getPRComments(pr, projectPath);
    const criticalComments = getActiveCriticalComments(comments);

    if (criticalComments.length === 0) {
      state.prs[key].status = 'completed';
      return;
    }

    // Apply fixes for each critical comment
    for (const comment of criticalComments) {
      await this.applyFixForComment(pr, projectPath, comment);
    }

    state.prs[key].iterations = iteration + 1;
    state.prs[key].status = 'completed';
  }

  /**
   * Get PR comments
   */
  private async getPRComments(pr: PRInfo, projectPath: string): Promise<PRIssueComment[]> {
    try {
      const output = execSync(
        `gh pr view ${pr.number} --repo ${pr.repo} --json comments --jq '.comments[] | {id, body, author: .author.login, createdAt, updatedAt}'`,
        { cwd: projectPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
      );
      return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Apply fix for a comment
   */
  private async applyFixForComment(
    pr: PRInfo,
    projectPath: string,
    comment: PRIssueComment
  ): Promise<void> {
    // Checkout PR branch
    await gitExec(projectPath, 'checkout', pr.branch);

    // Apply fix based on comment
    const fixScript = this.generateFixScript(comment);
    if (fixScript) {
      execSync(fixScript, { cwd: projectPath, timeout: 30000 });
    }

    // Commit and push
    await gitExec(projectPath, 'add', '-A');
    await gitExec(projectPath, 'commit', '-m', `fix: address review feedback\n\n${comment.body}`);
    await gitExec(projectPath, 'push', 'origin', pr.branch);
  }

  /**
   * Generate fix script from comment
   */
  private generateFixScript(comment: PRIssueComment): string | null {
    const bodyLower = comment.body.toLowerCase();

    if (bodyLower.includes('security') || bodyLower.includes('vulnerability')) {
      return 'npm audit fix';
    }

    if (bodyLower.includes('lint') || bodyLower.includes('format')) {
      return 'npx eslint --fix . && npx prettier --write .';
    }

    if (bodyLower.includes('test')) {
      return 'npm test';
    }

    return null;
  }

  /**
   * Process a single PR: fetch, review, fix, verify CI
   */
  private async processPR(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string
  ): Promise<void> {
    try {
      // Checkout PR branch
      await gitExec(projectPath, 'checkout', pr.branch);

      // Run review
      const { hasIssues, issues } = await this.runReview(pr, projectPath);

      if (!hasIssues) {
        state.prs[key].status = 'completed';
        return;
      }

      // Apply fixes
      for (const issue of issues) {
        await this.applyFix(pr, projectPath, issue);
      }

      // Verify CI
      const ciPassed = await this.verifyCI(pr, projectPath);
      state.prs[key].status = ciPassed ? 'completed' : 'failed';
      state.prs[key].iterations = (state.prs[key].iterations || 0) + 1;
    } catch (error) {
      state.prs[key].status = 'failed';
      state.prs[key].lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Run code review on the PR
   */
  private async runReview(
    pr: PRInfo,
    projectPath: string
  ): Promise<{ hasIssues: boolean; issues: string[] }> {
    // Get diff
    const diff = await this.getDiffText(pr, projectPath);

    if (!diff) {
      return { hasIssues: false, issues: [] };
    }

    // Run review using the review system
    const { runReviewer } = await import('../agents/reviewer.js');
    const result = await runReviewer({
      task: `Review PR #${pr.number} in ${pr.repo}`,
      files: [],
      diff,
      projectPath,
    });

    return {
      hasIssues: result.feedback.length > 0,
      issues: result.feedback,
    };
  }

  /**
   * Apply a fix for a specific issue
   */
  private async applyFix(
    pr: PRInfo,
    projectPath: string,
    issue: string
  ): Promise<void> {
    // Use AI to generate and apply fix
    const { runWorker } = await import('../agents/worker.js');
    await runWorker({
      task: `Fix the following issue in PR #${pr.number}:\n${issue}`,
      projectPath,
      files: [],
    });
  }

  /**
   * Verify CI status for the PR
   */
  private async verifyCI(pr: PRInfo, projectPath: string): Promise<boolean> {
    try {
      const output = execSync(
        `gh pr checks ${pr.number} --repo ${pr.repo} --json state --jq '.[].state'`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 60000 }
      );
      const states = output.trim().split('\n').filter(Boolean);
      return states.every((s) => s === 'SUCCESS' || s === 'NEUTRAL');
    } catch {
      return false;
    }
  }

  /**
   * Main processing loop for cron-based multi-PR processing
   */
  async run(): Promise<void> {
    const projectPath = this.config.projectPath;
    const state = await this.loadState();

    // Get open PRs
    const prs = await this.getOpenPRs(projectPath);

    for (const pr of prs) {
      const key = `${pr.repo}#${pr.number}`;

      // Skip if already processed recently
      if (state.prs[key]?.status === 'completed') {
        continue;
      }

      // Acquire cross-process lease before mutation
      await withStoreLock(`prProcessor-run-${key}`, async () => {
        state.prs[key] = {
          ...state.prs[key],
          repo: pr.repo,
          prNumber: pr.number,
          status: 'processing',
          iterations: 0,
        };
        await this.processPR(pr, projectPath, state, key);
        await this.saveState(state);
      });
    }
  }

  /**
   * Get open PRs for the repository
   */
  private async getOpenPRs(projectPath: string): Promise<PRInfo[]> {
    try {
      const output = execSync(
        `gh pr list --repo ${this.config.remoteUrl || 'origin'} --state open --json number,title,headRefName,baseRefName,author,createdAt,updatedAt,labels,body`,
        { cwd: projectPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
      );
      const prs = JSON.parse(output);
      return prs.map((pr: any) => ({
        repo: this.config.remoteUrl || 'origin',
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        base: pr.baseRefName,
        author: pr.author?.login || 'unknown',
        body: pr.body || '',
        labels: pr.labels?.map((l: any) => l.name) || [],
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      }));
    } catch {
      return [];
    }
  }

  /**
   * One-shot fix for a single PR (CLI `openswarm pr fix`).
   * Skips cron cooldown and multi-repo scanning — runs processPR directly.
   * (INT-3282)
   */
  async fixOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    const state: PRState = {
      prs: {
        [key]: {
          repo: pr.repo,
          prNumber: pr.number,
          status: 'processing',
          iterations: 0,
        },
      },
      integrations: {},
      integrationBaselines: {},
      updatedAt: new Date().toISOString(),
    };
    // Acquire cross-process lease before any state mutation (one-shot fix path)
    await withStoreLock('prProcessor-fixOne', async () => {
      await this.processPR(pr, projectPath, state, key);
    });
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }

  /**
   * One-shot review-feedback pass for a single PR (CLI `openswarm pr review`).
   * Runs only `processReviewFeedback` — unlike `fixOne`, it does not touch
   * conflicts or wait on CI, so it is safe to call as a lightweight "did a
   * reviewer (Claude, Codex, or a human CHANGES_REQUESTED) leave feedback I
   * haven't addressed yet?" check on demand. (INT-3282)
   *
   * Loads/saves the same durable state file the cron path uses (unlike
   * `fixOne`, which is throwaway-state only). The formal-review freshness
   * gate has no GitHub-visible "already addressed" marker to fall back on the
   * way comments do (no equivalent of the `FEEDBACK_ADDRESSED_MARKERS` scan),
   * so without a persisted watermark, every separate `pr review` invocation
   * would re-detect the same still-open CHANGES_REQUESTED review and
   * re-trigger a fix for it indefinitely.
   */
  async reviewOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    // Acquire cross-process lease before any state mutation (one-shot review path)
    return await withStoreLock('prProcessor-reviewOne', async () => {
      const state = await this.loadState();
      state.prs[key] = {
        ...state.prs[key],
        repo: pr.repo,
        prNumber: pr.number,
        status: 'processing',
        iterations: 0,
      };
      await this.processReviewFeedback(pr, projectPath, state, key, 0);
      await this.saveState(state);
      const entry = state.prs[key];
      return {
        success: entry?.status === 'completed',
        error: entry?.lastError,
        iterations: entry?.iterations ?? 0,
      };
    });
  }

  /**
   * Process integration PRs (sibling PRs in dependent repos)
   */
  async processIntegrations(pr: PRInfo, projectPath: string): Promise<IntegrationSiblingResult[]> {
    const results: IntegrationSiblingResult[] = [];
    const state = await this.loadState();

    // Get integration siblings
    const siblings = await this.findIntegrationSiblings(pr, projectPath);

    for (const sibling of siblings) {
      try {
        // Acquire cross-process lease for integration processing
        await withStoreLock(`prProcessor-integration-${sibling.repo}#${sibling.prNumber}`, async () => {
          await this.processIntegrationPR(sibling, projectPath);
        });
        results.push({
          prNumber: sibling.prNumber,
          repo: sibling.repo,
          status: 'completed',
        });
      } catch (error) {
        results.push({
          prNumber: sibling.prNumber,
          repo: sibling.repo,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    state.integrations = Object.fromEntries(
      results.map((r) => [`${r.repo}#${r.prNumber}`, r])
    );
    await this.saveState(state);

    return results;
  }

  /**
   * Find integration siblings for a PR
   */
  private async findIntegrationSiblings(
    pr: PRInfo,
    projectPath: string
  ): Promise<PRInfo[]> {
    // Check PR body for integration references
    const body = pr.body || '';
    const siblingRefs = body.match(/([\w-]+\/[\w-]+)#(\d+)/g) || [];

    return siblingRefs.map((ref) => {
      const [repo, number] = ref.split('#');
      return {
        repo,
        number: parseInt(number, 10),
        title: '',
        branch: '',
        base: '',
        author: '',
        body: '',
        labels: [],
        createdAt: '',
        updatedAt: '',
      };
    });
  }

  /**
   * Process an integration PR
   */
  private async processIntegrationPR(
    pr: PRInfo,
    projectPath: string
  ): Promise<void> {
    // Clone sibling repo if needed
    const siblingPath = join(tmpdir(), 'openswarm-integrations', pr.repo.replace('/', '-'));
    if (!existsSync(siblingPath)) {
      mkdirSync(siblingPath, { recursive: true });
      await gitExec(projectPath, 'clone', `https://github.com/${pr.repo}.git`, siblingPath);
    }

    // Process the sibling PR
    await this.processPR(pr, siblingPath, await this.loadState(), `${pr.repo}#${pr.number}`);
  }

  /**
   * Clean up current PR state
   */
  async cleanup(): Promise<void> {
    if (this.currentPR) {
      const projectPath = this.config.projectPath;
      try {
        await gitExec(projectPath, 'checkout', this.currentPR.base);
      } catch {
        // Ignore checkout errors in cleanup
      }
      await restoreAutoStash(projectPath, null);
      this.currentPR = null;
    }
  }
}

// ============================================
// Exports
// ============================================

export {
  PRProcessor,
  PRInfo,
  PRState,
  PRProcessorConfig,
  PRIssueComment,
  AutoStash,
  IntegrationSiblingResult,
  isReviewBotComment,
  getActiveCriticalComments,
  matchesCriticalKeyword,
  gitExec,
  ghRepoView,
  parseStashList,
  stashLocalChanges,
  restoreAutoStash,
};