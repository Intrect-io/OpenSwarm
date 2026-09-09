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
import { withFileLock } from '../support/fileLock.js';
import { atomicWriteFile } from '../support/atomicFile.js';

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
    await atomicWriteFile(indexPath, initialIndex);
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
 * Slugify text for filenames
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Generate session filename suffix
 */
export function sessionFilenameSuffix(id: string): string {
  const hash = createHash('md5').update(id).digest('hex').slice(0, 4);
  return hash;
}

/**
 * Format duration
 */
function formatDuration(startMs: number, endMs: number): string {
  const diff = endMs - startMs;
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Result emoji
 */
function resultEmoji(result: CodexSession['result']): string {
  switch (result) {
    case 'success': return '✅';
    case 'partial': return '⚠️';
    case 'failed': return '❌';
    case 'ongoing': return '🔄';
  }
}

/**
 * Generate summary content
 */
function generateSummary(session: CodexSession, detailPath: string): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString(getDateLocale(), {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`**Date:** ${dateStr}`);
  lines.push(`**Result:** ${resultEmoji(session.result)} ${session.result}`);
  if (session.endedAt) {
    lines.push(`**Duration:** ${formatDuration(session.startedAt, session.endedAt)}`);
  }
  if (session.repo) {
    lines.push(`**Repository:** ${session.repo}`);
  }
  if (session.tags.length > 0) {
    lines.push(`**Tags:** ${session.tags.join(', ')}`);
  }
  lines.push('');
  if (session.problem) {
    lines.push('## Problem');
    lines.push('');
    lines.push(session.problem);
    lines.push('');
  }
  if (session.solution) {
    lines.push('## Solution');
    lines.push('');
    lines.push(session.solution);
    lines.push('');
  }
  if (session.filesChanged.length > 0) {
    lines.push('## Files Changed');
    lines.push('');
    for (const file of session.filesChanged) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`_Full details: [${basename(detailPath)}](.sessions/${basename(detailPath)})_`);
  return lines.join('\n');
}

/**
 * Generate detailed record content
 */
function generateDetail(session: CodexSession, rawLog?: string): string {
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString(getDateLocale(), {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`**Session ID:** ${session.id}`);
  lines.push(`**Date:** ${dateStr}`);
  lines.push(`**Result:** ${resultEmoji(session.result)} ${session.result}`);
  if (session.endedAt) {
    lines.push(`**Duration:** ${formatDuration(session.startedAt, session.endedAt)}`);
  }
  if (session.repo) {
    lines.push(`**Repository:** ${session.repo}`);
  }
  if (session.tags.length > 0) {
    lines.push(`**Tags:** ${session.tags.join(', ')}`);
  }
  lines.push('');
  if (session.problem) {
    lines.push('## Problem');
    lines.push('');
    lines.push(session.problem);
    lines.push('');
  }
  if (session.solution) {
    lines.push('## Solution');
    lines.push('');
    lines.push(session.solution);
    lines.push('');
  }
  if (session.filesChanged.length > 0) {
    lines.push('## Files Changed');
    lines.push('');
    for (const file of session.filesChanged) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }
  if (session.commands.length > 0) {
    lines.push('## Commands');
    lines.push('');
    for (const cmd of session.commands) {
      const emoji = cmd.result === 'success' ? '✅' : cmd.result === 'error' ? '❌' : '⬜';
      const time = new Date(cmd.timestamp).toLocaleTimeString(getDateLocale());
      lines.push(`- ${emoji} **${cmd.tool}** ${cmd.description || ''} _(${time})_`);
    }
    lines.push('');
  }
  if (rawLog) {
    lines.push('## Raw Log');
    lines.push('');
    lines.push('```');
    lines.push(rawLog);
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * Save session to disk — cross-process atomic via withFileLock
 */
export async function saveSession(
  session: CodexSession,
  rawLog?: string,
): Promise<{ summaryPath: string; detailPath: string }> {
  await initCodex();

  const date = new Date(session.startedAt);
  const { monthDir, prefix } = getDatePaths(date);
  const slug = slugify(session.title);
  const sessionSuffix = sessionFilenameSuffix(session.id);

  // Create monthly directory
  const monthPath = join(CODEX_DIR, monthDir);
  await fs.mkdir(monthPath, { recursive: true });

  // File paths
  const summaryFilename = `${prefix}-${slug}-${sessionSuffix}.md`;
  const detailFilename = `${prefix}-${slug}-${sessionSuffix}.md`;

  const summaryPath = join(monthPath, summaryFilename);
  const detailPath = join(CODEX_DIR, '.sessions', detailFilename);

  // Serialize the full save (detail + summary + index) under a cross-process lock
  // so concurrent saveSession calls from different runners never interleave.
  const lockPath = join(CODEX_DIR, '.sessions', '.save.lock');
  await withFileLock(lockPath, async () => {
    // Save detailed record first
    const detailContent = generateDetail(session, rawLog);
    await atomicWriteFile(detailPath, detailContent);
    console.log(`[Codex] Saved detail: ${detailPath}`);

    // Save summary
    const summaryContent = generateSummary(session, detailPath);
    await atomicWriteFile(summaryPath, summaryContent);
    console.log(`[Codex] Saved summary: ${summaryPath}`);

    // Update index.md
    await updateIndex(session, summaryPath);
  });

  return { summaryPath, detailPath };
}

/**
 * Update index.md — atomic read-modify-write with cross-process lock
 */
async function updateIndex(session: CodexSession, summaryPath: string): Promise<void> {
  const indexPath = join(CODEX_DIR, 'index.md');

  await withFileLock(indexPath + '.lock', async () => {
    let content = await fs.readFile(indexPath, 'utf-8');

    const relativePath = summaryPath.replace(CODEX_DIR + '/', '');
    const date = new Date(session.startedAt);
    const dateStr = date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const newEntry = `- [${session.title}](${relativePath}) — ${dateStr} — ${session.result}`;

    // Find the "Recent Sessions" section
    const sectionMatch = content.match(/## Recent Sessions\n\n([\s\S]*?)(?=\n## |\n---|$)/);
    if (sectionMatch) {
      const existingSection = sectionMatch[1];
      const beforeSection = content.slice(0, sectionMatch.index! + '## Recent Sessions\n\n'.length);
      const afterSection = content.slice(sectionMatch.index! + sectionMatch[0].length);

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

    await atomicWriteFile(indexPath, content);
    console.log('[Codex] Updated index.md');
  });
}

/**
 * Session builder - incrementally construct a session
 */
export class SessionBuilder {
  private session: CodexSession;

  constructor(title: string, repo?: string) {
    this.session = {
      id: createHash('md5').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12),
      title,
      repo,
      startedAt: Date.now(),
      tags: [],
      filesChanged: [],
      commands: [],
      result: 'ongoing',
    };
  }

  addTag(tag: string): SessionBuilder {
    if (!this.session.tags.includes(tag)) {
      this.session.tags.push(tag);
    }
    return this;
  }

  addFile(file: string): SessionBuilder {
    if (!this.session.filesChanged.includes(file)) {
      this.session.filesChanged.push(file);
    }
    return this;
  }

  addCommand(tool: string, description?: string, result?: 'success' | 'error'): SessionBuilder {
    this.session.commands.push({
      tool,
      description,
      timestamp: Date.now(),
      result,
    });
    return this;
  }

  setProblem(problem: string): SessionBuilder {
    this.session.problem = problem;
    return this;
  }

  setSolution(solution: string): SessionBuilder {
    this.session.solution = solution;
    return this;
  }

  setResult(result: CodexSession['result']): SessionBuilder {
    this.session.result = result;
    return this;
  }

  build(): CodexSession {
    this.session.endedAt = Date.now();
    return this.session;
  }
}

/**
 * Quick save - one-liner for simple sessions
 */
export async function quickSave(
  title: string,
  result: CodexSession['result'],
  filesChanged: string[] = [],
  options?: { problem?: string; solution?: string; repo?: string; tags?: string[]; rawLog?: string },
): Promise<{ summaryPath: string; detailPath: string }> {
  const builder = new SessionBuilder(title, options?.repo);
  if (options?.tags) options.tags.forEach(t => builder.addTag(t));
  filesChanged.forEach(f => builder.addFile(f));
  if (options?.problem) builder.setProblem(options.problem);
  if (options?.solution) builder.setSolution(options.solution);
  builder.setResult(result);

  return saveSession(builder.build(), options?.rawLog);
}

/**
 * Get recent sessions from index
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