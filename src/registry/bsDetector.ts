// ============================================
// OpenSwarm - BS Detector
// Created: 2026-04-10
// Purpose: 소스 코드에서 BS 패턴을 탐지하는 정적 분석 엔진
// ============================================

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';

// ============ 타입 ============

export type BsSeverity = 'critical' | 'warning' | 'minor';

export interface BsIssue {
  severity: BsSeverity;
  category: string;
  message: string;
  filePath: string;
  line: number;
  matchedText: string;
}

export interface BsScanResult {
  issues: BsIssue[];
  filesScanned: number;
  critical: number;
  warning: number;
  minor: number;
  bsScore: number; // (critical*10 + warning*3 + minor*1) / filesScanned
}

// ============ 패턴 정의 ============

interface BsPattern {
  severity: BsSeverity;
  category: string;
  message: string;
  pattern: RegExp;
  // 특정 언어에서만 적용 (없으면 전체)
  languages?: string[];
  // 이 패턴이 매칭되어도 예외인 경우 (주석 내, 테스트 파일 등)
  excludeIf?: (line: string, filePath: string) => boolean;
}

// 테스트 파일 판별
function isTestPath(filePath: string): boolean {
  return /\.test\.|\.spec\.|_test\.|test_|__tests__/.test(filePath);
}

