// ============================================
// OpenSwarm - Entity Scanner
// Created: 2026-04-10
// Purpose: Extract function/class/type/constant declarations from repo source files and register them in the registry
// Dependencies: registry/sqliteStore
// Supported: TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#
// ============================================

import { constants } from 'node:fs';
import { readdir, open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, dirname, resolve } from 'node:path';
import { getRegistryStore, LIST_ENTITIES_MAX_LIMIT, type EntitySyncRow } from './sqliteStore.js';
import type { EntityKind, RiskLevel } from './schema.js';
import { yieldToEventLoop } from '../support/yieldToEventLoop.js';

// ============ Constants ============

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.turbo', '.cache', '.parcel-cache',
  '.venv-mcp', 'site-packages', '.openswarm',
  'trash', 'testing', 'vendor', 'third_party',
  // Isolated agent worktrees duplicate the main tree; scanning them inflated
  // vega-agent to 130k+ rows and mixed ephemeral paths into File Map briefs.
  // `worktrees` (plural) is where the repo convention puts human worktrees, and
  // it was not skipped: cgf-portal's registry grew from ~6.8k to 169k entities
  // and each scan blocked the daemon for minutes (AGT-4665).
  'worktree', 'worktrees',
  'target',    // Rust/Java
  'bin', 'obj', // C#
  'cmake-build-debug', 'cmake-build-release', // C/C++
]);
const SKIP_DIR_PREFIXES = ['.venv'];

/** Registry writes per transaction, and per turn handed back to the event loop. */
const REGISTRY_WRITE_SLICE = 250;

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
const MAX_DEPTH = 15;
const SCAN_TIMEOUT_MS = 180_000;
const MIN_SCAN_TIMEOUT_MS = 1_000;

/**
 * Parse and clamp scanner traversal overrides so callers cannot request
 * unbounded depth/timeout (or non-finite values).
 */
export function normalizeScanTraversalOptions(options?: {
  maxDepth?: number;
  timeoutMs?: number;
}): { maxDepth: number; timeoutMs: number } {
  const maxDepth = normalizeBound(options?.maxDepth, MAX_DEPTH, 1, MAX_DEPTH);
  const timeoutMs = normalizeBound(options?.timeoutMs, SCAN_TIMEOUT_MS, MIN_SCAN_TIMEOUT_MS, SCAN_TIMEOUT_MS);
  return { maxDepth, timeoutMs };
}

function normalizeBound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ============ Language definitions ============

type Language = 'typescript' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp' | 'csharp';

interface LanguageConfig {
  extensions: string[];
  testPatterns: RegExp[];
  patterns: Array<{ pattern: RegExp; kind: EntityKind; sigGroup?: number }>;
  blockStyle: 'brace' | 'indent';
  // Conditions to skip at the line level (indented methods, etc.)
  skipIndented?: EntityKind[];
  commentPrefixes: string[];
}

