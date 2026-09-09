// ============================================
// OpenSwarm - Project Scanner
// Directory walking + TS/Python import parsing + test file mapping
// ============================================

import { constants } from 'node:fs';
import { readdir, readFile, open, realpath } from 'node:fs/promises';
import { join, relative, dirname, extname, basename, isAbsolute, resolve, sep } from 'node:path';
import { KnowledgeGraph } from './graph.js';
import type { GraphNode, Language, ModuleMetrics } from './types.js';

// Constants

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.turbo', '.cache', '.parcel-cache',
  '.venv-mcp', 'site-packages',
  // INT-1810 R3: these are .gitignored artifacts but the scanner doesn't read .gitignore.
  // Without skipping them, scanning a repo with a large `trash/` (archived code) exploded the
  // registry to 624650 entities (normal ~1,594) and the conflict detector then treated those
  // trash files as shared between unrelated issues → false conflicts.
  'trash', '.openswarm', 'htmlcov', '.ruff_cache', 'worktree',
  // INT-2320: vendored third-party trees are not the repo's own code. Thousands of
  // short generic filenames (a.py, run.py, api.py) poisoned issue-impact matching,
  // so the conflict detector deferred every same-project task pair as "conflict".
  'vendor', 'vendors', 'third_party', 'third-party',
]);

const SKIP_DIR_PREFIXES = ['.'];

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
]);

const TEST_FILE_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /\.test\.py$/,
];

const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip large generated files
const MAX_DEPTH = 15;
const SCAN_TIMEOUT_MS = 30_000;
const MAX_NODES = 50_000; // Bounded node budget — prevents OOM on repos with generated code

// Import Regex Patterns

// TypeScript/JavaScript
const TS_IMPORT_FROM = /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
const TS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

