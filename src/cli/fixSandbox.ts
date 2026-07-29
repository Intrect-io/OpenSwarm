// ============================================
// OpenSwarm - isolated parallel fix workers
// ============================================

import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  BASELINE_UNTRACKED_FILE_LIMIT_BYTES,
  captureBaselinePatch,
  cloneSandbox,
  createSharedPathSnapshot,
  promoteValidatedFiles,
  sandboxChangedFiles,
  seedBaseline,
} from '../agents/workerFanout.js';
import { runPool } from '../support/concurrencyPool.js';
import { pathWithinScope } from './fixPlanning.js';

export interface IsolatedFixItem {
  label: string;
  allowedPaths: string[];
}

export interface IsolatedFixResult<T extends IsolatedFixItem> {
  item: T;
  success: boolean;
  filesChanged: string[];
  error?: string;
}

interface SandboxRun<T extends IsolatedFixItem> extends IsolatedFixResult<T> {
  sandbox: string;
  linkedSharedPaths: string[];
}

function safeId(label: string, index: number): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return normalized || `fix-${index + 1}`;
}

async function cleanupTemporarySandboxRoot(root: string, knownEntries: Set<string>): Promise<void> {
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith('openswarm-fix-units-')) {
    throw new Error(`refusing to clean unverified fix sandbox root: ${root}`);
  }
  for (const entry of await readdir(resolvedRoot)) {
    if (!knownEntries.has(entry)) {
      throw new Error(`refusing to clean unexpected fix sandbox entry: ${entry}`);
    }
    await rm(join(resolvedRoot, entry), { recursive: true, force: true });
  }
  await rmdir(resolvedRoot);
}

/**
 * Run independent fix units in isolated clones, validate their actual Git diff,
 * then promote only disjoint, in-scope results into the audit worktree.
 */
export async function runIsolatedFixBatch<T extends IsolatedFixItem>(options: {
  projectPath: string;
  items: T[];
  concurrency: number;
  signal?: AbortSignal;
  run: (item: T, sandbox: string, onLog: (line: string) => void) => Promise<{ success: boolean; error?: string }>;
  onLog?: (item: T, line: string) => void;
  /** Batch-level notices (not tied to one unit), e.g. what the baseline left out. */
  onNotice?: (line: string) => void;
}): Promise<Array<IsolatedFixResult<T>>> {
  if (options.items.length === 0) return [];
  options.signal?.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'openswarm-fix-units-'));
  const knownEntries = new Set<string>();
  try {
    // Every sandbox starts from the exact same dirty candidate state. A failed
    // snapshot must abort rather than silently run against stale HEAD. The patch
    // is streamed to disk and shared by all sandboxes — a dirty tree carrying
    // large artifacts used to blow the exec stdout buffer here. (INT-3098)
    const baselineEntry = 'baseline.patch';
    knownEntries.add(baselineEntry);
    const baseline = await captureBaselinePatch(options.projectPath, join(root, baselineEntry));
    if (baseline.skippedUntracked.length > 0) {
      const limitMb = Math.round(BASELINE_UNTRACKED_FILE_LIMIT_BYTES / (1024 * 1024));
      options.onNotice?.(
        `Baseline left out ${baseline.skippedUntracked.length} untracked file(s) over ${limitMb}MB ` +
          `(artifacts, not source): ${baseline.skippedUntracked.slice(0, 3).join(', ')}` +
          `${baseline.skippedUntracked.length > 3 ? ', …' : ''}`,
      );
    }
    // Build one sanitized dependency/data snapshot for the whole batch. Each
    // worker still receives an independent filesystem clone, but large trees
    // are scanned for external symlinks only once instead of once per worker.
    const snapshotEntry = 'shared-path-snapshot';
    knownEntries.add(snapshotEntry);
    const sharedPathSnapshot = await createSharedPathSnapshot(
      options.projectPath,
      join(root, snapshotEntry),
    );
    options.signal?.throwIfAborted();
    const settled = await runPool(
      options.items,
      options.concurrency,
      async (item, index): Promise<SandboxRun<T>> => {
        const id = `${String(index + 1).padStart(3, '0')}-${safeId(item.label, index)}`;
        knownEntries.add(id);
        let sandbox = '';
        let linkedSharedPaths: string[] = [];
        try {
          options.signal?.throwIfAborted();
          // Copy ignored dependencies/data into each worker sandbox. Symlinking is
          // faster, but install/build tools can then mutate the original repo's
          // node_modules, virtualenv, caches, or configured data invisibly.
          ({ sandbox, linkedSharedPaths } = await cloneSandbox(
            options.projectPath,
            root,
            id,
            'copy',
            sharedPathSnapshot,
          ));
          await seedBaseline(sandbox, baseline);
          options.signal?.throwIfAborted();
          const worker = await options.run(item, sandbox, (line) => options.onLog?.(item, line));
          options.signal?.throwIfAborted();
          const files = await sandboxChangedFiles(sandbox, linkedSharedPaths);
          const outside = files.filter((file) => !pathWithinScope(file, item.allowedPaths));
          if (outside.length > 0) {
            return {
              item, sandbox, linkedSharedPaths, success: false, filesChanged: files,
              error: `worker-scope: changed files outside dependency closure: ${outside.join(', ')}`,
            };
          }
          return {
            item, sandbox, linkedSharedPaths,
            success: worker.success && files.length > 0,
            filesChanged: files,
            error: worker.error ?? (files.length === 0 ? 'worker produced no changes' : undefined),
          };
        } catch (error) {
          return {
            item, sandbox, linkedSharedPaths, success: false, filesChanged: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    options.signal?.throwIfAborted();

    const runs = settled.map((entry, index): SandboxRun<T> => entry.value ?? ({
      item: options.items[index], sandbox: '', linkedSharedPaths: [], success: false, filesChanged: [],
      error: entry.error instanceof Error ? entry.error.message : String(entry.error ?? 'sandbox worker failed'),
    }));

    // Independent units must have disjoint output. If the dependency graph
    // missed a shared contract, fail both candidates instead of applying them in
    // a timing-dependent order; the next review round keeps the finding open.
    const owners = new Map<string, number[]>();
    runs.forEach((run, index) => {
      if (!run.success) return;
      for (const file of run.filesChanged) owners.set(file, [...(owners.get(file) ?? []), index]);
    });
    for (const [file, indexes] of owners) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        runs[index].success = false;
        runs[index].error = `fix-unit conflict: multiple isolated workers changed ${file}`;
      }
    }

    for (const run of runs) {
      if (!run.success || !run.sandbox) continue;
      try {
        options.signal?.throwIfAborted();
        const abortIfNeeded = () => options.signal?.throwIfAborted();
        const promoted = await promoteValidatedFiles(
          options.projectPath,
          run.sandbox,
          run.filesChanged,
          run.linkedSharedPaths,
          { beforeRemove: abortIfNeeded, beforeWrite: abortIfNeeded },
        );
        if (promoted.length === 0) {
          run.success = false;
          run.error = 'fix-unit promotion produced no changes';
        } else {
          run.filesChanged = promoted;
        }
      } catch (error) {
        run.success = false;
        run.error = `fix-unit promotion failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return runs.map(({ item, success, filesChanged, error }) => ({ item, success, filesChanged, error }));
  } finally {
    await cleanupTemporarySandboxRoot(root, knownEntries);
  }
}