// ---- TypeScript / JavaScript ----
const TS_CONFIG: LanguageConfig = {
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  testPatterns: [/\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/],
  blockStyle: 'brace',
  skipIndented: ['function'],
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    { pattern: /^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)(?:\s*:\s*[^{]+)?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::\s*\w[^=]*)?\s*=>|function)/, kind: 'function' },
    { pattern: /^export\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { pattern: /^export\s+(?:interface|type)\s+(\w+)/, kind: 'type' },
    { pattern: /^export\s+(?:const\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^export\s+const\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
    { pattern: /^(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)(?:\s*:\s*[^{]+)?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
  ],
};

// ---- Python ----
const PY_CONFIG: LanguageConfig = {
  extensions: ['.py', '.pyw'],
  testPatterns: [/_test\.py$/, /test_.*\.py$/, /\.test\.py$/],
  blockStyle: 'indent',
  commentPrefixes: ['#'],
  patterns: [
    { pattern: /^(?:async\s+)?def\s+(\w+)\s*(\([^)]*\)(?:\s*->\s*[^:]+)?)?\s*:/, kind: 'function', sigGroup: 2 },
    { pattern: /^class\s+(\w+)/, kind: 'class' },
    // Type alias: Name = Literal[...] / Name = Union[...] / Name: TypeAlias = ...
    { pattern: /^([A-Z]\w+)\s*(?::\s*TypeAlias\s*)?=\s*(?:Literal|Union|Optional|Type|Annotated|Final)\[/, kind: 'type' },
    // Constant: UPPER_CASE = ...
    { pattern: /^([A-Z][A-Z0-9_]+)\s*(?::\s*\w[^=]*)?\s*=/, kind: 'constant' },
  ],
};

// ---- Go ----
const GO_CONFIG: LanguageConfig = {
  extensions: ['.go'],
  testPatterns: [/_test\.go$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    // func FuncName(params) returnType {
    { pattern: /^func\s+(\w+)\s*(\([^)]*\)(?:\s*(?:\([^)]*\)|[^{]+))?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    // func (receiver) MethodName(params) — method (has a receiver)
    { pattern: /^func\s+\([^)]+\)\s+(\w+)\s*(\([^)]*\)(?:\s*(?:\([^)]*\)|[^{]+))?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    // type StructName struct {
    { pattern: /^type\s+(\w+)\s+struct\s*\{?/, kind: 'class' },
    // type InterfaceName interface {
    { pattern: /^type\s+(\w+)\s+interface\s*\{?/, kind: 'type' },
    // type TypeName = ... / type TypeName ...
    { pattern: /^type\s+(\w+)\s+[^si]/, kind: 'type' },
    // const ConstName = ... (single const)
    { pattern: /^const\s+(\w+)\s*(?:\w+)?\s*=/, kind: 'constant' },
    // var VarName = ... (package level)
    { pattern: /^var\s+(\w+)\s+/, kind: 'constant' },
  ],
};

// ---- Rust ----
const RUST_CONFIG: LanguageConfig = {
  extensions: ['.rs'],
  testPatterns: [],  // Rust는 같은 파일 내 #[cfg(test)] mod tests {}
  blockStyle: 'brace',
  commentPrefixes: ['//', '///', '*', '/*'],
  patterns: [
    // pub fn func_name(params) -> ReturnType {
    { pattern: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(<[^>]*>)?\s*(\([^)]*\)(?:\s*->\s*[^{]+)?)?\s*(?:where\s+[^{]*)?\{?/, kind: 'function', sigGroup: 3 },
    // pub struct StructName {
    { pattern: /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)/, kind: 'class' },
    // pub enum EnumName {
    { pattern: /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)/, kind: 'type' },
    // pub trait TraitName {
    { pattern: /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)/, kind: 'type' },
    // type TypeAlias = ...
    { pattern: /^(?:pub(?:\(crate\))?\s+)?type\s+(\w+)/, kind: 'type' },
    // const CONST_NAME: Type = ...
    { pattern: /^(?:pub(?:\(crate\))?\s+)?const\s+([A-Z][A-Z0-9_]+)\s*:/, kind: 'constant' },
    // static STATIC_NAME: Type = ...
    { pattern: /^(?:pub(?:\(crate\))?\s+)?static\s+(?:mut\s+)?([A-Z][A-Z0-9_]+)\s*:/, kind: 'constant' },
    // impl StructName {
    { pattern: /^impl(?:<[^>]*>)?\s+(\w+)(?:<[^>]*>)?\s*(?:for\s+\w+)?\s*\{/, kind: 'class' },
  ],
};

// ---- Java ----
const JAVA_CONFIG: LanguageConfig = {
  extensions: ['.java'],
  testPatterns: [/Test\.java$/, /Tests\.java$/, /IT\.java$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*', '@'],
  patterns: [
    // public/private/protected ReturnType methodName(params) {
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:abstract\s+)?(?:native\s+)?(?:<[^>]+>\s+)?(?:\w+(?:<[^>]*>)?(?:\[\])*)\s+(\w+)\s*(\([^)]*\))\s*(?:throws\s+[^{]+)?\s*\{?/, kind: 'function', sigGroup: 2 },
    // public class ClassName {
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    // public interface InterfaceName {
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?interface\s+(\w+)/, kind: 'type' },
    // public enum EnumName {
    { pattern: /^(?:(?:public|private|protected)\s+)?enum\s+(\w+)/, kind: 'type' },
    // @interface AnnotationName {
    { pattern: /^(?:(?:public|private|protected)\s+)?@interface\s+(\w+)/, kind: 'type' },
    // public record RecordName(...)
    { pattern: /^(?:(?:public|private|protected)\s+)?record\s+(\w+)/, kind: 'class' },
    // public static final Type CONST_NAME = ...
    { pattern: /^(?:(?:public|private|protected)\s+)?static\s+final\s+\w+(?:<[^>]*>)?\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C ----
const C_CONFIG: LanguageConfig = {
  extensions: ['.c', '.h'],
  testPatterns: [/_test\.c$/, /test_.*\.c$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    // returnType funcName(params) { — top-level function
    // Capture: function name after the return type, parentheses
    { pattern: /^(?:static\s+)?(?:inline\s+)?(?:extern\s+)?(?:const\s+)?(?:unsigned\s+)?(?:signed\s+)?(?:long\s+)?(?:short\s+)?\w+[\s*]+(\w+)\s*(\([^)]*\))\s*\{/, kind: 'function', sigGroup: 2 },
    // typedef struct { ... } Name;
    { pattern: /^typedef\s+struct\s+(?:\w+\s*)?\{/, kind: 'class' },
    // struct Name {
    { pattern: /^(?:typedef\s+)?struct\s+(\w+)\s*\{?/, kind: 'class' },
    // enum Name {
    { pattern: /^(?:typedef\s+)?enum\s+(\w+)/, kind: 'type' },
    // typedef returnType (*Name)(params);
    { pattern: /^typedef\s+\w+[\s*]*\(\s*\*\s*(\w+)\s*\)/, kind: 'type' },
    // typedef ... Name;
    { pattern: /^typedef\s+.+\s+(\w+)\s*;/, kind: 'type' },
    // #define MACRO_NAME
    { pattern: /^#define\s+([A-Z][A-Z0-9_]+)/, kind: 'constant' },
    // const type CONST = ... / static const ...
    { pattern: /^(?:static\s+)?const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C++ ----
const CPP_CONFIG: LanguageConfig = {
  extensions: ['.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh'],
  testPatterns: [/_test\.cpp$/, /test_.*\.cpp$/, /_test\.cc$/, /Test\.cpp$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    // class ClassName { (C++ first — matched before functions)
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:\[\[.*?\]\]\s+)?(\w+)(?:\s*final)?\s*(?::\s*(?:public|private|protected)\s+[^{]+)?\s*\{/, kind: 'class' },
    // namespace Name {
    { pattern: /^namespace\s+(\w+)/, kind: 'module' },
    // ReturnType ClassName::methodName(params) { — this is a method, so handle separately
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:\w+[\s*&]+)?(\w+)::(\w+)\s*(\([^)]*\))/, kind: 'function', sigGroup: 3 },
    // returnType funcName(params) {
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:explicit\s+)?(?:constexpr\s+)?(?:const\s+)?(?:unsigned\s+)?\w+[\s*&]+(\w+)\s*(\([^)]*\))\s*(?:const)?\s*(?:override|final|noexcept)?\s*\{?/, kind: 'function', sigGroup: 2 },
    // enum class Name {
    { pattern: /^enum\s+(?:class\s+)?(\w+)/, kind: 'type' },
    // using Name = ...
    { pattern: /^using\s+(\w+)\s*=/, kind: 'type' },
    // typedef
    { pattern: /^typedef\s+.+\s+(\w+)\s*;/, kind: 'type' },
    // constexpr auto CONST = ...
    { pattern: /^(?:static\s+)?(?:inline\s+)?constexpr\s+\w+\s+([A-Z][A-Z0-9_]+)\s*[={]/, kind: 'constant' },
    { pattern: /^#define\s+([A-Z][A-Z0-9_]+)/, kind: 'constant' },
    { pattern: /^(?:static\s+)?const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C# ----
const CSHARP_CONFIG: LanguageConfig = {
  extensions: ['.cs'],
  testPatterns: [/Tests?\.cs$/, /\.test\.cs$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '///', '*', '/*'],
  patterns: [
    // public class ClassName
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:sealed\s+)?(?:abstract\s+)?(?:partial\s+)?class\s+(\w+)/, kind: 'class' },
    // public struct StructName
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:readonly\s+)?(?:ref\s+)?(?:partial\s+)?struct\s+(\w+)/, kind: 'class' },
    // public record RecordName
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:sealed\s+)?(?:abstract\s+)?record\s+(?:struct\s+|class\s+)?(\w+)/, kind: 'class' },
    // public interface IInterfaceName
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:partial\s+)?interface\s+(\w+)/, kind: 'type' },
    // public enum EnumName
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?enum\s+(\w+)/, kind: 'type' },
    // public delegate ReturnType DelegateName(params);
    { pattern: /^(?:(?:public|private|protected|internal)\s+)?delegate\s+\w+[\s<>[\],*]*\s+(\w+)\s*[(<]/, kind: 'type' },
    // public ReturnType MethodName(params) {
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:abstract\s+)?(?:async\s+)?(?:new\s+)?(?:\w+(?:<[^>]*>)?(?:\[\]|\?)?)\s+(\w+)\s*(<[^>]*>)?\s*(\([^)]*\))\s*(?:where\s+[^{]*)?\s*[{=>]/, kind: 'function', sigGroup: 3 },
    // public const Type CONST = ...
    { pattern: /^(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:readonly\s+)?const\s+\w+\s+(\w+)\s*=/, kind: 'constant' },
  ],
};

// ============ Language registry ============

const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
  typescript: TS_CONFIG,
  python: PY_CONFIG,
  go: GO_CONFIG,
  rust: RUST_CONFIG,
  java: JAVA_CONFIG,
  c: C_CONFIG,
  cpp: CPP_CONFIG,
  csharp: CSHARP_CONFIG,
};

// Extension -> language mapping
const EXT_TO_LANGUAGE: Record<string, Language> = {};
for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of config.extensions) {
    EXT_TO_LANGUAGE[ext] = lang as Language;
  }
}

// All supported extensions
const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANGUAGE));

