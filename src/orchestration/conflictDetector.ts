// ============================================
// OpenSwarm - Worktree File Conflict Detector
// Knowledge Graph 기반 태스크 간 파일 충돌 감지
// Created: 2026-03-14
// Purpose: 병렬 워크트리 실행 시 동일 파일 수정 충돌 방지

import type { TaskItem } from './decisionEngine.js';
import { analyzeIssue } from '../knowledge/index.js';
import {
  conflictScopeEntriesOverlap,
  conflictScopesOverlap,
  normalizeConflictScope,
} from './conflictScope.js';
import { selectGreedyMaximalIndependentSet } from './conflictAdmission.js';

// Types

export interface ConflictGroup {
  tasks: TaskItem[];
  sharedModules: string[];
}

export interface ConflictDetectionResult {
  safe: TaskItem[];
  conflictGroups: ConflictGroup[];
}

// Union-Find (Disjoint Set)

class UnionFind {
  private parent: Map<number, number> = new Map();
  private rank: Map<number, number> = new Map();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.parent.set(i, i);
      this.rank.set(i, 0);
    }
  }

  find(x: number): number {
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;

    const rankX = this.rank.get(rx)!;
    const rankY = this.rank.get(ry)!;
    if (rankX < rankY) {
      this.parent.set(rx, ry);
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
    }
  }
}

// Conflict Detection

/**
 * Normalize a file/module identifier so two declarations of the same path
 * compare equal: lowercase, trim, strip a leading `./`. Empty/blank entries
 * are dropped.
 */
function normalizeScope(entries: string[] | undefined): Set<string> {
  return normalizeConflictScope(entries);
}

const UNKNOWN_SCOPE = 'unknown-file-scope';

function pairKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

/**
 * Resolve the best available preflight write scope for one task. The normalized
 * result is written back to the task so the scheduler and durable admission
 * layer can make the same decision without repeating Knowledge Graph work.
 */
export async function resolveTaskFileScope(task: TaskItem, projectPath: string): Promise<string[]> {
  const declared = normalizeScope(task.fileScope);
  if (declared.size > 0) {
    const scope = [...declared];
    task.fileScope = scope;
    task.fileScopeSource ??= 'declared';
    return scope;
  }
  if (task.fileScope && task.fileScope.some((entry) => typeof entry === 'string' && entry.trim())) {
    // An explicit but unsafe/generated-only scope is unknown, not permission to
    // replace the planner's claim with a potentially narrower inference.
    task.fileScope = undefined;
    task.fileScopeSource = undefined;
    return [];
  }

  try {
    const impact = await analyzeIssue(projectPath, task.title, task.description);
    if (impact) {
      const inferred = normalizeScope([...impact.directModules, ...impact.dependentModules]);
      if (inferred.size > 0) {
        const scope = [...inferred];
        task.fileScope = scope;
        task.fileScopeSource = 'inferred';
        return scope;
      }
    }
  } catch (err) {
    console.warn(`[ConflictDetector] Impact analysis failed for ${task.id}:`, err);
  }

  task.fileScope = undefined;
  task.fileScopeSource = undefined;
  return [];
}

/** Unknown scope conflicts fail closed while another same-repo worker is live. */
export function fileScopesConflict(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a.size === 0 || b.size === 0) return true;
  return conflictScopesOverlap(a, b);
}

/**
 * Detect file-scope overlap between tasks. Each task's scope prefers the
 * planner-declared `fileScope` (authoritative), falling back to Knowledge Graph
 * inference (`analyzeIssue`) only when no explicit scope is available.
 * Overlapping tasks are grouped into a ConflictGroup for diagnostics. Within
 * each group, a priority-stable greedy maximal independent set is returned as
 * safe, so transitively connected but directly disjoint tasks can still run.
 */
