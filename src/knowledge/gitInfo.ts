// ============================================
// OpenSwarm - Git Info for Knowledge Graph
// Git log 기반 churn score, 최근 변경, 기여자 추적
// ============================================

import { spawn } from 'node:child_process';
import type { KnowledgeGraph } from './graph.js';
import type { GitInfo } from './types.js';

// ============================================
// Git Command Runner (gitTracker.ts와 동일 패턴)
// ============================================

function runGitCommand(cwd: string, args: string[], timeoutMs: number = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================
// Churn Calculation
// ============================================

interface FileChurn {
  path: string;
  commitCount: number;
  lastCommitDate: number;
}

/**
 * 최근 30일간 파일별 커밋 수 계산
 */
async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  const churns = new Map<string, FileChurn>();

  try {
    // git log --since="30 days ago" --name-only --format="%ct"
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '--format=%ct',
    ]);

    let currentTimestamp = 0;

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 숫자면 커밋 타임스탬프
      if (/^\d+$/.test(trimmed)) {
        currentTimestamp = parseInt(trimmed, 10) * 1000; // ms로 변환
        continue;
      }

      // 파일 경로
      const existing = churns.get(trimmed);
      if (existing) {
        existing.commitCount++;
        if (currentTimestamp > existing.lastCommitDate) {
          existing.lastCommitDate = currentTimestamp;
        }
      } else {
        churns.set(trimmed, {
          path: trimmed,
          commitCount: 1,
          lastCommitDate: currentTimestamp,
        });
      }
    }
  } catch (err) {
    console.warn(`[GitInfo] Failed to get file churns:`, err);
  }

  return churns;
}

/**
 * 그래프의 모든 모듈에 Git 정보 추가
 */
export async function enrichWithGitInfo(
  graph: KnowledgeGraph,
  projectPath: string,
  sinceDays: number = 30,
): Promise<void> {
  const churns = await getFileChurns(projectPath, sinceDays);

  if (churns.size === 0) return;

  // churn score 정규화를 위한 최대값
  const maxCommits = Math.max(...Array.from(churns.values()).map(c => c.commitCount), 1);

  const modules = [
    ...graph.getNodesByType('module'),
    ...graph.getNodesByType('test_file'),
  ];

  for (const mod of modules) {
    const churn = churns.get(mod.path);
    if (churn) {
      const gitInfo: GitInfo = {
        lastCommitDate: churn.lastCommitDate,
        commitCount30d: churn.commitCount,
        churnScore: Math.round((churn.commitCount / maxCommits) * 1000) / 1000,
      };
      mod.gitInfo = gitInfo;
    } else {
      // Git 기록에 없는 파일 (30일 내 변경 없음)
      mod.gitInfo = {
        lastCommitDate: 0,
        commitCount30d: 0,
        churnScore: 0,
      };
    }
  }

  console.log(`[GitInfo] Enriched ${modules.length} modules with git data (${churns.size} files had changes in ${sinceDays}d)`);
}

/**
 * 최근 변경된 파일 목록 (증분 업데이트 트리거용)
 */
export async function getRecentlyChangedFiles(
  projectPath: string,
  sinceTimestamp: number,
): Promise<string[]> {
  try {
    const sinceDate = new Date(sinceTimestamp).toISOString();
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDate}`,
      '--name-only',
      '--format=',
    ]);

    const files = new Set<string>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    return Array.from(files);
  } catch {
    return [];
  }
}
