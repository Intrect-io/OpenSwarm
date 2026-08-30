// ============================================
// OpenSwarm - Canonical repository coordination cells (AGT-4131)
// ============================================

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { CoordinationEvent } from './coordinationStore.js';

export interface RepositoryCell {
  /** Opaque identity shared by every worktree backed by the same Git common dir. */
  repoKey: string;
  /** Stable display/routing path. For a normal repository this is its main checkout. */
  repositoryPath: string;
  /** Canonical path the caller supplied, retained for execution diagnostics. */
  worktreePath: string;
}

const CELL_CACHE = new Map<string, RepositoryCell>();
const CELL_CACHE_MAX = 200;

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function opaqueKey(kind: 'git' | 'path', value: string): string {
  return `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function gitPath(cwd: string, argument: '--git-common-dir' | '--show-toplevel'): string {
  const value = execFileSync('git', ['-C', cwd, 'rev-parse', argument], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return canonicalPath(isAbsolute(value) ? value : resolve(cwd, value));
}

/**
 * Resolve a checkout into the repository cell shared by all of its worktrees.
 *
 * Git's common directory is the invariant: a linked worktree has its own
 * `git-dir`, but every sibling reports the same `--git-common-dir`. Non-Git
 * directories remain routable through a path-scoped fallback instead of
 * making coordination unavailable.
 */
export function repositoryCell(path: string): RepositoryCell {
  const worktreePath = canonicalPath(path);
  const cached = CELL_CACHE.get(worktreePath);
  if (cached) return cached;

  let cell: RepositoryCell;
  try {
    const commonDir = gitPath(worktreePath, '--git-common-dir');
    const topLevel = gitPath(worktreePath, '--show-toplevel');
    cell = {
      repoKey: opaqueKey('git', commonDir),
      repositoryPath: basename(commonDir) === '.git' ? dirname(commonDir) : topLevel,
      worktreePath,
    };
  } catch {
    cell = {
      repoKey: opaqueKey('path', worktreePath),
      repositoryPath: worktreePath,
      worktreePath,
    };
  }

  if (CELL_CACHE.size >= CELL_CACHE_MAX) {
    const oldest = CELL_CACHE.keys().next().value;
    if (oldest !== undefined) CELL_CACHE.delete(oldest);
  }
  CELL_CACHE.set(worktreePath, cell);
  return cell;
}

/** Explicit keys are opaque and must never be passed through path resolution. */
export function repositoryKey(repoKey: string | undefined, repository: string): string {
  return repoKey?.trim() || repositoryCell(repository).repoKey;
}

export interface CoordinationPeer {
  repoKey: string;
  address: string;
  name?: string;
  role?: string;
  taskId: string;
  taskLabel?: string;
  lastSeen: number;
}

const AGENT_ROLES = new Set(['worker', 'reviewer', 'orchestrator', 'review-agent']);

function peerKey(taskId: string, address: string): string {
  return `${taskId}\0${address}`;
}

/** Build a bounded, recent peer directory from durable board presence. */
export function coordinationPeers(
  events: CoordinationEvent[],
  options: {
    repoKey: string;
    repository?: string;
    now?: number;
    activeWindowMs?: number;
    roles?: string[];
    taskIds?: string[];
    exclude?: { address: string; taskId: string };
    limit?: number;
  },
): CoordinationPeer[] {
  const now = options.now ?? Date.now();
  const activeWindowMs = options.activeWindowMs ?? 30 * 60_000;
  const roles = options.roles?.length ? new Set(options.roles) : undefined;
  const tasks = options.taskIds?.length ? new Set(options.taskIds) : undefined;
  const peers = new Map<string, CoordinationPeer>();
  const legacyRepository = options.repository ? canonicalPath(options.repository) : undefined;

  const touch = (
    event: CoordinationEvent,
    address: string | undefined,
    name: string | undefined,
    role: string | undefined,
    taskId: string | undefined,
    taskLabel: string | undefined,
  ) => {
    if (!address || !taskId || !role || !AGENT_ROLES.has(role)) return;
    if (options.exclude?.address === address && options.exclude.taskId === taskId) return;
    if (roles && !roles.has(role)) return;
    if (tasks && !tasks.has(taskId)) return;
    if (now - event.timestamp > activeWindowMs) return;
    const key = peerKey(taskId, address);
    const previous = peers.get(key);
    if (!previous || event.timestamp >= previous.lastSeen) {
      peers.set(key, {
        repoKey: options.repoKey,
        address,
        name,
        role,
        taskId,
        taskLabel,
        lastSeen: event.timestamp,
      });
    }
  };

  for (const event of events) {
    if (event.repoKey ? event.repoKey !== options.repoKey : legacyRepository !== undefined && canonicalPath(event.repository) !== legacyRepository) continue;
    touch(
      event, event.actor, event.actorName, event.actorRole,
      event.sourceTaskId ?? event.taskId, event.sourceTaskLabel ?? event.taskLabel,
    );
    touch(
      event, event.recipient, event.recipientName, event.recipientRole,
      event.targetTaskId ?? event.taskId, event.targetTaskLabel ?? event.taskLabel,
    );
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen || a.address.localeCompare(b.address))
    .slice(0, limit);
}

export function resetRepositoryCellCacheForTests(): void {
  CELL_CACHE.clear();
}
