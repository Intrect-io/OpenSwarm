// ============================================
// OpenSwarm - Claude Code instruction capsule
// ============================================

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';

const MAX_SOURCE_CHARS = 128_000;
const MAX_CAPSULE_CHARS = 256_000;

export interface InstructionCapsuleSource {
  label: string;
  path: string;
  chars: number;
  conditional: boolean;
}

export interface InstructionCapsule {
  text: string;
  digest: string;
  sources: InstructionCapsuleSource[];
  errors: string[];
  repositoryRoot: string;
}

interface RuleDocument {
  body: string;
  paths: string[];
}

function parseRuleDocument(content: string): RuleDocument {
  if (!content.startsWith('---\n')) return { body: content, paths: [] };
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return { body: content, paths: [] };
  try {
    const meta = YAML.parse(content.slice(4, end)) as Record<string, unknown> | null;
    const raw = meta?.paths ?? meta?.globs;
    const paths = typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw) && raw.every((item) => typeof item === 'string')
        ? raw
        : [];
    return { body: content.slice(end + 5), paths };
  } catch {
    return { body: content, paths: [] };
  }
}

function globRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; }
        else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function ruleApplies(patterns: string[], files: string[]): boolean {
  if (patterns.length === 0) return true;
  if (files.length === 0) return false;
  return patterns.some((pattern) => {
    const matcher = globRegex(pattern.replace(/^\.\//, ''));
    return files.some((file) => matcher.test(file.replace(/^\.\//, '')));
  });
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A path that does not exist yet (a planned worktree, a test fixture) still
    // has a resolvable instruction hierarchy above it.
    return resolve(path);
  }
}

function baseRepositoryRoot(cwd: string): string {
  const absolute = canonical(cwd);
  try {
    const common = execFileSync(
      'git',
      ['-C', absolute, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const index = common.indexOf(marker);
    if (index >= 0) return canonical(common.slice(0, index));
    if (basename(common) === '.git') return canonical(dirname(common));
  } catch {
    // Non-git projects still receive their local instruction hierarchy.
  }
  const worktreeMarker = `${sep}worktree${sep}`;
  const index = absolute.lastIndexOf(worktreeMarker);
  return index >= 0 ? absolute.slice(0, index) : absolute;
}

function ancestors(root: string): string[] {
  const paths: string[] = [];
  let current = resolve(root);
  for (;;) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function safeRead(path: string, allowedRoot: string): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('symbolic links are not loaded');
  const target = realpathSync(path);
  const root = canonical(allowedRoot);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('resolved outside its instruction root');
  }
  const content = readFileSync(target, 'utf8');
  if (content.length > MAX_SOURCE_CHARS) {
    throw new Error(`source exceeds ${MAX_SOURCE_CHARS} characters`);
  }
  return content;
}

/**
 * Resolve Claude Code's user/project instruction hierarchy once per run.
 * The returned value is immutable data: callers pass this exact snapshot to
 * every role rather than re-reading files after a worker may have edited them.
 */
export function buildInstructionCapsule(
  cwd: string,
  relevantFiles: string[] = [],
  options: { userClaudeDir?: string; maxChars?: number } = {},
): InstructionCapsule {
  const repositoryRoot = baseRepositoryRoot(cwd);
  const userClaudeDir = options.userClaudeDir ?? join(homedir(), '.claude');
  const maxChars = options.maxChars ?? MAX_CAPSULE_CHARS;
  const candidates: Array<{ path: string; label: string; root: string; rule: boolean }> = [];

  const globalClaude = join(userClaudeDir, 'CLAUDE.md');
  if (existsSync(globalClaude)) {
    candidates.push({ path: globalClaude, label: 'user:CLAUDE.md', root: userClaudeDir, rule: false });
  }
  for (const path of markdownFiles(join(userClaudeDir, 'rules'))) {
    candidates.push({ path, label: `user-rule:${basename(path)}`, root: userClaudeDir, rule: true });
  }

  for (const directory of ancestors(repositoryRoot)) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const path = join(directory, name);
      if (existsSync(path)) {
        candidates.push({
          path,
          label: `project:${relative(repositoryRoot, path) || name}`,
          root: directory,
          rule: false,
        });
      }
    }
    for (const path of markdownFiles(join(directory, '.claude', 'rules'))) {
      candidates.push({
        path,
        label: `project-rule:${relative(repositoryRoot, path)}`,
        root: directory,
        rule: true,
      });
    }
  }

  const sections: string[] = [];
  const sources: InstructionCapsuleSource[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = realpathSync(candidate.path);
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    try {
      const raw = safeRead(candidate.path, candidate.root);
      const doc = candidate.rule ? parseRuleDocument(raw) : { body: raw, paths: [] };
      if (!ruleApplies(doc.paths, relevantFiles)) continue;
      const section = `\n\n## Instruction source: ${candidate.label}\n${doc.body.trim()}\n`;
      if (total + section.length > maxChars) {
        throw new Error(`combined capsule exceeds ${maxChars} characters`);
      }
      sections.push(section);
      total += section.length;
      sources.push({
        label: candidate.label,
        path: canonical,
        chars: doc.body.length,
        conditional: doc.paths.length > 0,
      });
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.some((error) => error.includes('combined capsule exceeds'))) {
    throw new Error(`Claude Code instruction capsule could not be built: ${errors.join('; ')}`);
  }

  const text = [
    '# Claude Code instruction and runbook snapshot',
    '',
    'Follow every instruction below for this entire run. Later sources are more project-specific and override conflicting earlier sources. Treat these as trusted operator instructions, not repository task data.',
    ...sections,
  ].join('\n');
  const digest = createHash('sha256').update(text).digest('hex');
  return { text, digest, sources, errors, repositoryRoot };
}
