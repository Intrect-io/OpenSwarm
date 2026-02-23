// ============================================
// OpenSwarm - Project Scanner
// 디렉토리 워킹 + TS/Python import 파싱 + 테스트 파일 매핑
// ============================================

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, dirname, extname, basename } from 'node:path';
import { KnowledgeGraph } from './graph.js';
import type { GraphNode, GraphEdge, Language, ModuleMetrics } from './types.js';

// ============================================
// Constants
// ============================================

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.turbo', '.cache', '.parcel-cache',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
]);

const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /\.test\.py$/,
];

const MAX_FILE_SIZE = 512 * 1024; // 512KB — 거대한 생성 파일 건너뛰기
const MAX_DEPTH = 15;
const SCAN_TIMEOUT_MS = 30_000;

// ============================================
// Import Regex Patterns
// ============================================

// TypeScript/JavaScript
const TS_IMPORT_FROM = /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
const TS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

// Python
const PY_FROM_IMPORT = /^from\s+([\w.]+)\s+import/gm;
const PY_IMPORT = /^import\s+([\w.]+)/gm;

// ============================================
// Scanner
// ============================================

export interface ScanOptions {
  maxDepth?: number;
  timeoutMs?: number;
}

/**
 * 프로젝트 전체 스캔 → KnowledgeGraph 생성
 */