// Python
const PY_FROM_IMPORT = /^from\s+([\w.]+)\s+import\s+([^\n#]+)/gm;
const PY_IMPORT = /^import\s+([\w.]+)/gm;

// Scanner

export interface ScanOptions {
  maxDepth?: number;
  timeoutMs?: number;
  /** Maximum number of file/module nodes to collect before stopping. */
  maxNodes?: number;
}

/**
 * Full project scan → create KnowledgeGraph
 */
export async function scanProject(
  projectPath: string,
  projectSlug: string,
  options: ScanOptions = {},
): Promise<KnowledgeGraph> {
  const graph = new KnowledgeGraph(projectSlug, projectPath);
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const startTime = Date.now();

  // Project root node
  graph.addNode({
    id: '.',
    type: 'project',
    name: projectSlug,
    path: '.',
  });

  // Phase 1: Directory walking — collect nodes
  await walkDirectory(graph, projectPath, '.', 0, maxDepth, startTime, timeoutMs, maxNodes);

  // Phase 2: Import parsing — create edges
  const modules = [...graph.getNodesByType('module'), ...graph.getNodesByType('test_file')];
  for (const mod of modules) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[Scanner] Import parsing timed out after ${timeoutMs}ms`);
      break;
    }
    await parseImports(graph, projectPath, mod);
  }

  // Phase 3: Test ↔ module mapping
  mapTestsToModules(graph);

  graph.scannedAt = Date.now();
  return graph;
}

/**
 * Incremental update: re-scan only changed files
 */
export async function incrementalUpdate(
  graph: KnowledgeGraph,
  projectPath: string,
  changedFiles: string[],
): Promise<void> {
  const deadline = Date.now() + MAX_INCREMENTAL_UPDATE_MS;
  const root = await realpath(projectPath);
  for (const file of changedFiles) {
    if (Date.now() >= deadline) throw new Error(`Incremental graph update exceeded ${MAX_INCREMENTAL_UPDATE_MS}ms`);
    const candidate = resolve(root, file);
    const lexicalRelative = relative(root, candidate);
    if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
      throw new Error(`Changed path escapes repository root: ${file}`);
    }
    let canonical = candidate;
    try {
      canonical = await realpath(candidate);
    } catch {
      // Deleted paths cannot be canonicalized; the lexical containment check applies.
    }
    const relPath = relative(root, canonical);
    if (relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) {
      throw new Error(`Changed path escapes repository root through a symlink: ${file}`);
    }
    const ext = extname(relPath);

    // Skip non-source files
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    // If node exists, re-parse edges only
    if (graph.hasNode(relPath)) {
      // Re-parse imports for this file
      const node = graph.getNode(relPath);
      if (node) {
        // Remove old edges from this node
        const oldEdges = graph.getEdges(node.id);
        for (const edge of oldEdges) {
          if (edge.source === node.id) {
            graph.removeEdge(edge.source, edge.target, edge.type);
          }
        }
        await parseImports(graph, projectPath, node);
      }
    } else {
      // New file — add node and parse
      const isTest = isTestFile(basename(relPath));
      const language = detectLanguage(ext);
      const fullPath = join(projectPath, relPath);
      let content: string;
      try {
        content = await readBoundedRegularFile(fullPath, MAX_FILE_SIZE);
      } catch {
        continue;
      }
      const metrics = computeMetrics(content, language);
      graph.addNode({
        id: relPath,
        type: isTest ? 'test_file' : 'module',
        name: basename(relPath),
        path: relPath,
        metrics,
      });
      const node = graph.getNode(relPath);
      if (node) {
        await parseImports(graph, projectPath, node);
      }
    }
  }

  // Re-run test mapping
  mapTestsToModules(graph);
  graph.scannedAt = Date.now();
}

// Internal: Directory Walking

async function walkDirectory(
  graph: KnowledgeGraph,
  currentPath: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  startTime: number,
  timeoutMs: number,
  maxNodes: number,
): Promise<void> {
  if (depth > maxDepth) return;
  if (Date.now() - startTime > timeoutMs) {
    console.warn(`[Scanner] Directory walking timed out after ${timeoutMs}ms`);
    return;
  }
  if (graph.nodeCount >= maxNodes) {
    console.warn(`[Scanner] Reached node budget of ${maxNodes} — stopping directory walk`);
    return;
  }

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return; // Inaccessible directory
  }

  for (const entry of entries) {
    if (graph.nodeCount >= maxNodes) {
      console.warn(`[Scanner] Reached node budget of ${maxNodes} — stopping directory walk`);
      return;
    }

    const entryPath = join(currentPath, entry.name);
    const entryRelPath = relPath === '.' ? entry.name : `${relPath}/${entry.name}`;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIR_PREFIXES.some(p => entry.name.startsWith(p))) continue;

      graph.addNode({
        id: entryRelPath,
        type: 'directory',
        name: entry.name,
        path: entryRelPath,
      });
      graph.addEdge({ source: relPath === '.' ? '.' : relPath, target: entryRelPath, type: 'contains' });

      await walkDirectory(graph, entryPath, entryRelPath, depth + 1, maxDepth, startTime, timeoutMs, maxNodes);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const ext = extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const isTest = isTestFile(entry.name);
      const language = detectLanguage(ext);
      let content: string;
      try {
        content = await readBoundedRegularFile(entryPath, MAX_FILE_SIZE);
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

// Internal: Import Parsing

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
        if (raw.startsWith('.')) {
          importPaths.push({ raw, isRelative: true });
        }
      }
    }
  } else if (language === 'python') {
    for (const regex of [PY_FROM_IMPORT, PY_IMPORT]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const raw = match[1];
        if (raw.startsWith('.')) {
          importPaths.push({ raw, isRelative: true });
        }
      }
    }
  }

  for (const { raw } of importPaths) {
    const resolved = resolveRelativeImport(node.path, raw);
    if (resolved && graph.hasNode(resolved)) {
      graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
    }
  }
}

function resolveRelativeImport(fromPath: string, importPath: string): string | null {
  const dir = dirname(fromPath);
  const resolved = resolve('/', dir, importPath);

  // Try with extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    const candidate = resolved + ext;
    if (candidate.startsWith('/')) {
      const relative = candidate.slice(1);
      if (!relative.includes('..')) {
        return relative;
      }
    }
  }
  return null;
}

// Internal: Test ↔ Module Mapping

function mapTestsToModules(graph: KnowledgeGraph): void {
  const testFiles = graph.getNodesByType('test_file');
  for (const testFile of testFiles) {
    const candidates = guessSourceFromTestName(testFile.name, testFile.path);
    for (const candidate of candidates) {
      if (graph.hasNode(candidate)) {
        graph.addEdge({ source: testFile.id, target: candidate, type: 'tests' });
      }
    }
  }
}

function guessSourceFromTestName(testName: string, testPath: string): string[] {
  const candidates: string[] = [];

  // Remove test suffix
  let base = testName
    .replace(/\.test\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/_test\.py$/, '')
    .replace(/^test_/, '')
    .replace(/\.test\.py$/, '');

  // Try same directory
  const dir = dirname(testPath);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw']) {
    candidates.push(join(dir, `${base}${ext}`));
  }

  // Try parent directory (common for __tests__/foo.test.ts → foo.ts)
  const parentDir = dirname(dir);
  if (parentDir !== '.') {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw']) {
      candidates.push(join(parentDir, `${base}${ext}`));
    }
  }

  return candidates;
}

// Internal: Helpers

function detectLanguage(ext: string): Language {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'typescript';
    case '.py':
    case '.pyw':
      return 'python';
    default:
      return 'other';
  }
}

function isTestFile(name: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(name));
}

function computeMetrics(content: string, language: Language): ModuleMetrics {
  const lines = content.split('\n');
  const loc = lines.filter((l: string) => l.trim().length > 0).length;

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
      // In Python, all top-level definitions are effectively exports
      if (/^(def |class |[A-Z_]+ =)/.test(line.trim())) exportCount++;
    }
  }

  return { loc, exportCount, importCount, language };
}