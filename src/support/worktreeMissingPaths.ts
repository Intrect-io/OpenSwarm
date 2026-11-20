// Gitignored source paths a daemon worktree cannot see, per worktree (AGT-4041, #855 review).
//
// `linkSharedPaths` computes the gaps once when it shares paths into a worktree.
// The worker and reviewer prompt builders run later, in another module, keyed by
// the same worktree path, so the list is kept here instead of on `WorktreeInfo`
// (worktreeManager.ts is at its size cap). Without it a worker that finds a data
// directory absent concludes the data was never delivered.

import { resolve } from 'node:path';
import type { GitignoredPathGaps } from './sharedPathDetection.js';

export interface WorktreeGitignoredGaps extends GitignoredPathGaps {
  /** Paths shared into the worktree (symlink or clone), for the prompt's context. */
  shared: string[];
}

const gapsByWorktree = new Map<string, WorktreeGitignoredGaps>();

export function recordWorktreeGitignoredGaps(worktreePath: string, gaps: GitignoredPathGaps, shared: string[] = []): void {
  gapsByWorktree.set(resolve(worktreePath), { missing: [...gaps.missing], unreadable: [...gaps.unreadable], shared: [...shared] });
}

/** The gaps recorded for this worktree, or undefined when there are none (or it is not a worktree). */
export function worktreeGitignoredGaps(worktreePath: string): WorktreeGitignoredGaps | undefined {
  const gaps = gapsByWorktree.get(resolve(worktreePath));
  return gaps && (gaps.missing.length || gaps.unreadable.length) ? gaps : undefined;
}

export function clearWorktreeGitignoredGaps(worktreePath?: string): void {
  if (worktreePath === undefined) gapsByWorktree.clear();
  else gapsByWorktree.delete(resolve(worktreePath));
}

/**
 * The reviewer-facing section. The worker sees the same lists in its repository contract; the
 * reviewer needs them most in blocker mode, where it judges a claim that some input does not exist.
 */
export function formatWorktreeGapSection(gaps: GitignoredPathGaps | undefined, locale: 'en' | 'ko', dataBlock: (text: string) => string): string {
  if (!gaps || (!gaps.missing.length && !gaps.unreadable.length)) return '';
  const ko = locale === 'ko';
  const lines = [ko ? '## 이 워크트리에서 볼 수 없는 원본 gitignored 경로' : '## Gitignored source paths this worktree cannot see'];
  if (gaps.missing.length) lines.push(ko ? '- 워크트리에 없음 (부재를 증거로 판단하지 말 것):' : '- Not present in this worktree (do not treat their absence as evidence):', dataBlock(gaps.missing.join(', ')));
  if (gaps.unreadable.length) lines.push(ko ? '- 공유되었지만 샌드박스 사용자가 읽을 수 없음 (빈 내용을 증거로 판단하지 말 것):' : '- Shared but unreadable by the sandbox user (do not treat missing contents as evidence):', dataBlock(gaps.unreadable.join(', ')));
  lines.push(ko
    ? '워커가 이 경로의 데이터가 "없다"고 주장하면, 그 근거는 이 워크트리에서 보이지 않는다는 것뿐이다.'
    : 'A claim that data under these paths does not exist rests only on it being invisible from this worktree.');
  return lines.join('\n');
}
