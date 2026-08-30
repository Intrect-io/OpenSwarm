import type { DraftAnalysis, DraftPeerIssue } from '../agents/draftAnalyzer.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { findOpenPRFileOverlaps } from '../support/worktreeManager.js';
import type { ITaskSource } from './taskSource.js';

export function projectDraftPeers(task: TaskItem, peers?: TaskItem[]): DraftPeerIssue[] | undefined {
  return peers
    ?.filter(peer =>
      (peer.issueId || peer.id) !== (task.issueId || task.id)
      && (
        (task.linearProject?.id && peer.linearProject?.id === task.linearProject.id)
        || (!task.linearProject?.id && peer.linearProject?.name === task.linearProject?.name)
      )
    )
    .map(peer => ({
      issueId: peer.issueId || peer.id,
      identifier: peer.issueIdentifier,
      title: peer.title,
      description: peer.description,
      state: peer.linearState,
      createdAt: peer.createdAt,
    }));
}

export async function applyDraftGates(options: {
  task: TaskItem;
  projectPath: string;
  draft: DraftAnalysis;
  peers?: TaskItem[];
  source: ITaskSource | null;
  worktreeMode?: boolean;
  /** Issues a worker currently holds; only their PRs reserve files. (AGT-4097) */
  activeWorkerIssues?: readonly string[];
}): Promise<PipelineResult | null> {
  const { task, draft, peers, source } = options;
  const duplicateTarget = peers?.find(peer => (peer.issueId || peer.id) === draft.duplicateOfIssueId);
  const evidence = draft.duplicateEvidence ?? [];
  if (task.issueId && duplicateTarget && duplicateTarget.createdAt < task.createdAt
    && (draft.duplicateConfidence ?? 0) >= 0.9 && evidence.length >= 2 && source?.markDuplicate) {
    const canonicalId = duplicateTarget.issueId || duplicateTarget.id;
    if (await source.markDuplicate(task.issueId, canonicalId)) {
      await source.addComment(task.issueId,
        `Draft grooming marked this issue as a duplicate of ${duplicateTarget.issueIdentifier ?? canonicalId}.\n\nReason: ${draft.duplicateReason ?? 'Same observable implementation.'}\n\nEvidence:\n${evidence.map(item => `- ${item}`).join('\n')}`,
      );
      console.log(`[AutonomousRunner] Draft grooming: ${task.issueIdentifier ?? task.issueId} duplicates ${duplicateTarget.issueIdentifier ?? canonicalId}`);
      return supersededResult('duplicate', draft.durationMs);
    }
  }

  if (options.worktreeMode && draft.relevantFiles.length > 0) {
    // An open PR reserves its files only while a worker is editing them.
    // `publishOnPark` publishes a run that stops for an operator, so its PR
    // outlives the worker by hours or days: the task first collided with its
    // own PR (AGT-4095) and then with every sibling's — seven such PRs held
    // cgf-portal's hot files for 7-12h, and each blocked attempt doubled the
    // backoff again. (AGT-4097)
    const overlaps = await findOpenPRFileOverlaps(
      options.projectPath,
      draft.relevantFiles,
      {
        selfIssueIdentifier: task.issueIdentifier ?? task.issueId,
        // Passed through as-is: undefined means the caller could not ask the
        // ledger, and every swarm PR keeps reserving. See findOpenPRFileOverlaps.
        activeIssueIdentifiers: options.activeWorkerIssues,
      },
    );
    if (overlaps.length > 0) {
      const lines = overlaps.map(overlap => `- ${overlap.url}: ${overlap.files.map(file => `\`${file}\``).join(', ')}`);
      console.warn(`[AutonomousRunner] Existing open PR owns planned files — skipping duplicate worker: ${lines.join(' ')}`);
      return supersededResult('superseded', draft.durationMs);
    }
  }
  return null;
}

function supersededResult(kind: string, durationMs: number): PipelineResult {
  return { success: true, sessionId: `${kind}-${Date.now()}`, iterations: 0, totalDuration: durationMs, finalStatus: 'superseded', stages: [] };
}
