// ============================================
// OpenSwarm - deterministic CodeQL-style quality harness
// ============================================
//
// Full-tree, fail-closed inspection for `openswarm review --max`:
//   1. Enumerate every tracked source file (no silent skips).
//   2. Read each file with a hard byte ceiling; read / scope / truncation
//      failures become explicit error findings — never "passed with gaps".
//   3. Run discover / `.openswarm/verify.yaml` quality commands inside the
//      existing isolated verify sandbox.
//
// This is the M0 engine behind hygiene-style inspection (PLATFORM_ROADMAP).

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { resolveBaseRef } from '../support/worktreeManager.js';
import type { VerifyConfig } from '../core/types.js';
import { scanFileContent } from '../registry/bsDetector.js';
import { loadTrustedVerifyPlan } from '../agents/deterministicTester.js';
import type { VerifyCommand } from './manifest.js';
import { runVerify } from './runner.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 512 * 1024;
const OUTPUT_TAIL = 2_000;

/** Source extensions inspected by the harness (mirrors reviewAudit coverage). */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.rs', '.go',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.cs',
  '.rb', '.php', '.swift', '.m', '.mm',
  '.ex', '.exs', '.clj', '.cljs', '.ml', '.mli', '.hs', '.dart', '.lua', '.jl', '.zig', '.nim',
]);

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'trash', '.openswarm', 'htmlcov', 'coverage', 'vendor',
  'target', '__pycache__', 'bin', 'obj',
]);

export type QualityFindingLevel = 'error' | 'warning' | 'note';

export interface QualityFinding {
  ruleId: string;
  level: QualityFindingLevel;
  message: string;
  filePath?: string;
  line?: number;
}

export interface QualityCommandResult {
  name: string;
  kind: VerifyCommand['kind'];
  status: 'pass' | 'fail' | 'infra' | 'skipped';
  detail: string;
}

export interface QualityHarnessResult {
  status: 'passed' | 'findings' | 'failed';
  filesListed: number;
  filesScanned: number;
  findings: QualityFinding[];
  commands: QualityCommandResult[];
  detail?: string;
}

export type QualityCommandExecutor = (
  projectPath: string,
  commands: VerifyCommand[],
  packageJsonByDirectory: Record<string, string>,
) => Promise<QualityCommandResult[]>;

export interface QualityHarnessOptions {
  verify?: VerifyConfig;
  /** Skip isolated quality commands (static scan only). */
  staticOnly?: boolean;
  /** Override the tracked-source listing (tests). */
  sourceFiles?: readonly string[];
  /** Inject isolated command execution (tests). */
  executeCommands?: QualityCommandExecutor;
}

function shortened(value: string, limit = OUTPUT_TAIL): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function languageForExtension(ext: string): string | null {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.pyw': 'python',
    '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp',
    '.hpp': 'cpp', '.hxx': 'cpp', '.cs': 'csharp',
  };
  return map[ext] ?? null;
}

export function selectQualitySourceFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((file) => {
    if (!file || file.includes('\0')) return false;
    const ext = extname(file).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) return false;
    if (file.split(/[/\\]/).some((seg) => SKIP_DIR_SEGMENTS.has(seg))) return false;
    return true;
  }))].sort();
}

