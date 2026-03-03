// ============================================
// OpenSwarm - PR Ownership Tracker
// Tracks which PRs were created by the bot
// Persists to ~/.openswarm/pr-ownership.json
// ============================================

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// ============================================
// Types
// ============================================

export interface OwnedPR {
  repo: string;
  prNumber: number;
  branch: string;
  createdAt: string;
  issueIdentifier?: string;
}

interface OwnershipState {
  prs: OwnedPR[];
  updatedAt: string;
}

// ============================================
// Constants
// ============================================

const OWNERSHIP_PATH = resolve(homedir(), '.openswarm', 'pr-ownership.json');

// ============================================
// State Management
// ============================================

async function loadState(): Promise<OwnershipState> {
  try {
    const data = await readFile(OWNERSHIP_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { prs: [], updatedAt: new Date().toISOString() };
  }
}

async function saveState(state: OwnershipState): Promise<void> {
  await mkdir(resolve(homedir(), '.openswarm'), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(OWNERSHIP_PATH, JSON.stringify(state, null, 2));
}

// ============================================
// Public API
// ============================================

/** Register a PR as owned by the bot */
export async function registerOwnedPR(pr: OwnedPR): Promise<void> {
  const state = await loadState();
  const exists = state.prs.some(
    (p) => p.repo === pr.repo && p.prNumber === pr.prNumber
  );
  if (!exists) {
    state.prs.push(pr);
    await saveState(state);
    console.log(`[PROwnership] Registered: ${pr.repo}#${pr.prNumber} (${pr.branch})`);
  }
}

/** Check if a PR is owned by the bot */
export async function isOwnedPR(repo: string, prNumber: number): Promise<boolean> {
  const state = await loadState();
  return state.prs.some((p) => p.repo === repo && p.prNumber === prNumber);
}

/** Remove a PR from ownership (after merge/close) */
export async function removeOwnedPR(repo: string, prNumber: number): Promise<void> {
  const state = await loadState();
  const before = state.prs.length;
  state.prs = state.prs.filter(
    (p) => !(p.repo === repo && p.prNumber === prNumber)
  );
  if (state.prs.length < before) {
    await saveState(state);
    console.log(`[PROwnership] Removed: ${repo}#${prNumber}`);
  }
}

/** Get all owned PRs for a repo */
export async function getOwnedPRsForRepo(repo: string): Promise<OwnedPR[]> {
  const state = await loadState();
  return state.prs.filter((p) => p.repo === repo);
}

/** Get all owned PRs */
export async function getAllOwnedPRs(): Promise<OwnedPR[]> {
  const state = await loadState();
  return state.prs;
}