export async function scanProject(
  projectPath: string,
  projectSlug: string,
  options: ScanOptions = {},
): Promise<KnowledgeGraph> {
  const graph = new KnowledgeGraph(projectSlug, projectPath);
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
  const startTime = Date.now();

  // 프로젝트 루트 노드
  graph.addNode({
    id: '.',
    type: 'project',
    name: projectSlug,
    path: '.',
  });

  // Phase 1: 디렉토리 워킹 — 노드 수집
  await walkDirectory(graph, projectPath, projectPath, '.', 0, maxDepth, startTime, timeoutMs);

  // Phase 2: Import 파싱 — 엣지 생성
  const modules = [...graph.getNodesByType('module'), ...graph.getNodesByType('test_file')];
  for (const mod of modules) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[Scanner] Import parsing timed out after ${timeoutMs}ms`);
      break;
    }
    await parseImports(graph, projectPath, mod);
  }

  // Phase 3: 테스트↔모듈 매핑
  mapTestsToModules(graph);

  graph.scannedAt = Date.now();
  return graph;
}

/**
 * 증분 업데이트: 변경된 파일만 재스캔
 */
export async function incrementalUpdate(
  graph: KnowledgeGraph,
  projectPath: string,
  changedFiles: string[],
): Promise<void> {
  for (const file of changedFiles) {
    const relPath = file.startsWith('/') ? relative(projectPath, file) : file;
    const ext = extname(relPath);

    // 소스 파일이 아니면 무시
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    // 기존 노드가 있으면 엣지만 재파싱
    if (graph.hasNode(relPath)) {
      // 기존 import/depends_on 엣지 제거 (adjacency 동기화 포함)
      graph.removeOutgoingEdges(relPath, ['imports', 'depends_on']);
      const node = graph.getNode(relPath)!;

      // 메트릭 재계산
      try {
        const fullPath = join(projectPath, relPath);
        const content = await readFile(fullPath, 'utf-8');
        const metrics = computeMetrics(content, detectLanguage(ext));
        node.metrics = metrics;
      } catch {
        // 파일 삭제된 경우
        graph.removeNode(relPath);
        continue;
      }

      await parseImports(graph, projectPath, node);
    } else {
      // 새 파일: 노드 추가
      try {
        const fullPath = join(projectPath, relPath);
        const content = await readFile(fullPath, 'utf-8');
        const language = detectLanguage(ext);
        const isTest = isTestFile(relPath);

        const node: GraphNode = {
          id: relPath,
          type: isTest ? 'test_file' : 'module',
          name: basename(relPath),
          path: relPath,
          metrics: computeMetrics(content, language),
        };
        graph.addNode(node);

        // 부모 디렉토리와 contains 엣지
        const parentDir = dirname(relPath);
        if (graph.hasNode(parentDir) || parentDir === '.') {
          graph.addEdge({ source: parentDir === '.' ? '.' : parentDir, target: relPath, type: 'contains' });
        }

        await parseImports(graph, projectPath, node);
      } catch {
        // 파일 읽기 실패 — 무시
      }
    }
  }

  // 테스트 매핑 재실행
  mapTestsToModules(graph);
  graph.scannedAt = Date.now();
}

// ============================================
// Internal: Directory Walking
// ============================================

async function walkDirectory(
  graph: KnowledgeGraph,
  rootPath: string,
  currentPath: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  startTime: number,
  timeoutMs: number,
): Promise<void> {
  if (depth > maxDepth) return;
  if (Date.now() - startTime > timeoutMs) {
    console.warn(`[Scanner] Directory walking timed out after ${timeoutMs}ms`);
    return;
  }

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return; // 접근 불가 디렉토리
  }

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name);
    const entryRelPath = relPath === '.' ? entry.name : `${relPath}/${entry.name}`;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;

      graph.addNode({
        id: entryRelPath,
        type: 'directory',
        name: entry.name,
        path: entryRelPath,
      });
      graph.addEdge({ source: relPath === '.' ? '.' : relPath, target: entryRelPath, type: 'contains' });

      await walkDirectory(graph, rootPath, entryPath, entryRelPath, depth + 1, maxDepth, startTime, timeoutMs);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      // 파일 크기 체크
      try {
        const fileStat = await stat(entryPath);
        if (fileStat.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }

      const language = detectLanguage(ext);
      const isTest = isTestFile(entry.name);

      let content: string;
      try {
        content = await readFile(entryPath, 'utf-8');
      } catch {
        continue;
      }

      const metrics = computeMetrics(content, language);

      graph.addNode({
        id: entryRelPath,
        type: isTest ? 'test_file' : 'module',
        name: entry.name,
        path: entryRelPath,
        metrics,
      });
      graph.addEdge({ source: relPath === '.' ? '.' : relPath, target: entryRelPath, type: 'contains' });
    }
  }
}

// ============================================
// Internal: Import Parsing
// ============================================

async function parseImports(
  graph: KnowledgeGraph,
  projectPath: string,
  node: GraphNode,
): Promise<void> {
  const fullPath = join(projectPath, node.path);
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    return;
  }

  const language = node.metrics?.language ?? 'other';
  const importPaths: Array<{ raw: string; isRelative: boolean }> = [];

  if (language === 'typescript') {
    for (const regex of [TS_IMPORT_FROM, TS_REQUIRE, TS_DYNAMIC_IMPORT]) {
      // Reset regex state
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const raw = match[1];
        importPaths.push({ raw, isRelative: raw.startsWith('.') });
      }
    }
  } else if (language === 'python') {
    PY_FROM_IMPORT.lastIndex = 0;
    PY_IMPORT.lastIndex = 0;

    let match;
    while ((match = PY_FROM_IMPORT.exec(content)) !== null) {
      const raw = match[1];
      importPaths.push({ raw, isRelative: raw.startsWith('.') });
    }
    while ((match = PY_IMPORT.exec(content)) !== null) {
      const raw = match[1];
      importPaths.push({ raw, isRelative: false });
    }
  }

  for (const { raw, isRelative } of importPaths) {
    if (isRelative) {
      // 상대 경로 resolve
      const base = resolveRelativeImport(node.path, raw, language);
      if (base) {
        // 확장자 후보들로 매칭 시도
        const candidates = language === 'typescript'
          ? [base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '/index.ts', base + '/index.tsx', base + '/index.js']
          : [base + '.py', base + '/__init__.py'];
        const resolved = candidates.find(c => graph.hasNode(c));
        if (resolved) {
          graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
        }
      }
    } else {
      // 외부 패키지: depends_on 엣지 (가상 노드 불필요, 메타데이터로 기록)
      graph.addEdge({
        source: node.id,
        target: `pkg:${raw.split('/')[0]}`,
        type: 'depends_on',
        metadata: { package: raw },
      });
    }
  }
}

/**
 * 상대 import 경로를 프로젝트 내 노드 ID로 resolve
 */
function resolveRelativeImport(
  fromPath: string,
  importPath: string,
  language: Language,
): string | null {
  const dir = dirname(fromPath);

  if (language === 'typescript') {
    // .js/.ts 확장자 제거 후 시도
    const cleaned = importPath.replace(/\.[jt]sx?$/, '');
    const base = join(dir, cleaned).replace(/\\/g, '/').replace(/^\.\//, '');

    // 후보 목록 반환 — 호출부에서 graph.hasNode()로 확인
    // 가장 일반적인 패턴부터 반환
    return base;
  }

  if (language === 'python') {
    const pyPath = importPath.replace(/\./g, '/');
    return join(dir, pyPath).replace(/\\/g, '/');
  }

  return null;
}

// ============================================
// Internal: Test ↔ Module Mapping
// ============================================

function mapTestsToModules(graph: KnowledgeGraph): void {
  const testFiles = graph.getNodesByType('test_file');

  for (const testNode of testFiles) {
    // 이미 import 엣지로 연결된 모듈들에 tests 엣지 추가
    const imports = graph.getImports(testNode.id);
    for (const imported of imports) {
      if (imported.type === 'module') {
        graph.addEdge({ source: testNode.id, target: imported.id, type: 'tests' });
      }
    }

    // 네이밍 컨벤션 기반 매핑: foo.test.ts → foo.ts
    const possibleSource = guessSourceFromTestName(testNode.name, testNode.path);
    if (possibleSource && graph.hasNode(possibleSource)) {
      graph.addEdge({ source: testNode.id, target: possibleSource, type: 'tests' });
    }
  }
}

function guessSourceFromTestName(testName: string, testPath: string): string | null {
  const dir = dirname(testPath);

  // foo.test.ts → foo.ts
  const stripped = testName
    .replace(/\.test\.[tj]sx?$/, '')
    .replace(/\.spec\.[tj]sx?$/, '')
    .replace(/_test$/, '')
    .replace(/^test_/, '');

  if (!stripped || stripped === testName) return null;

  // 같은 디렉토리에서 찾기
  const ext = extname(testName).replace(/^\.test|\.spec/, '');
  const candidates = [
    `${dir}/${stripped}.ts`,
    `${dir}/${stripped}.tsx`,
    `${dir}/${stripped}.js`,
    `${dir}/${stripped}.py`,
    // src/ 디렉토리에서 찾기 (tests/ 폴더 → src/ 매핑)
    `${dir.replace(/\/?tests?\/?/, '/').replace(/\/?__tests__\/?/, '/')}${stripped}.ts`,
  ];

  return candidates[0]?.replace(/\\/g, '/') ?? null;
}

// ============================================
// Internal: Helpers
// ============================================

function detectLanguage(ext: string): Language {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'typescript';
  if (['.py', '.pyw'].includes(ext)) return 'python';
  return 'other';
}

function isTestFile(name: string): boolean {
  return TEST_PATTERNS.some(p => p.test(name));
}

function computeMetrics(content: string, language: Language): ModuleMetrics {
  const lines = content.split('\n');
  const loc = lines.filter(l => l.trim().length > 0).length;

  let exportCount = 0;
  let importCount = 0;

  if (language === 'typescript') {
    for (const line of lines) {
      if (/^export\s/.test(line.trim())) exportCount++;
      if (/^import\s/.test(line.trim()) || /require\(/.test(line)) importCount++;
    }
  } else if (language === 'python') {
    for (const line of lines) {
      if (/^(from|import)\s/.test(line.trim())) importCount++;
      // Python은 모든 top-level이 사실상 export
      if (/^(def |class |[A-Z_]+ =)/.test(line.trim())) exportCount++;
    }
  }

  return { loc, exportCount, importCount, language };
}

