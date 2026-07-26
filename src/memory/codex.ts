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
import { getDateLocale } from '../locale/index.js';
import { homedir } from 'os';
import { createHash } from 'crypto';

// Codex storage path
const CODEX_DIR = resolve(homedir(), '.openswarm/codex');

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
    const initialIndex = `# Codex - Session Records

> Auto-generated work record archive

## Recent Sessions

_No sessions recorded yet._

## By Tags

## By Repository

---
_Last updated: ${new Date().toISOString()}_
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
 * The part of a session filename that makes it unique.
 *
 * Derived from a hash rather than the first N characters of the id. Ids look
 * like `session-<ms>`, and taking the leading 12 characters left only the first
 * four digits of the timestamp — a value that stays the same for ~11.6 days
 * (10^9 ms). Uniqueness therefore collapsed to the `DD-HHMM` prefix plus the
 * title slug, so two sessions with the same title in the same minute silently
 * overwrote each other. A hash discriminates whatever shape the id takes,
 * including a leading- or trailing-common one.
 */
export function sessionFilenameSuffix(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/**
 * Format elapsed duration
 */
function formatDuration(startMs: number, endMs: number): string {
  const diffMs = endMs - startMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}min`;
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
  const dateStr = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const duration = session.endedAt
    ? formatDuration(session.startedAt, session.endedAt)
    : 'ongoing';

  const relativeDetailPath = join('..', '.sessions', basename(detailPath));

  let md = `# ${session.title}
> ${dateStr} | Duration: ~${duration} | [Detail Record](${relativeDetailPath})

`;

  if (session.repo) {
    md += `**Repository**: \`${session.repo}\`\n\n`;
  }

  if (session.tags.length > 0) {
    md += `**Tags**: ${session.tags.map(t => `\`${t}\``).join(' ')}\n\n`;
  }

  if (session.problem) {
    md += `## Problem\n${session.problem}\n\n`;
  }

  if (session.solution) {
    md += `## Solution\n${session.solution}\n\n`;
  }

  if (session.filesChanged.length > 0) {
    md += `## Changed Files\n`;
    md += session.filesChanged.map(f => `\`${f}\``).join(' ') + '\n\n';
  }

  md += `## Result\n${resultEmoji(session.result)} ${session.result === 'success' ? 'Success' : session.result === 'partial' ? 'Partial' : session.result === 'failed' ? 'Failed' : 'Ongoing'}\n`;

  return md;
}

/**
 * Generate detailed record
 */
function generateDetail(session: CodexSession, rawLog?: string): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  let md = `# ${session.title} - Detail Record
> Start: ${dateStr}
> End: ${session.endedAt ? new Date(session.endedAt).toLocaleString(getDateLocale()) : 'ongoing'}

## Session Info
- **ID**: ${session.id}
- **Repository**: ${session.repo || 'N/A'}
- **Tags**: ${session.tags.join(', ') || 'N/A'}
- **Result**: ${resultEmoji(session.result)} ${session.result}

`;

  if (session.problem) {
    md += `## Problem Details\n${session.problem}\n\n`;
  }

  if (session.solution) {
    md += `## Solution Details\n${session.solution}\n\n`;
  }

  if (session.filesChanged.length > 0) {
    md += `## Changed Files\n`;
    for (const f of session.filesChanged) {
      md += `- \`${f}\`\n`;
    }
    md += '\n';
  }

  if (session.commands.length > 0) {
    md += `## Executed Commands\n`;
    md += '| Time | Tool | Description | Result |\n';
    md += '|------|------|-------------|--------|\n';
    for (const cmd of session.commands) {
      const time = new Date(cmd.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      md += `| ${time} | ${cmd.tool} | ${cmd.description || '-'} | ${cmd.result === 'success' ? '✅' : cmd.result === 'error' ? '❌' : '-'} |\n`;
    }
    md += '\n';
  }

  if (rawLog) {
    md += `## Raw Log\n\`\`\`\n${rawLog}\n\`\`\`\n`;
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
  const sessionSuffix = sessionFilenameSuffix(session.id || String(session.startedAt));

  // Create monthly directory
  const monthPath = join(CODEX_DIR, monthDir);
  await fs.mkdir(monthPath, { recursive: true });

  // File paths
  const summaryFilename = `${prefix}-${slug}-${sessionSuffix}.md`;
  const detailFilename = `${prefix}-${slug}-${sessionSuffix}.md`;

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
  const dateStr = date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const newEntry = `- ${resultEmoji(session.result)} [${session.title}](${relativePath}) - ${dateStr}${session.repo ? ` \`${session.repo}\`` : ''}`;

  // Update the "recent sessions" section
  const recentHeader = '## Recent Sessions';
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
    /_Last updated:.*_/,
    `_Last updated: ${new Date().toISOString()}_`
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