function detectLanguage(ext: string): Language | null {
  return EXT_TO_LANGUAGE[ext] ?? null;
}

function isTestFile(filePath: string, language: Language): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (/(^|\/)(?:__tests__|tests?|spec)\//.test(normalized)) return true;

  const name = normalized.split('/').pop() ?? normalized;
  return LANGUAGE_CONFIGS[language].testPatterns.some(p => p.test(name) || p.test(normalized));
}

// ============ Extracted entity info ============

export interface ExtractedEntity {
  kind: EntityKind;
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  signature?: string;
  isExported: boolean;
  loc: number;
  nestingDepth: number;
  paramCount: number;
}

// ============ Entity extraction ============

/**
 * Extract entity declarations from source file content
 */
export function extractEntities(
  content: string,
  filePath: string,
  language: Language,
): ExtractedEntity[] {
  const lines = content.split('\n');
  const entities: ExtractedEntity[] = [];
  const config = LANGUAGE_CONFIGS[language];
  const seen = new Set<string>();
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed) continue;

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/', 2)) inBlockComment = true;
      continue;
    }

    // Skip comments
    if (config.commentPrefixes.some(p => trimmed.startsWith(p))) continue;

    for (const { pattern, kind, sigGroup } of config.patterns) {
      const match = trimmed.match(pattern);
      if (!match) continue;

      const name = match[1];
      if (!name) continue;
      if (/\b(?:declare|abstract)\b/.test(trimmed) && !trimmed.includes('{')) continue;

      const key = `${name}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Python: indented function = method -> skip
      if (language === 'python' && kind === 'function' && lines[i].match(/^\s+/)) continue;

      // TS: skip if a kind with skipIndented set is indented
      if (config.skipIndented?.includes(kind) && lines[i].match(/^\s{2,}/)) continue;

      const isExported = language === 'go'
        ? /^[A-Z]/.test(name)  // Go: starts with an uppercase letter = exported
        : trimmed.startsWith('export') || trimmed.startsWith('pub');

      const signature = sigGroup ? match[sigGroup]?.trim() : undefined;

      // Estimate block end
      let lineEnd: number | undefined;
      if (config.blockStyle === 'brace') {
        lineEnd = findBraceBlockEnd(lines, i);
      } else if (config.blockStyle === 'indent') {
        lineEnd = findIndentBlockEnd(lines, i);
      }

      // Compute complexity
      const complexity = (kind === 'function' || kind === 'class')
        ? computeBlockMetrics(lines, i, lineEnd)
        : { loc: 0, nestingDepth: 0, paramCount: 0 };

      entities.push({
        kind,
        name,
        filePath,
        lineStart: i + 1,
        lineEnd: lineEnd ? lineEnd + 1 : undefined,
        signature,
        isExported,
        loc: complexity.loc,
        nestingDepth: complexity.nestingDepth,
        paramCount: complexity.paramCount,
      });

      break;
    }
  }

  return entities;
}

// ============ Block end estimation ============

/** Brace counting (C-family, Go, Rust, Java, C#) */
function findBraceBlockEnd(lines: string[], startIdx: number): number | undefined {
  let depth = 0;
  let started = false;

  for (let i = startIdx; i < Math.min(startIdx + 500, lines.length); i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }
    if (started && depth <= 0) return i;
  }
  return undefined;
}

/** Indent-based (Python) */
function findIndentBlockEnd(lines: string[], startIdx: number): number | undefined {
  // Determine the indent level of the declaration line
  const startLine = lines[startIdx];
  const baseIndent = startLine.length - startLine.trimStart().length;

  for (let i = startIdx + 1; i < Math.min(startIdx + 500, lines.length); i++) {
    const line = lines[i];
    // Skip blank lines
    if (line.trim().length === 0) continue;
    const currentIndent = line.length - line.trimStart().length;
    // Block ends when the indent returns to the base level or below
    if (currentIndent <= baseIndent) return i - 1;
  }
  return undefined;
}

// ============ Complexity computation ============

function computeBlockMetrics(
  lines: string[], startIdx: number, endIdx: number | undefined,
): { loc: number; nestingDepth: number; paramCount: number } {
  const end = endIdx ?? Math.min(startIdx + 50, lines.length);
  const blockLines = lines.slice(startIdx, end + 1);
  const loc = blockLines.filter(l => l.trim().length > 0).length;

  let maxNesting = 0;
  let currentNesting = 0;
  for (const line of blockLines) {
    for (const ch of line) {
      if (ch === '{' || ch === '(') currentNesting++;
      if (ch === '}' || ch === ')') currentNesting--;
    }
    if (currentNesting > maxNesting) maxNesting = currentNesting;
  }

  const firstLine = blockLines[0] ?? '';
  const paramMatch = firstLine.match(/\(([^)]*)\)/);
  const paramCount = paramMatch
    ? paramMatch[1].split(',').filter(p => p.trim().length > 0).length
    : 0;

  return { loc, nestingDepth: maxNesting, paramCount };
}

function computeComplexityFromMetrics(
  loc: number, nestingDepth: number, paramCount: number,
): number {
  let score = 0;
  if (loc > 100) score += 3;
  else if (loc > 50) score += 2;
  else if (loc > 20) score += 1;

  if (nestingDepth > 6) score += 3;
  else if (nestingDepth > 4) score += 2;
  else if (nestingDepth > 2) score += 1;

  if (paramCount > 6) score += 2;
  else if (paramCount > 3) score += 1;

  return Math.min(score, 10);
}

function computeRisk(complexityScore: number, hasTests: boolean): RiskLevel {
  if (complexityScore >= 8) return 'high';
  if (complexityScore >= 6 && !hasTests) return 'high';
  if (complexityScore >= 6) return 'medium';
  if (complexityScore >= 4 && !hasTests) return 'medium';
  return 'low';
}

// ============ Test mapping ============

interface TestFileInfo {
  testFilePath: string;
  importedSymbols: Map<string, Set<string>>;
  referencedNames: Set<string>;
}

const TS_IMPORT_FROM = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

// import reserved words — test framework functions, etc.
const RESERVED_NAMES = new Set([
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'vi', 'jest', 'mock', 'fn', 'spyOn',
  'console', 'setTimeout', 'setInterval', 'Promise', 'Date',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set',
  'JSON', 'Math', 'Error', 'RegExp', 'require', 'import',
  'resolve', 'reject', 'then', 'catch', 'finally', 'push',
  'filter', 'map', 'reduce', 'forEach', 'find', 'includes',
  'join', 'split', 'trim', 'slice', 'splice', 'pop', 'shift',
  'assert', 'assertEqual', 'assertTrue', 'assertFalse', 'assertRaises', // Python
  'testing', 'Errorf', 'Fatalf', 'Run', 'Equal', 'NotNil', // Go
  'assert_eq', 'assert_ne', 'assert', 'panic', 'println', // Rust
  'assertEquals', 'assertNotNull', 'assertThrows', 'assertTrue', // Java
  'Assert', 'Fact', 'Theory', // C#
]);

function parseTestFile(content: string, testFilePath: string, language: Language): TestFileInfo {
  const importedSymbols = new Map<string, Set<string>>();
  const referencedNames = new Set<string>();

  // TS/JS: import { A, B } from './path'
  if (language === 'typescript') {
    TS_IMPORT_FROM.lastIndex = 0;
    let match;
    while ((match = TS_IMPORT_FROM.exec(content)) !== null) {
      const symbols = match[1].split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(s => s && !s.startsWith('type '));
      const importPath = match[2];
      if (importPath.startsWith('.')) {
        const resolved = resolveImportPath(testFilePath, importPath);
        if (resolved) {
          const existing = importedSymbols.get(resolved) ?? new Set();
          for (const s of symbols) existing.add(s);
          importedSymbols.set(resolved, existing);
        }
      }
    }
  }

  // Go: map by function call pattern (imports are per package, so symbol mapping is hard)
  // Java/C#: import/using is per class
  // Rust: use crate::module::Name

  // Generic: collect function call references in the code
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const calls = trimmed.matchAll(/\b([a-zA-Z_]\w+)\s*\(/g);
    for (const c of calls) {
      if (!RESERVED_NAMES.has(c[1])) referencedNames.add(c[1]);
    }
  }

  return { testFilePath, importedSymbols, referencedNames };
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  const dir = dirname(fromFile);
  const cleaned = importPath.replace(/\.[jt]sx?$/, '');
  const resolved = join(dir, cleaned).replace(/\\/g, '/');
  if (resolved.startsWith('..')) return null;
  return resolved.replace(/^\.\//, '');
}

function buildTestMap(
  entities: ExtractedEntity[],
  testFiles: TestFileInfo[],
): Map<string, { hasTests: boolean; testFile: string }> {
  const result = new Map<string, { hasTests: boolean; testFile: string }>();

  const entitiesByFile = new Map<string, ExtractedEntity[]>();
  const entityByName = new Map<string, ExtractedEntity[]>();

  for (const e of entities) {
    const list = entitiesByFile.get(e.filePath) ?? [];
    list.push(e);
    entitiesByFile.set(e.filePath, list);

    const nameList = entityByName.get(e.name) ?? [];
    nameList.push(e);
    entityByName.set(e.name, nameList);
  }

  for (const tf of testFiles) {
    // Import-based mapping (TS)
    for (const [sourcePath, symbols] of tf.importedSymbols) {
      const candidates = [
        sourcePath + '.ts', sourcePath + '.tsx', sourcePath + '.js',
        sourcePath + '/index.ts', sourcePath,
      ];
      for (const candidate of candidates) {
        const fileEntities = entitiesByFile.get(candidate);
        if (!fileEntities) continue;
        for (const entity of fileEntities) {
          if (symbols.has(entity.name)) {
            result.set(`${entity.filePath}::${entity.name}`, { hasTests: true, testFile: tf.testFilePath });
          }
        }
        break;
      }
    }

    // Reference-name based (generic)
    for (const refName of tf.referencedNames) {
      const matchingEntities = entityByName.get(refName);
      if (!matchingEntities) continue;
      for (const entity of matchingEntities) {
        const qName = `${entity.filePath}::${entity.name}`;
        if (result.has(qName)) continue;
        if (isNearbyTest(entity.filePath, tf.testFilePath)) {
          result.set(qName, { hasTests: true, testFile: tf.testFilePath });
        }
      }
    }
  }

  return result;
}

function isNearbyTest(sourceFile: string, testFile: string): boolean {
  const sourceDir = dirname(sourceFile);
  const testDir = dirname(testFile);
  const sourceBase = sourceFile.replace(/\.[^.]+$/, '');
  const testBase = testFile
    .replace(/\.test\.[^.]+$|\.spec\.[^.]+$/, '')
    .replace(/_test\.[^.]+$/, '')
    .replace(/Test\.[^.]+$/, '')
    .replace(/Tests\.[^.]+$/, '');

  // File name match (excluding extension) — also handles conventions like the Python test_ prefix
  const srcName = sourceBase.split('/').pop();
  const tstName = testBase.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/^test_/, '');
  if (srcName && tstName && srcName === tstName) return true;

  if (sourceDir === testDir) return true;
  if (testDir === `${sourceDir}/__tests__`) return true;
  if (testDir === `${sourceDir}/tests`) return true;
  if (testDir === `${sourceDir}/test`) return true;

  const sourceParent = dirname(sourceDir);
  if (testDir === `${sourceParent}/__tests__` || testDir === 'src/__tests__') return true;

  return false;
}

// ============ Scan results ============

export interface ScanResult {
  scanned: number;
  extracted: number;
  registered: number;
  updated: number;
  removed: number;
  testsMapped: number;
  incomplete: boolean;
  incompleteReasons: string[];
  errors: string[];
  durationMs: number;
  languageBreakdown: Record<string, number>;
}

// ============ Main scan function ============

export async function scanRepository(
  projectPath: string,
  projectId: string,
  options?: { maxDepth?: number; timeoutMs?: number; verbose?: boolean; allowNonRepo?: boolean },
): Promise<ScanResult> {
  // Guard: a scan launched from $HOME (or any non-git directory) walks the whole
  // home tree and floods the registry with junk buckets — measured 563k rows
  // under project_id 'unohee' (.atom compile caches etc.), ~90% of the DB.
  // Refuse unless explicitly opted in. (INT-2507)
  const resolvedScanPath = resolve(projectPath);
  if (!options?.allowNonRepo) {
    if (resolvedScanPath === homedir()) {
      throw new Error(`Refusing to scan the home directory (${resolvedScanPath}) — run from a project repo or pass allowNonRepo.`);
    }
    if (!existsSync(join(resolvedScanPath, '.git'))) {
      throw new Error(`Refusing to scan a non-git directory (${resolvedScanPath}) — it floods the registry with junk. Pass allowNonRepo to override.`);
    }
  }

  const startTime = Date.now();
  const { maxDepth, timeoutMs } = normalizeScanTraversalOptions(options);
  const verbose = options?.verbose ?? false;
  const store = getRegistryStore();

  const allExtracted: ExtractedEntity[] = [];
  const testFiles: TestFileInfo[] = [];
  const errors: string[] = [];
  const languageBreakdown: Record<string, number> = {};
  const scannedSourceFiles = new Set<string>();
  let scannedFiles = 0;
  const incompleteReasons: string[] = [];

  async function walk(dirPath: string, relPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      incompleteReasons.push(`${relPath || '.'}: depth limit ${maxDepth} reached`);
      return;
    }
    if (Date.now() - startTime > timeoutMs) {
      incompleteReasons.push(`${relPath || '.'}: scan timeout ${timeoutMs}ms reached`);
      return;
    }

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      errors.push(`${relPath || '.'}: ${err instanceof Error ? err.message : 'access denied'}`);
      if (verbose) console.log(`  [scan] skip dir ${relPath}: ${err instanceof Error ? err.message : 'access denied'}`);
      return;
    }

    for (const entry of entries) {
      if (Date.now() - startTime > timeoutMs) {
        incompleteReasons.push(`${relPath || '.'}: scan timeout ${timeoutMs}ms reached`);
        return;
      }

      const fullPath = join(dirPath, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_DIR_PREFIXES.some(p => entry.name.startsWith(p))) continue;
        await walk(fullPath, entryRelPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        const language = detectLanguage(ext);
        if (!language) continue;

        try {
          const content = await readBoundedRegularFile(fullPath);

          if (isTestFile(entryRelPath, language)) {
            testFiles.push(parseTestFile(content, entryRelPath, language));
          } else {
            scannedSourceFiles.add(entryRelPath);
            const entities = extractEntities(content, entryRelPath, language);
            allExtracted.push(...entities);
            scannedFiles++;
            languageBreakdown[language] = (languageBreakdown[language] ?? 0) + 1;

            if (verbose && entities.length > 0) {
              console.log(`  [scan] ${entryRelPath}: ${entities.length} entities (${language})`);
            }
          }
        } catch (err) {
          errors.push(`${entryRelPath}: ${err instanceof Error ? err.message : String(err)}`);
          if (err instanceof Error && err.message.startsWith('Source file exceeds')) {
            incompleteReasons.push(`${entryRelPath}: source file excluded by size limit`);
          }
        }
      }
    }
  }

  await walk(projectPath, '', 0);

  // Build the test mapping
  const testMap = buildTestMap(allExtracted, testFiles);
  if (verbose && testMap.size > 0) {
    console.log(`  [test-map] ${testMap.size} entities mapped to tests`);
  }

  // Registry sync — read existing rows as keyset pages of the light sync
  // projection (only the compared columns, no tags/warnings/links), capped at the
  // store's page limit, and index them straight into the lookup map instead of
  // first materialising every full CodeEntity.
  const existingByQName = new Map<string, EntitySyncRow>();
  const existingPageSize = LIST_ENTITIES_MAX_LIMIT;
  let afterId: string | undefined;
  for (;;) {
    const page = store.listEntitySyncPage(projectId, afterId, existingPageSize);
    for (const row of page) existingByQName.set(row.qualifiedName, row);
    const lastId = page.at(-1)?.id;
    // A short page ends the walk; a cursor that does not advance would loop forever.
    if (page.length < existingPageSize || lastId === undefined || lastId === afterId) break;
    afterId = lastId;
    await yieldToEventLoop();
  }
  const extractedQNames = new Set<string>();

  let registered = 0;
  let updated = 0;
  let testsMapped = 0;

  // Each slice is one transaction (one commit) followed by a turn for the event
  // loop. A transaction per entity cost an fsync each, and a loop that never
  // yielded held the daemon for as long as the scan wrote (AGT-4665).
  for (let sliceStart = 0; sliceStart < allExtracted.length; sliceStart += REGISTRY_WRITE_SLICE) {
    const slice = allExtracted.slice(sliceStart, sliceStart + REGISTRY_WRITE_SLICE);
    store.inTransaction(() => {
      for (const ext of slice) {
        const qualifiedName = `${ext.filePath}::${ext.name}`;
        extractedQNames.add(qualifiedName);

        const testInfo = testMap.get(qualifiedName);
        const hasTests = testInfo?.hasTests ?? false;
        const testFile = testInfo?.testFile;
        const score = computeComplexityFromMetrics(ext.loc, ext.nestingDepth, ext.paramCount);
        const riskLevel = computeRisk(score, hasTests);

        if (hasTests) testsMapped++;

        const existingEntity = existingByQName.get(qualifiedName);

        if (!existingEntity) {
          try {
            store.registerEntity({
              projectId,
              kind: ext.kind,
              name: ext.name,
              filePath: ext.filePath,
              lineStart: ext.lineStart,
              lineEnd: ext.lineEnd,
              signature: ext.signature,
              status: 'active',
              hasTests,
              testFile,
              complexityScore: score,
              riskLevel,
              author: 'scanner',
            });
            registered++;
          } catch (err) {
            errors.push(`register ${qualifiedName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const needsUpdate =
            existingEntity.lineStart !== ext.lineStart ||
            existingEntity.lineEnd !== ext.lineEnd ||
            existingEntity.signature !== ext.signature ||
            existingEntity.hasTests !== hasTests ||
            existingEntity.testFile !== testFile ||
            existingEntity.complexityScore !== score ||
            existingEntity.riskLevel !== riskLevel;

          if (needsUpdate) {
            store.updateEntity(existingEntity.id, {
              lineStart: ext.lineStart,
              lineEnd: ext.lineEnd,
              signature: ext.signature,
              hasTests,
              testFile,
              complexityScore: score,
              riskLevel,
            }, 'scanner');
            updated++;
          }
        }
      }
    });
    await yieldToEventLoop();
  }

  // Entities that disappeared -> broken
  let removed = 0;
  let pendingBroken: string[] = [];
  const flushBroken = async (): Promise<void> => {
    if (pendingBroken.length === 0) return;
    const ids = pendingBroken;
    pendingBroken = [];
    store.inTransaction(() => {
      for (const id of ids) store.changeEntityStatus(id, 'broken', 'scanner');
    });
    await yieldToEventLoop();
  };
  for (const [qName, entity] of existingByQName) {
    if (extractedQNames.has(qName) || entity.author !== 'scanner' || entity.status !== 'active') {
      continue;
    }

    const sourceFileScanned = scannedSourceFiles.has(entity.filePath);
    let sourceFileMissing = false;
    if (!sourceFileScanned) {
      try {
        await stat(join(projectPath, entity.filePath));
      } catch {
        sourceFileMissing = true;
      }
    }

    // Paths under SKIP_DIRS (e.g. worktree/) are intentionally not walked. If
    // they still exist on disk, the old "file exists ⇒ keep" rule left 100k+
    // stale active rows after we started skipping worktrees.
    const underSkippedDir = entity.filePath.split('/').some(
      (part) => SKIP_DIRS.has(part) || SKIP_DIR_PREFIXES.some((p) => part.startsWith(p)),
    );

    if (sourceFileScanned || sourceFileMissing || underSkippedDir) {
      pendingBroken.push(entity.id);
      removed++;
      if (pendingBroken.length >= REGISTRY_WRITE_SLICE) await flushBroken();
    }
  }
  await flushBroken();

  return {
    scanned: scannedFiles,
    extracted: allExtracted.length,
    registered,
    updated,
    removed,
    testsMapped,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons: Array.from(new Set(incompleteReasons)).slice(0, 50),
    errors,
    durationMs: Date.now() - startTime,
    languageBreakdown,
  };
}
