// ============================================
// Claude Swarm - Git Tracker
// Aider 스타일 Git diff 기반 파일 변경 추적
// ============================================

import { spawn } from 'node:child_process';

/**
 * Git diff로 변경된 파일 목록 추출
 * Worker JSON 파싱에 의존하지 않고 실제 변경 파일 추적
 */
export async function getChangedFiles(
  projectPath: string,
  since?: string // commit hash or HEAD~1
): Promise<string[]> {
  try {
    const args = since
      ? ['diff', '--name-only', since]
      : ['diff', '--name-only', 'HEAD'];

    const output = await runGitCommand(projectPath, args);

    // staged 파일도 포함
    const stagedOutput = await runGitCommand(projectPath, ['diff', '--name-only', '--cached']);

    const files = new Set<string>();

    output.split('\n').filter(Boolean).forEach(f => files.add(f));
    stagedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));

    return Array.from(files);
  } catch (error) {
    console.error('[GitTracker] getChangedFiles error:', error);
    return [];
  }
}

/**
 * 작업 전 스냅샷 저장 (stash 또는 commit hash)
 */
export async function takeSnapshot(projectPath: string): Promise<string> {
  try {
    // 현재 HEAD commit hash 반환
    const output = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
    return output.trim();
  } catch (error) {
    console.error('[GitTracker] takeSnapshot error:', error);
    return '';
  }
}

/**
 * 스냅샷 이후 변경된 파일 목록
 */
export async function getChangedFilesSinceSnapshot(
  projectPath: string,
  snapshotHash: string
): Promise<string[]> {
  if (!snapshotHash) return [];

  try {
    // committed 변경
    const committedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only', snapshotHash, 'HEAD'
    ]);

    // uncommitted 변경 (staged + unstaged)
    const uncommittedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only'
    ]);
    const stagedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only', '--cached'
    ]);

    const files = new Set<string>();

    committedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    uncommittedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    stagedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));

    return Array.from(files);
  } catch (error) {
    console.error('[GitTracker] getChangedFilesSinceSnapshot error:', error);
    return [];
  }
}

/**
 * Auto-commit with attribution
 */
export async function autoCommit(
  projectPath: string,
  message: string,
  model: string = 'claude'
): Promise<{ success: boolean; hash?: string; error?: string }> {
  try {
    // 1. Stage all changes
    await runGitCommand(projectPath, ['add', '-A']);

    // 2. Check if there are changes to commit
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    if (!status.trim()) {
      return { success: true, hash: undefined }; // Nothing to commit
    }

    // 3. Commit with Co-Authored-By
    const fullMessage = `${message}\n\nCo-Authored-By: ${model} <noreply@anthropic.com>`;
    await runGitCommand(projectPath, ['commit', '-m', fullMessage]);

    // 4. Get commit hash
    const hash = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

    return { success: true, hash: hash.trim() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Git 명령 실행 유틸리티
 */
function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * 프로젝트가 git 저장소인지 확인
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await runGitCommand(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dirty 상태 확인 (uncommitted changes)
 */
export async function isDirty(projectPath: string): Promise<boolean> {
  try {
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}
