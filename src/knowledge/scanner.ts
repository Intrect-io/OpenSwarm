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
  // so the conflict detector deferred every same-project task pair as "conflicting".
  'google-cloud-sdk', 'third_party', 'vendor', 'vendors',
]);

// Prefix-based skip: any directory name starting with these prefixes
const SKIP_DIR_PREFIXES = ['.venv'];

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
]);

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('source must be a regular file');
    if (info.size > maxBytes) throw new Error(`Source file exceeds ${maxBytes} bytes: ${filePath}`);
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}
const MAX_INCREMENTAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INCREMENTAL_UPDATE_MS = 15_000;

const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /\.test\.py$/,
];

const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip large generated files
const MAX_DEPTH = 15;
const SCAN_TIMEOUT_MS = 30_000;

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
  const startTime = Date.now();

  // Project root node
  graph.addNode({
    id: '.',
    type: 'project',
    name: projectSlug,
    path: '.',
  });

  // Phase 1: Directory walking — collect nodes
  await walkDirectory(graph, projectPath, '.', 0, maxDepth, startTime, timeoutMs);

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
      // Remove existing parsed edges (with adjacency sync)
      graph.removeOutgoingEdges(relPath, ['imports', 'depends_on', 'tests']);
      const node = graph.getNode(relPath)!;

      // Recalculate metrics
      try {
        const fullPath = join(projectPath, relPath);
        const content = await readBoundedRegularFile(fullPath, MAX_INCREMENTAL_FILE_BYTES);
        const metrics = computeMetrics(content, detectLanguage(ext));
        node.metrics = metrics;
      } catch {
        // File was deleted
        graph.removeNode(relPath);
        continue;
      }

      await parseImports(graph, projectPath, node);
    } else {
      // New file: add node
      try {
        const fullPath = join(projectPath, relPath);
        const content = await readBoundedRegularFile(fullPath, MAX_INCREMENTAL_FILE_BYTES);
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

        // Contains edge with parent directory
        const parentDir = dirname(relPath);
        if (graph.hasNode(parentDir) || parentDir === '.') {
          graph.addEdge({ source: parentDir === '.' ? '.' : parentDir, target: relPath, type: 'contains' });
        }

        await parseImports(graph, projectPath, node);
      } catch {
        // File read failed — skip
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
    return; // Inaccessible directory
  }

  for (const entry of entries) {
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

      await walkDirectory(graph, entryPath, entryRelPath, depth + 1, maxDepth, startTime, timeoutMs);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const language = detectLanguage(ext);
      const isTest = isTestFile(entry.name);

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
        importPaths.push({ raw, isRelative: raw.startsWith('.') });
      }
    }
  } else if (language === 'python') {
    PY_FROM_IMPORT.lastIndex = 0;
    PY_IMPORT.lastIndex = 0;

    let match;
    while ((match = PY_FROM_IMPORT.exec(content)) !== null) {
      const raw = match[1];
      if (raw.startsWith('.') && /^\.+$/.test(raw)) {
        const importedNames = match[2]
          .split(',')
          .map(name => name.trim().split(/\s+as\s+/)[0]?.trim())
          .filter(name => name && name !== '*');
        for (const importedName of importedNames) {
          importPaths.push({ raw: `${raw}${importedName}`, isRelative: true });
        }
      } else {
        importPaths.push({ raw, isRelative: raw.startsWith('.') });
      }
    }
    while ((match = PY_IMPORT.exec(content)) !== null) {
      const raw = match[1];
      importPaths.push({ raw, isRelative: false });
    }
  }

  for (const { raw, isRelative } of importPaths) {
    if (isRelative) {
      // Resolve relative path
      const base = resolveRelativeImport(node.path, raw, language);
      if (base) {
        // Try matching with extension candidates
        const candidates = language === 'typescript'
          ? [base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '/index.ts', base + '/index.tsx', base + '/index.js']
          : [base + '.py', base + '/__init__.py'];
        const resolved = candidates.find(c => graph.hasNode(c));
        if (resolved) {
          graph.addEdge({ source: node.id, target: resolved, type: 'imports' });
        }
      }
    } else {
      // External package: depends_on edge (no virtual node needed, recorded as metadata)
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
 * Resolve relative import path to in-project node ID
 */
function resolveRelativeImport(
  fromPath: string,
  importPath: string,
  language: Language,
): string | null {
  const dir = dirname(fromPath);

  if (language === 'typescript') {
    // Remove .js/.ts extension and try
    const cleaned = importPath.replace(/\.[jt]sx?$/, '');
    const base = join(dir, cleaned).replace(/\\/g, '/').replace(/^\.\//, '');

    // Return candidate list — caller checks with graph.hasNode()
    // Most common patterns first
    return base;
  }

  if (language === 'python') {
    const leadingDots = importPath.match(/^\.+/)?.[0].length ?? 0;
    if (leadingDots === 0) {
      return importPath.replace(/\./g, '/');
    }

    const modulePath = importPath.slice(leadingDots).replace(/\./g, '/');
    const dirParts = dir.split('/').filter(Boolean);
    const upLevels = Math.max(leadingDots - 1, 0);
    const baseParts = dirParts.slice(0, Math.max(0, dirParts.length - upLevels));
    const moduleParts = modulePath ? modulePath.split('/').filter(Boolean) : [];
    return [...baseParts, ...moduleParts].join('/');
  }

  return null;
}

// Internal: Test ↔ Module Mapping

function mapTestsToModules(graph: KnowledgeGraph): void {
  const testFiles = graph.getNodesByType('test_file');

  for (const testNode of testFiles) {
    graph.removeOutgoingEdges(testNode.id, ['tests']);

    // Add tests edges to modules already connected via import edges
    const imports = graph.getImports(testNode.id);
    for (const imported of imports) {
      if (imported.type === 'module') {
        graph.addEdge({ source: testNode.id, target: imported.id, type: 'tests' });
      }
    }

    // Naming convention based mapping: foo.test.ts → foo.ts
    const possibleSources = guessSourceFromTestName(testNode.name, testNode.path);
    const source = possibleSources.find(candidate => graph.hasNode(candidate));
    if (source) {
      graph.addEdge({ source: testNode.id, target: source, type: 'tests' });
    }
  }
}

function guessSourceFromTestName(testName: string, testPath: string): string[] {
  const dir = dirname(testPath);
  const ext = extname(testName);
  const baseName = basename(testName, ext);

  const stripped = baseName
    .replace(/\.(test|spec)$/, '')
    .replace(/_test$/, '')
    .replace(/^test_/, '');

  if (!stripped || stripped === baseName) return [];

  const sourceDirs = new Set<string>([dir]);
  if (dir === 'tests' || dir === 'test') {
    sourceDirs.add('src');
  } else if (dir.startsWith('tests/') || dir.startsWith('test/')) {
    sourceDirs.add(`src/${dir.replace(/^tests?\//, '')}`);
  }
  if (dir === '__tests__') {
    sourceDirs.add('.');
  } else if (dir.includes('/__tests__')) {
    sourceDirs.add(dir.replace(/\/__tests__(?=\/|$)/, ''));
  }
  if (dir.includes('/tests')) {
    sourceDirs.add(dir.replace(/\/tests(?=\/|$)/, ''));
  }

  const extensions = ext === '.py'
    ? ['.py']
    : ['.ts', '.tsx', '.js', '.jsx'];

  const candidates: string[] = [];
  for (const sourceDir of sourceDirs) {
    for (const sourceExt of extensions) {
      const candidate = sourceDir === '.'
        ? `${stripped}${sourceExt}`
        : `${sourceDir}/${stripped}${sourceExt}`;
      candidates.push(candidate.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }

  return candidates;
}

// Internal: Helpers

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
      // In Python, all top-level definitions are effectively exports
      if (/^(def |class |[A-Z_]+ =)/.test(line.trim())) exportCount++;
    }
  }

  return { loc, exportCount, importCount, language };
}
