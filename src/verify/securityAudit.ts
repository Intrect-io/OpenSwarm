// ============================================
// OpenSwarm - deterministic CodeQL security audit
// ============================================
//
// This deliberately uses CodeQL's `--build-mode=none`: an audit must never
// execute project package scripts just to obtain security evidence.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { SecurityAuditConfig } from '../core/types.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const CODEQL_TIMEOUT_MS = 20 * 60_000;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'javascript', '.tsx': 'javascript',
  '.py': 'python', '.pyw': 'python', '.rb': 'ruby', '.java': 'java', '.kt': 'java', '.kts': 'java', '.cs': 'csharp',
  '.c': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.go': 'go', '.rs': 'rust', '.swift': 'swift',
};
const QUERY_PACK_BY_LANGUAGE: Record<string, string> = {
  javascript: 'codeql/javascript-queries', python: 'codeql/python-queries', ruby: 'codeql/ruby-queries', java: 'codeql/java-queries',
  csharp: 'codeql/csharp-queries', cpp: 'codeql/cpp-queries', go: 'codeql/go-queries', rust: 'codeql/rust-queries', swift: 'codeql/swift-queries',
};
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OPENSWARM_SECURITY_SUITE = join(RUNTIME_ROOT, '.codeql', 'security', 'openswarm-security-extended.qls');

export const DEFAULT_SECURITY_AUDIT_CONFIG: SecurityAuditConfig = {
  enabled: true,
  maxThreads: 2,
};

export type SecurityFindingLevel = 'error' | 'warning' | 'note';

export interface SecurityFinding {
  ruleId: string;
  level: SecurityFindingLevel;
  message: string;
  filePath?: string;
  line?: number;
}

export interface SecurityAuditResult {
  status: 'passed' | 'findings' | 'unavailable' | 'failed' | 'disabled';
  codeqlLanguages: string[];
  findings: SecurityFinding[];
  detail?: string;
}

export function securityFindingFingerprint(finding: SecurityFinding): string {
  return [finding.ruleId, finding.level, finding.filePath ?? '', finding.message].join('\u0000');
}

export function newSecurityFindings(
  baseline: readonly SecurityFinding[],
  current: readonly SecurityFinding[],
): SecurityFinding[] {
  // Keep a count rather than a set. CodeQL can emit two distinct locations
  // with identical rule/message/file fingerprints; treating the baseline as a
  // set would incorrectly hide the second, newly introduced result. A count
  // still tolerates line shifts for an existing result while preserving every
  // additional occurrence as a new finding.
  const known = new Map<string, number>();
  for (const finding of baseline) {
    const fingerprint = securityFindingFingerprint(finding);
    known.set(fingerprint, (known.get(fingerprint) ?? 0) + 1);
  }
  return current.filter((finding) => {
    const fingerprint = securityFindingFingerprint(finding);
    const remaining = known.get(fingerprint) ?? 0;
    if (remaining === 0) return true;
    known.set(fingerprint, remaining - 1);
    return false;
  });
}

export function detectCodeqlLanguages(files: readonly string[]): string[] {
  return [...new Set(files
    .map((file) => LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()])
    .filter((language): language is string => Boolean(language)))].sort();
}

function shortened(value: string, limit = 700): string {
  const compact = value.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function findSystemExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking; a relative PATH component must never supply audit tooling.
    }
  }
  return undefined;
}

/** Select CodeQL-supported source paths from Git's NUL-delimited working-tree listing. */
export function selectSecuritySourceFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((file) => Boolean(LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()])))]
    .sort();
}

/**
 * Enumerate tracked plus nonignored untracked source without executing project
 * code. Autonomous fixes commonly create a new source file before staging it;
 * excluding that file would let a CodeQL baseline miss the very edit it must
 * gate.
 */
