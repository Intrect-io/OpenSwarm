/**
 * Codex - Session recording and summary system
 *
 * Structure:
 * codex/
 * ├── index.md                    # Full listing
 * ├── 2026-02/                    # Monthly folders
 * │   ├── 05-pykis-ci-fix.md     # Summary
 * │   └── 05-us-stock-engine.md
 * └── .sessions/                  # Detailed records (hidden)
 *     └── 05-2050-pykis-ci-fix.md
 */

import { promises as fs } from 'fs';
import { resolve, basename, join } from 'path';
import { getDateLocale } from './locale/index.js';
import { homedir } from 'os';

// Codex storage path
const CODEX_DIR = resolve(homedir(), '.claude-swarm/codex');

/**
 * Session metadata
 */
export interface CodexSession {
  id: string;
  title: string;
  repo?: string;
  startedAt: number;
  endedAt?: number;
  tags: string[];
  problem?: string;
  solution?: string;
  filesChanged: string[];
  result: 'success' | 'partial' | 'failed' | 'ongoing';
  commands: SessionCommand[];
}

/**
 * Command executed during a session
 */
export interface SessionCommand {
  tool: string;
  description?: string;
  timestamp: number;
  result?: 'success' | 'error';
}

/**
 * Initialize Codex - create directory structure
 */
export async function initCodex(): Promise<void> {
  await fs.mkdir(CODEX_DIR, { recursive: true });
  await fs.mkdir(join(CODEX_DIR, '.sessions'), { recursive: true });

  // Create index.md if it doesn't exist
  const indexPath = join(CODEX_DIR, 'index.md');
  try {
    await fs.access(indexPath);
  } catch {
    const initialIndex = `# Codex - 세션 기록

> 자동 생성된 작업 기록 아카이브

## 최근 세션

_아직 기록된 세션이 없습니다._

## 태그별 분류

## 저장소별 분류

---
_마지막 업데이트: ${new Date().toISOString()}_
`;
    await fs.writeFile(indexPath, initialIndex, 'utf-8');
    console.log('[Codex] Initialized index.md');
  }
}

/**
 * Generate date-based paths
 */
function getDatePaths(date: Date): { monthDir: string; prefix: string } {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const time = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;

  return {
    monthDir: `${year}-${month}`,
    prefix: `${day}-${time}`,
  };
}

/**
 * Generate a slug (for filenames)
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s가-힣-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-$/, '');
}

/**
 * Format elapsed duration
 */
function formatDuration(startMs: number, endMs: number): string {
  const diffMs = endMs - startMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}시간 ${remainingMins}분`;
}

/**
 * Result emoji
 */
function resultEmoji(result: CodexSession['result']): string {
  switch (result) {
    case 'success':
      return '✅';
    case 'partial':
      return '⚠️';
    case 'failed':
      return '❌';
    case 'ongoing':
      return '🔄';
  }
}

/**
 * Generate summary document
 */
function generateSummary(session: CodexSession, detailPath: string): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const duration = session.endedAt
    ? formatDuration(session.startedAt, session.endedAt)
    : '진행 중';

  const relativeDetailPath = join('..', '.sessions', basename(detailPath));

  let md = `# ${session.title}
> ${dateStr} | 소요: ~${duration} | [상세 기록](${relativeDetailPath})

`;

  if (session.repo) {
    md += `**저장소**: \`${session.repo}\`\n\n`;
  }

  if (session.tags.length > 0) {
    md += `**태그**: ${session.tags.map(t => `\`${t}\``).join(' ')}\n\n`;
  }

  if (session.problem) {
    md += `## 문제\n${session.problem}\n\n`;
  }

  if (session.solution) {
    md += `## 해결\n${session.solution}\n\n`;
  }

  if (session.filesChanged.length > 0) {
    md += `## 변경 파일\n`;
    md += session.filesChanged.map(f => `\`${f}\``).join(' ') + '\n\n';
  }

  md += `## 결과\n${resultEmoji(session.result)} ${session.result === 'success' ? '성공' : session.result === 'partial' ? '부분 완료' : session.result === 'failed' ? '실패' : '진행 중'}\n`;

  return md;
}

/**
 * Generate detailed record
 */
function generateDetail(session: CodexSession, rawLog?: string): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  let md = `# ${session.title} - 상세 기록
> 시작: ${dateStr}
> 종료: ${session.endedAt ? new Date(session.endedAt).toLocaleString(getDateLocale()) : '진행 중'}

## 세션 정보
- **ID**: ${session.id}
- **저장소**: ${session.repo || 'N/A'}
- **태그**: ${session.tags.join(', ') || 'N/A'}
- **결과**: ${resultEmoji(session.result)} ${session.result}

`;

  if (session.problem) {
    md += `## 문제 상세\n${session.problem}\n\n`;
  }

  if (session.solution) {
    md += `## 해결 상세\n${session.solution}\n\n`;
  }

  if (session.filesChanged.length > 0) {
    md += `## 변경된 파일\n`;
    for (const f of session.filesChanged) {
      md += `- \`${f}\`\n`;
    }
    md += '\n';
  }

  if (session.commands.length > 0) {
    md += `## 실행된 명령\n`;
    md += '| 시간 | 도구 | 설명 | 결과 |\n';
    md += '|------|------|------|------|\n';
    for (const cmd of session.commands) {
      const time = new Date(cmd.timestamp).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      md += `| ${time} | ${cmd.tool} | ${cmd.description || '-'} | ${cmd.result === 'success' ? '✅' : cmd.result === 'error' ? '❌' : '-'} |\n`;
    }
    md += '\n';
  }

  if (rawLog) {
    md += `## 원본 로그\n\`\`\`\n${rawLog}\n\`\`\`\n`;
  }

  return md;
}

/**
 * Save a session
 */
