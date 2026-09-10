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
const MAX_INCREMENTAL_UPDATE_MS = 15_000;
const MAX_GRAPH_NODES = 50_000; // Bounded node budget — prevents OOM on repos with generated code

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
  const maxNodes = options.maxNodes ?? MAX_GRAPH_NODES;
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
      throw new Error(`Changed path escapes repository root through a symlink: ${file}`);
    }
    let canonical: string | undefined;
    try {
      canonical = await realpath(candidate);
    } catch {
      // Deleted paths cannot be canonicalized; the lexical containment check applies.
      continue;
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
      graph.addEdge({ source: relPath === '.' ? '.' : relPath, target: relPath, type: 'contains' });
    }
  }
}

// Internal: Directory Walking

/**
 * Walk directory tree and collect nodes
 */
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
    throw new Error(`Graph scan exceeded node budget of ${maxNodes} — scan aborted`);
  }

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return; // Inaccessible directory
  }

  for (const entry of entries) {
    if (graph.nodeCount >= maxNodes) {
      throw new Error(`Graph scan exceeded node budget of ${maxNodes} — scan aborted`);
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
  const filePath = join(projectPath, node.path);
  let content: string;
  try {
    content = await readBoundedRegularFile(filePath, MAX_FILE_SIZE);
  } catch {
    return;
  }

  const language = node.metrics?.language;
  if (!language) return;

  if (language === 'typescript') {
    // TypeScript imports
    const importMatches = content.matchAll(TS_IMPORT_FROM);
    for (const match of importMatches) {
      const importPath = match[1];
      const resolved = resolveRelativeImport(importPath, node.path);
      if (resolved && graph.hasNode(resolved)) {
        graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
      }
    }

    // require()
    const requireMatches = content.matchAll(TS_REQUIRE);
    for (const match of requireMatches) {
      const importPath = match[1];
      const resolved = resolveRelativeImport(importPath, node.path);
      if (resolved && graph.hasNode(resolved)) {
        graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
      }
    }

    // Dynamic imports
    const dynamicMatches = content.matchAll(TS_DYNAMIC_IMPORT);
    for (const match of dynamicMatches) {
      const importPath = match[1];
      const resolved = resolveRelativeImport(importPath, node.path);
      if (resolved && graph.hasNode(resolved)) {
        graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
      }
    }
  } else if (language === 'python') {
    // Python imports
    const fromMatches = content.matchAll(PY_FROM_IMPORT);
    for (const match of fromMatches) {
      const modulePath = match[1].replace(/\./g, '/');
      const resolved = resolveRelativeImport(modulePath, node.path);
      if (resolved && graph.hasNode(resolved)) {
        graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
      }
    }

    const importMatches = content.matchAll(PY_IMPORT);
    for (const match of importMatches) {
      const modulePath = match[1].replace(/\./g, '/');
      const resolved = resolveRelativeImport(modulePath, node.path);
      if (resolved && graph.hasNode(resolved)) {
        graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
      }
    }
  }
}

/**
 * Resolve a relative import path to an absolute path within the project
 */
function resolveRelativeImport(importPath: string, currentPath: string): string | null {
  if (importPath.startsWith('.')) {
    const dir = dirname(currentPath);
    const resolved = resolve(dir, importPath);
    // Try common extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs', '/__init__.py'];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (candidate.startsWith('/')) {
        // Absolute path — not a project import
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/**
 * Map test files to source modules
 */
function mapTestsToModules(graph: KnowledgeGraph): void {
  const testFiles = graph.getNodesByType('test_file');
  for (const test of testFiles) {
    const sources = guessSourceFromTestName(test.name, test.path);
    for (const source of sources) {
      if (graph.hasNode(source)) {
        graph.addEdge({ source: test.id, target: source, type: 'tests' });
      }
    }
  }
}

/**
 * Guess source module from test file name
 */
function guessSourceFromTestName(testName: string, testPath: string): string[] {
  const candidates: string[] = [];

  // Remove test suffix
  let baseName = testName
    .replace(/\.test\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/_test\.py$/, '')
    .replace(/^test_/, '')
    .replace(/\.test\.py$/, '');

  if (baseName) {
    const dir = dirname(testPath);
    candidates.push(join(dir, baseName + '.ts'));
    candidates.push(join(dir, baseName + '.tsx'));
    candidates.push(join(dir, baseName + '.js'));
    candidates.push(join(dir, baseName + '.py'));
  }

  return candidates;
}

/**
 * Detect programming language from file extension
 */
function detectLanguage(ext: string): Language {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'typescript';
  if (['.py', '.pyw'].includes(ext)) return 'python';
  return 'typescript'; // Default
}

/**
 * Check if a file is a test file
 */
function isTestFile(name: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(name));
}

/**
 * Compute metrics for a module
 */
function computeMetrics(content: string, language: Language): ModuleMetrics {
  const lines = content.split('\n');
  const loc = lines.length;
  const codeLines = lines.filter((line: string) => line.trim().length > 0).length;
  const commentLines = lines.filter((line: string) => line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('/*') || line.trim().startsWith('*')).length;

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