async function findGitExecutable(): Promise<string | undefined> {
  const binary = process.platform === 'win32' ? 'git.exe' : 'git';
  const candidates: string[] = [];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    candidates.push(join(directory, binary));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Every tracked source path (git index). Missing coverage is an explicit failure —
 * the harness must not silently audit a subset.
 */
export async function listTrackedQualitySourceFiles(projectPath: string): Promise<string[]> {
  const git = await findGitExecutable();
  if (!git) throw new Error('git is not available on an absolute PATH entry.');
  try {
    const { stdout } = await execFileAsync(git, ['ls-files', '-z'], {
      cwd: projectPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return selectQualitySourceFiles(stdout.split('\u0000'));
  } catch (error) {
    throw new Error('Could not enumerate tracked source for the quality harness.', { cause: error });
  }
}

async function readBoundedSource(absolutePath: string): Promise<string> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('source must be a regular file');
    }
    if (info.size > MAX_SOURCE_BYTES) {
      const err = new Error(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
      (err as NodeJS.ErrnoException & { code?: string }).code = 'QUALITY_TRUNCATED';
      throw err;
    }
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SOURCE_BYTES) {
      const err = new Error(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
      (err as NodeJS.ErrnoException & { code?: string }).code = 'QUALITY_TRUNCATED';
      throw err;
    }
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) {
      const err = new Error('source contains NUL bytes');
      (err as NodeJS.ErrnoException & { code?: string }).code = 'QUALITY_BINARY';
      throw err;
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Static pass over every listed path. A path that cannot be fully read yields an
 * error finding so the harness cannot report a clean scan with holes.
 */
export async function scanStaticQuality(
  projectPath: string,
  sourceFiles: readonly string[],
): Promise<{ findings: QualityFinding[]; filesScanned: number }> {
  const root = resolve(projectPath);
  const findings: QualityFinding[] = [];
  let filesScanned = 0;

  for (const file of sourceFiles) {
    if (!file || file.includes('\0') || isAbsolute(file) || /(^|\/)\.\.(\/|$)/.test(file)) {
      findings.push({
        ruleId: 'openswarm/quality-scope',
        level: 'error',
        message: `Source path escapes or is invalid for the quality harness: ${file || '<empty>'}`,
        filePath: file || undefined,
      });
      continue;
    }
    const absolute = resolve(root, file);
    if (!inside(root, absolute)) {
      findings.push({
        ruleId: 'openswarm/quality-scope',
        level: 'error',
        message: `Source path escapes repository root: ${file}`,
        filePath: file,
      });
      continue;
    }

    try {
      const content = await readBoundedSource(absolute);
      filesScanned += 1;
      const language = languageForExtension(extname(file).toLowerCase());
      if (!language) continue;
      for (const issue of scanFileContent(content, file, language)) {
        if (issue.severity === 'minor') continue;
        findings.push({
          ruleId: `openswarm/quality-bs/${issue.category}`,
          level: issue.severity === 'critical' ? 'error' : 'warning',
          message: issue.message,
          filePath: file,
          line: issue.line > 0 ? issue.line : undefined,
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'QUALITY_TRUNCATED') {
        findings.push({
          ruleId: 'openswarm/quality-truncated',
          level: 'error',
          message: `Read truncated — file exceeds the ${MAX_SOURCE_BYTES}-byte quality harness ceiling.`,
          filePath: file,
        });
      } else if (code === 'QUALITY_BINARY') {
        findings.push({
          ruleId: 'openswarm/quality-binary',
          level: 'error',
          message: 'Source read failed — file contains NUL bytes and cannot be scanned as text.',
          filePath: file,
        });
      } else {
        findings.push({
          ruleId: 'openswarm/quality-read',
          level: 'error',
          message: `Source read failed — scan coverage is incomplete: ${shortened(message, 240)}`,
          filePath: file,
        });
      }
    }
  }

  if (sourceFiles.length > 0 && filesScanned === 0 && findings.every((f) => f.ruleId !== 'openswarm/quality-read')) {
    // Enumeration produced paths but none were readable without an explicit finding —
    // treat as coverage failure so we never claim a vacuous pass.
    const hasCoverageFinding = findings.some((f) =>
      f.ruleId === 'openswarm/quality-truncated'
      || f.ruleId === 'openswarm/quality-binary'
      || f.ruleId === 'openswarm/quality-scope'
      || f.ruleId === 'openswarm/quality-read');
    if (!hasCoverageFinding) {
      findings.push({
        ruleId: 'openswarm/quality-coverage',
        level: 'error',
        message: `Listed ${sourceFiles.length} source file(s) but scanned none.`,
      });
    }
  }

  return { findings, filesScanned };
}

export async function defaultExecuteQualityCommands(
  projectPath: string,
  commands: VerifyCommand[],
  packageJsonByDirectory: Record<string, string>,
): Promise<QualityCommandResult[]> {
  if (commands.length === 0) return [];
  const base = await resolveBaseRef(projectPath).catch((error) => {
    throw new Error(`quality-harness: failed to resolve base ref: ${error instanceof Error ? error.message : String(error)}`);
  });
  const evidence = await runVerify({
    projectPath,
    commands,
    baseRef: base.ref,
    trustedPackageJsonByDirectory: packageJsonByDirectory,
  });
  return evidence.map((item) => {
    let status: QualityCommandResult['status'];
    if (item.securityFailure) status = 'fail';
    else if (item.headStatus === 'pass') status = 'pass';
    else if (item.headStatus === 'infra') status = 'infra';
    else status = 'fail';
    return {
      name: item.command.name,
      kind: item.command.kind,
      status,
      detail: shortened(item.rawOutputTail),
    };
  });
}

function commandFindings(commands: readonly QualityCommandResult[]): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const command of commands) {
    if (command.status === 'pass' || command.status === 'skipped') continue;
    findings.push({
      ruleId: `openswarm/quality-command/${command.kind}`,
      level: 'error',
      message: command.status === 'infra'
        ? `Quality command "${command.name}" hit an infrastructure failure: ${command.detail || 'no detail'}`
        : `Quality command "${command.name}" failed in isolation: ${command.detail || 'non-zero exit'}`,
    });
  }
  return findings;
}

function harnessStatus(findings: readonly QualityFinding[]): QualityHarnessResult['status'] {
  if (findings.some((f) => f.level === 'error')) return 'failed';
  if (findings.length > 0) return 'findings';
  return 'passed';
}

/**
 * Deterministic quality harness: complete static coverage of tracked source,
 * then isolated typecheck/lint/test/build commands from verify discovery.
 */
export async function runQualityHarness(
  projectPath: string,
  options: QualityHarnessOptions = {},
): Promise<QualityHarnessResult> {
  let filesListed = 0;
  let sourceFiles: string[];
  try {
    sourceFiles = options.sourceFiles
      ? selectQualitySourceFiles(options.sourceFiles)
      : await listTrackedQualitySourceFiles(projectPath);
    filesListed = sourceFiles.length;
  } catch (error) {
    const cause = shortened(error instanceof Error ? error.message : String(error));
    return {
      status: 'failed',
      filesListed: 0,
      filesScanned: 0,
      findings: [{
        ruleId: 'openswarm/quality-enumerate',
        level: 'error',
        message: `Could not list tracked source for the quality harness: ${cause}`,
      }],
      commands: [],
      detail: cause,
    };
  }

  const staticScan = await scanStaticQuality(projectPath, sourceFiles);
  const findings = [...staticScan.findings];
  const commands: QualityCommandResult[] = [];

  const verify = options.verify ?? { enabled: true, blockOnNewFailures: true, maxCommands: 4 };
  if (!options.staticOnly && verify.enabled) {
    try {
      const plan = await loadTrustedVerifyPlan(projectPath, verify);
      const execute = options.executeCommands ?? defaultExecuteQualityCommands;
      const results = await execute(projectPath, plan.commands, plan.packageJsonByDirectory);
      commands.push(...results);
      findings.push(...commandFindings(results));
    } catch (error) {
      const cause = shortened(error instanceof Error ? error.message : String(error));
      findings.push({
        ruleId: 'openswarm/quality-commands',
        level: 'error',
        message: `Quality command planning/execution failed: ${cause}`,
      });
    }
  }

  return {
    status: harnessStatus(findings),
    filesListed,
    filesScanned: staticScan.filesScanned,
    findings,
    commands,
    ...(filesListed !== staticScan.filesScanned
      ? { detail: `Scanned ${staticScan.filesScanned}/${filesListed} tracked source file(s).` }
      : {}),
  };
}