export async function saveSession(
  session: CodexSession,
  rawLog?: string
): Promise<{ summaryPath: string; detailPath: string }> {
  await initCodex();

  const date = new Date(session.startedAt);
  const { monthDir, prefix } = getDatePaths(date);
  const slug = slugify(session.title);

  // Create monthly directory
  const monthPath = join(CODEX_DIR, monthDir);
  await fs.mkdir(monthPath, { recursive: true });

  // File paths
  const summaryFilename = `${prefix.split('-')[0]}-${slug}.md`;
  const detailFilename = `${prefix}-${slug}.md`;

  const summaryPath = join(monthPath, summaryFilename);
  const detailPath = join(CODEX_DIR, '.sessions', detailFilename);

  // Save detailed record first
  const detailContent = generateDetail(session, rawLog);
  await fs.writeFile(detailPath, detailContent, 'utf-8');
  console.log(`[Codex] Saved detail: ${detailPath}`);

  // Save summary
  const summaryContent = generateSummary(session, detailPath);
  await fs.writeFile(summaryPath, summaryContent, 'utf-8');
  console.log(`[Codex] Saved summary: ${summaryPath}`);

  // Update index.md
  await updateIndex(session, summaryPath);

  return { summaryPath, detailPath };
}

/**
 * Update index.md
 */
async function updateIndex(session: CodexSession, summaryPath: string): Promise<void> {
  const indexPath = join(CODEX_DIR, 'index.md');
  let content = await fs.readFile(indexPath, 'utf-8');

  const relativePath = summaryPath.replace(CODEX_DIR + '/', '');
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const newEntry = `- ${resultEmoji(session.result)} [${session.title}](${relativePath}) - ${dateStr}${session.repo ? ` \`${session.repo}\`` : ''}`;

  // Update the "recent sessions" section
  const recentHeader = '## 최근 세션';
  const recentIdx = content.indexOf(recentHeader);
  if (recentIdx !== -1) {
    const nextSectionIdx = content.indexOf('\n## ', recentIdx + recentHeader.length);
    const sectionEnd = nextSectionIdx !== -1 ? nextSectionIdx : content.indexOf('\n---', recentIdx);

    const beforeSection = content.slice(0, recentIdx + recentHeader.length);
    const afterSection = sectionEnd !== -1 ? content.slice(sectionEnd) : '';

    // Get existing entries (keep max 20)
    const existingSection = content.slice(recentIdx + recentHeader.length, sectionEnd !== -1 ? sectionEnd : undefined);
    const existingEntries = existingSection
      .split('\n')
      .filter(line => line.trim().startsWith('-'))
      .slice(0, 19);

    const newSection = `\n\n${newEntry}\n${existingEntries.join('\n')}\n`;

    content = beforeSection + newSection + afterSection;
  }

  // Update last-updated timestamp
  content = content.replace(
    /_마지막 업데이트:.*_/,
    `_마지막 업데이트: ${new Date().toISOString()}_`
  );

  await fs.writeFile(indexPath, content, 'utf-8');
  console.log('[Codex] Updated index.md');
}

/**
 * Session builder - incrementally construct a session
 */
export class SessionBuilder {
  private session: CodexSession;
  private rawLog: string[] = [];

  constructor(title: string) {
    this.session = {
      id: `session-${Date.now()}`,
      title,
      startedAt: Date.now(),
      tags: [],
      filesChanged: [],
      result: 'ongoing',
      commands: [],
    };
  }

  setRepo(repo: string): this {
    this.session.repo = repo;
    return this;
  }

  addTag(...tags: string[]): this {
    this.session.tags.push(...tags);
    return this;
  }

  setProblem(problem: string): this {
    this.session.problem = problem;
    return this;
  }

  setSolution(solution: string): this {
    this.session.solution = solution;
    return this;
  }

  addFile(...files: string[]): this {
    this.session.filesChanged.push(...files);
    return this;
  }

  addCommand(tool: string, description?: string, result?: 'success' | 'error'): this {
    this.session.commands.push({
      tool,
      description,
      timestamp: Date.now(),
      result,
    });
    return this;
  }

  appendLog(log: string): this {
    this.rawLog.push(log);
    return this;
  }

  setResult(result: CodexSession['result']): this {
    this.session.result = result;
    return this;
  }

  async save(): Promise<{ summaryPath: string; detailPath: string }> {
    this.session.endedAt = Date.now();
    return saveSession(this.session, this.rawLog.join('\n'));
  }

  getSession(): CodexSession {
    return { ...this.session };
  }
}

/**
 * Quick session save (for simple cases)
 */
export async function quickSave(options: {
  title: string;
  repo?: string;
  tags?: string[];
  problem?: string;
  solution?: string;
  files?: string[];
  result: CodexSession['result'];
}): Promise<{ summaryPath: string; detailPath: string }> {
  const builder = new SessionBuilder(options.title);

  if (options.repo) builder.setRepo(options.repo);
  if (options.tags) builder.addTag(...options.tags);
  if (options.problem) builder.setProblem(options.problem);
  if (options.solution) builder.setSolution(options.solution);
  if (options.files) builder.addFile(...options.files);
  builder.setResult(options.result);

  return builder.save();
}

/**
 * Get recent session list
 */
export async function getRecentSessions(limit: number = 10): Promise<string[]> {
  await initCodex();

  const indexPath = join(CODEX_DIR, 'index.md');
  const content = await fs.readFile(indexPath, 'utf-8');

  const lines = content.split('\n');
  const sessions: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('- ') && line.includes('](')) {
      sessions.push(line.trim());
      if (sessions.length >= limit) break;
    }
  }

  return sessions;
}

/**
 * Return the Codex directory path
 */
export function getCodexPath(): string {
  return CODEX_DIR;
}