const BS_PATTERNS: BsPattern[] = [
  // ============ CRITICAL ============

  // 예외 은폐
  {
    severity: 'critical',
    category: 'exception_hiding',
    message: '빈 catch 블록 — 예외를 완전히 무시',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    excludeIf: (_line, fp) => isTestPath(fp) || fp.endsWith('Html.ts'),
  },
  {
    severity: 'critical',
    category: 'exception_hiding',
    message: 'except: pass — Python 예외 은폐',
    pattern: /except\s*:\s*pass/,
    languages: ['python'],
  },
  {
    severity: 'critical',
    category: 'exception_hiding',
    message: 'except Exception: pass — 모든 예외 무시',
    pattern: /except\s+\w+\s*:\s*pass/,
    languages: ['python'],
  },

  // 가짜 성공
  {
    severity: 'critical',
    category: 'fake_execution',
    message: '하드코딩된 성공 반환 — 실제 로직 없이 true/ok 반환',
    pattern: /return\s+(?:true|'ok'|"ok"|'success'|"success")\s*;?\s*\/\/\s*(?:always|todo|fixme|hack)/i,
  },

  // 하드코딩 시크릿
  {
    severity: 'critical',
    category: 'hardcoded_secret',
    message: '하드코딩된 비밀키/토큰 패턴',
    pattern: /(?:password|secret|api_key|apikey|token|private_key)\s*[:=]\s*(?:(?:process\.env|env\.|getenv|os\.environ).*?(?:\|\||\?\?|,)\s*)?['"][^'"]{8,}['"]/i,
    excludeIf: (line, fp) => isTestPath(fp) || /example|sample|template|placeholder|dummy|config\.example/i.test(fp) || /token:\s*'[a-z_]+'/.test(line),
  },

  // 디버그 코드 잔류
  {
    severity: 'critical',
    category: 'debug_leftover',
    message: 'debugger 문 잔류',
    pattern: /^\s*debugger\s*;?\s*$/,
    languages: ['typescript', 'javascript'],
  },

  // ============ WARNING ============

  // TODO + 빈 구현
  {
    severity: 'warning',
    category: 'incomplete',
    message: 'TODO/FIXME + 빈 구현 (pass/return/throw)',
    pattern: /(?:\/\/|#)\s*(?:TODO|FIXME|XXX|HACK)\b.*$/i,
  },

  // console.log 남발 (테스트 제외)
  {
    severity: 'warning',
    category: 'debug_leftover',
    message: 'console.log 잔류 — 프로덕션 코드에 디버그 출력',
    pattern: /console\.log\s*\(/,
    languages: ['typescript', 'javascript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) ||
      /scripts\//.test(fp) ||
      /cli\/|cli\.ts|runners\//.test(fp) ||          // CLI 도구 — console.log는 사용자 출력
      /support\/chat|support\/chatTui/.test(fp) ||    // TUI — console.log는 UI 출력
      fp.endsWith('index.ts') ||                       // 서비스 진입점
      /core\/service/.test(fp) ||                      // 서비스 로깅
      /discord\//.test(fp) ||                          // Discord 핸들러 로깅
      /memory\//.test(fp) ||                           // 메모리 시스템 로깅
      /automation\//.test(fp) ||                       // 자동화 시스템 로깅
      /console\.(?:warn|error|info)/.test(line) ||
      /\[\w+\]/.test(line) || /`\[/.test(line) || /\$\{.*(?:taskPrefix|prefix)/.test(line),
  },

  // as any (TypeScript)
  {
    severity: 'warning',
    category: 'type_safety',
    message: 'as any — 타입 안전성 우회',
    pattern: /as\s+any\b/,
    languages: ['typescript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) || /eslint-disable/.test(line) ||
      /JSON\.parse|URLSearchParams|\.map\(/.test(line),  // JSON/API 결과 캐스트
  },

  // any 타입 사용
  {
    severity: 'warning',
    category: 'type_safety',
    message: ': any 타입 사용 — 타입 안전성 부재',
    pattern: /:\s*any\b(?!\[)/,
    languages: ['typescript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) || /eslint-disable/.test(line) || /\/\//.test(line.split(':')[0] ?? '') ||
      /function\s+normalize|parsed:\s*any|JSON\.parse|response\.\w+\.map/.test(line),  // JSON 파싱 결과 접근 패턴
  },

  // non-null assertion
  {
    severity: 'warning',
    category: 'type_safety',
    message: 'non-null assertion (!) — null 체크 없이 단언',
    pattern: /\w+!\./,
    languages: ['typescript'],
    excludeIf: (_line, fp) => isTestPath(fp),
  },

  // eval 사용
  {
    severity: 'warning',
    category: 'security',
    message: 'eval() 사용 — 코드 인젝션 위험',
    pattern: /\beval\s*\(/,
    excludeIf: (_line, fp) => isTestPath(fp),
  },

  // fake API / example.com
  {
    severity: 'warning',
    category: 'fake_data',
    message: 'example.com 등 가짜 URL — 실 운영 불가',
    pattern: /(?:example\.com|localhost:\d{4}|127\.0\.0\.1:\d{4})/,
    excludeIf: (line, fp) => isTestPath(fp) || /\/\//.test(line.split('http')[0] ?? '') || /config|env|default|Html\.ts|linear|github/i.test(fp) || /config|env|default/i.test(line),
  },

  // ============ MINOR ============

  // 매직 넘버
  {
    severity: 'minor',
    category: 'magic_number',
    message: '매직 넘버 — 의미 불명확한 하드코딩 숫자',
    pattern: /(?:=|return|>|<|===|!==)\s*(?:(?!0\b|1\b|2\b|-1\b|100\b|1000\b|60\b|24\b|365\b)\d{3,})\b/,
    excludeIf: (line, fp) => isTestPath(fp) || /const|timeout|limit|max|min|port|size|width|height|delay|interval|ms|sec/i.test(line),
  },

  // 긴 줄 (200자 이상)
  {
    severity: 'minor',
    category: 'readability',
    message: '200자 이상 긴 줄 — 가독성 저하',
    pattern: /.{200,}/,
    excludeIf: (line, _fp) => /^[\s]*\/\//.test(line) || /^[\s]*\*/.test(line) || /import\s/.test(line) || /https?:\/\//.test(line),
  },
];

// ============ 언어 감지 ============

function detectLanguageForBs(ext: string): string | null {
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

// ============ 단일 파일 스캔 ============

export function scanFileContent(
  content: string,
  filePath: string,
  language: string,
): BsIssue[] {
  const issues: BsIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const bp of BS_PATTERNS) {
      // 언어 필터
      if (bp.languages && !bp.languages.includes(language)) continue;

      const match = line.match(bp.pattern);
      if (!match) continue;

      // 예외 필터
      if (bp.excludeIf && bp.excludeIf(line, filePath)) continue;

      issues.push({
        severity: bp.severity,
        category: bp.category,
        message: bp.message,
        filePath,
        line: i + 1,
        matchedText: match[0].slice(0, 80),
      });
    }
  }

  return issues;
}

// ============ 파일 스캔 (비동기) ============

export async function scanFile(filePath: string): Promise<BsIssue[]> {
  const ext = extname(filePath);
  const language = detectLanguageForBs(ext);
  if (!language) return [];

  const content = await readBoundedRegularFile(filePath);
  return scanFileContent(content, filePath, language);
}

// ============ 결과 집계 ============

export function aggregateResults(issues: BsIssue[], filesScanned: number): BsScanResult {
  const critical = issues.filter(i => i.severity === 'critical').length;
  const warning = issues.filter(i => i.severity === 'warning').length;
  const minor = issues.filter(i => i.severity === 'minor').length;
  const bsScore = filesScanned > 0
    ? (critical * 10 + warning * 3 + minor * 1) / filesScanned
    : 0;

  return { issues, filesScanned, critical, warning, minor, bsScore };
}

// ============ 레포 전체 스캔 ============

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.venv', 'venv', 'coverage', '.turbo', '.cache',
  'trash', 'testing', 'vendor', 'third_party', 'target',
  'bin', 'obj', '.openswarm',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.cs',
]);

const MAX_FILE_SIZE = 512 * 1024;

async function readBoundedRegularFile(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('source must be a regular file');
    if (info.size > MAX_FILE_SIZE) throw new Error(`Source file exceeds ${MAX_FILE_SIZE} bytes: ${filePath}`);
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}

function makeFilesystemIssue(operation: string, filePath: string, err: unknown): BsIssue {
  const message = err instanceof Error ? err.message : String(err);
  return {
    severity: 'critical',
    category: 'filesystem',
    message: `${operation} 실패 — 스캔 결과가 불완전합니다: ${message}`,
    filePath,
    line: 0,
    matchedText: message,
  };
}

export async function scanRepository(
  projectPath: string,
  options?: { verbose?: boolean },
): Promise<BsScanResult> {
  const verbose = options?.verbose ?? false;
  const allIssues: BsIssue[] = [];
  let filesScanned = 0;
  const deadline = Date.now() + 30_000;
  const maxFiles = 10_000;

  async function walk(dirPath: string, relPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      allIssues.push(makeFilesystemIssue('readdir', relPath || '.', err));
      if (verbose) console.log(`  [bs] readdir failed ${relPath || '.'}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (Date.now() >= deadline || filesScanned >= maxFiles) return;
      const fullPath = join(dirPath, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath, entryRelPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        const language = detectLanguageForBs(ext);
        if (!language) continue;

        try {
          const content = await readBoundedRegularFile(fullPath);
          const issues = scanFileContent(content, entryRelPath, language);
          allIssues.push(...issues);
          filesScanned++;

          if (verbose && issues.length > 0) {
            console.log(`  [bs] ${entryRelPath}: ${issues.length} issues`);
          }
        } catch (err) {
          allIssues.push(makeFilesystemIssue('readFile', entryRelPath, err));
          if (verbose) console.log(`  [bs] readFile failed ${entryRelPath}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
    }
  }

  await walk(projectPath, '');
  return aggregateResults(allIssues, filesScanned);
}