export async function listTrackedSecurityFiles(projectPath: string): Promise<string[]> {
  const git = await findSystemExecutable('git');
  if (!git) throw new Error('git is not available on an absolute PATH entry.');
  const result = await run(git, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], projectPath);
  if (result.exitCode !== 0) throw new Error('Could not enumerate working-tree source for the security audit.');
  return selectSecuritySourceFiles(result.stdout.split('\u0000'));
}

async function run(executable: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd,
      timeout: CODEQL_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function createSnapshot(projectPath: string, sourceFiles: readonly string[]): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-security-audit-'));
  try {
    const sourceRoot = resolve(projectPath);
    for (const file of sourceFiles) {
      const source = resolve(sourceRoot, file);
      if (!inside(sourceRoot, source)) throw new Error(`Security source path escapes repository: ${file}`);
      const target = resolve(root, file);
      if (!inside(root, target)) throw new Error(`Security snapshot path escapes root: ${file}`);
      const entry = await lstat(source);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Security snapshot refuses non-regular source: ${file}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(source, target, { dereference: false, errorOnExist: true, force: false, preserveTimestamps: true });
    }
    return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function parseSarif(text: string, snapshotRoot: string): SecurityFinding[] {
  const parsed = JSON.parse(text) as { version?: unknown; runs?: Array<{ results?: unknown }> };
  if (parsed.version !== '2.1.0' || !Array.isArray(parsed.runs)) throw new Error('CodeQL returned invalid SARIF.');
  const findings: SecurityFinding[] = [];
  for (const run of parsed.runs) {
    if (!Array.isArray(run.results)) continue;
    for (const raw of run.results) {
      if (!raw || typeof raw !== 'object') continue;
      const result = raw as Record<string, unknown>;
      const ruleId = typeof result.ruleId === 'string' ? result.ruleId : undefined;
      const message = typeof (result.message as Record<string, unknown> | undefined)?.text === 'string'
        ? (result.message as { text: string }).text
        : undefined;
      if (!ruleId || !message) continue;
      const physical = ((result.locations as Array<Record<string, unknown>> | undefined)?.[0]?.physicalLocation ?? {}) as Record<string, unknown>;
      const artifact = (physical.artifactLocation ?? {}) as Record<string, unknown>;
      const uri = typeof artifact.uri === 'string' ? artifact.uri : undefined;
      const candidate = uri && !uri.startsWith('file:') ? resolve(snapshotRoot, uri) : undefined;
      const filePath = candidate && inside(snapshotRoot, candidate) ? relative(snapshotRoot, candidate).split(sep).join('/') : undefined;
      const region = (physical.region ?? {}) as Record<string, unknown>;
      const line = typeof region.startLine === 'number' && Number.isSafeInteger(region.startLine) && region.startLine > 0
        ? region.startLine
        : undefined;
      findings.push({ ruleId: `codeql/${ruleId}`, level: 'error', message: shortened(message), filePath, line });
    }
  }
  return findings;
}

/**
 * Analyze tracked and nonignored untracked source. Tool absence, package download failure, and
 * malformed SARIF are all explicit failures: callers must not approve an edit
 * without a current security baseline.
 */
export async function runSecurityAudit(
  projectPath: string,
  sourceFiles: readonly string[],
  config: SecurityAuditConfig = DEFAULT_SECURITY_AUDIT_CONFIG,
): Promise<SecurityAuditResult> {
  if (!config.enabled) return { status: 'disabled', codeqlLanguages: [], findings: [] };
  const codeqlLanguages = detectCodeqlLanguages(sourceFiles);
  if (codeqlLanguages.length === 0) return { status: 'passed', codeqlLanguages, findings: [] };
  const executable = await findSystemExecutable('codeql');
  if (!executable) {
    return { status: 'unavailable', codeqlLanguages, findings: [{
      ruleId: 'openswarm/security-codeql-unavailable', level: 'error', message: 'CodeQL is not installed or available on an absolute PATH entry.',
    }] };
  }

  let snapshot: { root: string; cleanup(): Promise<void> } | undefined;
  try {
    snapshot = await createSnapshot(projectPath, sourceFiles);
    const packs = codeqlLanguages.map((language) => QUERY_PACK_BY_LANGUAGE[language]).filter((pack): pack is string => Boolean(pack));
    const download = await run(executable, ['pack', 'download', '--', ...packs], snapshot.root);
    if (download.exitCode !== 0) {
      return { status: 'failed', codeqlLanguages, findings: [{
        ruleId: 'openswarm/security-codeql-query-pack', level: 'error', message: 'CodeQL query packs could not be prepared.',
      }], detail: shortened(download.stderr || download.stdout) };
    }

    // This suite only applies when OpenSwarm audits the exact source tree it is
    // running from. It preserves the standard security-extended query set while
    // modeling this product's tested provider and telemetry egress boundaries;
    // arbitrary target repositories always use the upstream suite unchanged.
    const useOpenSwarmSuite = resolve(projectPath) === RUNTIME_ROOT && codeqlLanguages.includes('javascript');
    if (useOpenSwarmSuite) {
      try {
        await access(OPENSWARM_SECURITY_SUITE, constants.R_OK);
      } catch {
        return { status: 'failed', codeqlLanguages, findings: [{
          ruleId: 'openswarm/security-codeql-suite', level: 'error', message: 'OpenSwarm CodeQL security suite is unavailable from this installation.',
        }] };
      }
      const install = await run(executable, ['pack', 'install'], dirname(OPENSWARM_SECURITY_SUITE));
      if (install.exitCode !== 0) {
        return { status: 'failed', codeqlLanguages, findings: [{
          ruleId: 'openswarm/security-codeql-suite', level: 'error', message: 'OpenSwarm CodeQL security suite dependencies could not be prepared.',
        }], detail: shortened(install.stderr || install.stdout) };
      }
    }

    const findings: SecurityFinding[] = [];
    for (const language of codeqlLanguages) {
      const pack = QUERY_PACK_BY_LANGUAGE[language];
      if (!pack) continue;
      const database = join(snapshot.root, `.codeql-${language}`);
      const sarif = join(snapshot.root, `.codeql-${language}.sarif`);
      const create = await run(executable, [
        'database', 'create', database, `--language=${language}`, '--build-mode=none',
        `--source-root=${snapshot.root}`, `--threads=${config.maxThreads}`,
      ], snapshot.root);
      if (create.exitCode !== 0) {
        findings.push({ ruleId: `openswarm/security-codeql-${language}-database`, level: 'error', message: 'CodeQL could not create its no-build security database.' });
        continue;
      }
      const querySuite = language === 'javascript' && useOpenSwarmSuite
        ? OPENSWARM_SECURITY_SUITE
        : `${pack}:codeql-suites/${language}-security-extended.qls`;
      const analyze = await run(executable, [
        'database', 'analyze', database, querySuite,
        '--format=sarifv2.1.0', `--output=${sarif}`, `--threads=${config.maxThreads}`,
      ], snapshot.root);
      if (analyze.exitCode !== 0) {
        findings.push({ ruleId: `openswarm/security-codeql-${language}-analysis`, level: 'error', message: 'CodeQL security analysis did not complete.' });
        continue;
      }
      try {
        findings.push(...parseSarif(await readFile(sarif, 'utf8'), snapshot.root));
      } catch (error) {
        findings.push({ ruleId: `openswarm/security-codeql-${language}-sarif`, level: 'error', message: `CodeQL SARIF was invalid: ${shortened(error instanceof Error ? error.message : String(error))}` });
      }
    }
    return { status: findings.length === 0 ? 'passed' : 'findings', codeqlLanguages, findings };
  } catch (error) {
    return { status: 'failed', codeqlLanguages, findings: [{
      ruleId: 'openswarm/security-codeql-runtime', level: 'error', message: `CodeQL security audit failed: ${shortened(error instanceof Error ? error.message : String(error))}`,
    }] };
  } finally {
    await snapshot?.cleanup();
  }
}