export async function detectFileConflicts(
  tasks: TaskItem[],
  projectPath: string,
): Promise<ConflictDetectionResult> {
  // Step 1: 각 태스크의 영향 모듈 집합 수집
  const taskImpacts: Map<number, Set<string>> = new Map();
  const unknownScopeIndices = new Set<number>();

  await Promise.all(
    tasks.map(async (task, idx) => {
      const scope = await resolveTaskFileScope(task, projectPath);
      if (scope.length > 0) taskImpacts.set(idx, new Set(scope));
      else unknownScopeIndices.add(idx);
    })
  );

  // Step 2: 태스크 쌍 비교로 교집합 계산 → Union-Find로 충돌 그룹 병합
  const uf = new UnionFind(tasks.length);
  // 쌍별 공유 모듈 기록
  const pairShared: Map<string, Set<string>> = new Map();

  for (let i = 0; i < tasks.length; i++) {
    const modulesI = taskImpacts.get(i);

    for (let j = i + 1; j < tasks.length; j++) {
      const modulesJ = taskImpacts.get(j);
      if (unknownScopeIndices.has(i) || unknownScopeIndices.has(j)) {
        // Worktrees isolate filesystem writes, but they do not make two unknown
        // write sets safe to merge. Serialize uncertainty and retry after the
        // known owner exits.
        pairShared.set(`${i}:${j}`, new Set([UNKNOWN_SCOPE]));
        uf.union(i, j);
        continue;
      }

      if (!modulesI || modulesI.size === 0) continue;
      if (!modulesJ || modulesJ.size === 0) continue;

      // Segment-boundary ancestor/descendant scopes conflict too: declaring a
      // directory owns every file below it.
      const shared: string[] = [];
      for (const mod of modulesI) {
        for (const other of modulesJ) {
          if (conflictScopeEntriesOverlap(mod, other)) {
            shared.push(mod === other ? mod : (mod.length <= other.length ? mod : other));
          }
        }
      }

      if (shared.length > 0) {
        const key = `${i}:${j}`;
        if (!pairShared.has(key)) {
          pairShared.set(key, new Set());
        }
        for (const mod of shared) {
          pairShared.get(key)!.add(mod);
        }
        uf.union(i, j);
      }
    }
  }

  // Step 3: 그룹 구성
  const groups: Map<number, number[]> = new Map();
  for (let i = 0; i < tasks.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  // Step 4: safe / conflictGroups 분류
  const safe: TaskItem[] = [];
  const conflictGroups: ConflictGroup[] = [];

  for (const [, indices] of groups) {
    if (indices.length === 1) {
      // 단일 태스크 → safe
      for (const idx of indices) {
        safe.push(tasks[idx]);
      }
      continue;
    }

    // Priority first (1=Urgent > 4=Low), then original input position. The
    // explicit position tie-break keeps admission deterministic even if the
    // runtime's Array#sort stability changes.
    const orderedIndices = [...indices].sort((left, right) =>
      tasks[left].priority - tasks[right].priority || left - right);
    const groupTasks = orderedIndices.map(index => tasks[index]);
    const sharedModuleSet = new Set<string>();
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const shared = pairShared.get(`${indices[a]}:${indices[b]}`);
        if (!shared) continue;
        for (const mod of shared) {
          sharedModuleSet.add(mod);
        }
      }
    }
    const sharedModules = Array.from(sharedModuleSet);

    // The first greedy wave is maximal: every deferred task has a direct edge
    // to at least one admitted task. Unknown scopes have an edge to every peer,
    // so uncertainty remains fail-closed and at most one unknown can be safe.
    const admittedIndices = selectGreedyMaximalIndependentSet(
      orderedIndices,
      (left, right) => pairShared.has(pairKey(left, right)),
    );
    safe.push(...admittedIndices.map(index => tasks[index]));

    // 나머지는 충돌 그룹으로 기록
    conflictGroups.push({
      tasks: groupTasks,
      sharedModules,
    });
  }

  return { safe, conflictGroups };
}
