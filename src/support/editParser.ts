// ============================================
// OpenSwarm - Edit Parser
// Aider-style SEARCH/REPLACE block parsing
// ============================================

/**
 * File-edit format handed to a worker, matched to model capability (INT-1676).
 * - 'json'          : structured edit_file / apply_patch tool calls — frontier models.
 * - 'search-replace': Aider-style SEARCH/REPLACE blocks in the response text —
 *   far higher edit success on weaker/untrained models.
 * - 'whole-file'    : rewrite the whole file via write_file — weakest fallback.
 */
export type EditFormat = 'json' | 'search-replace' | 'whole-file';

/**
 * Pick an edit format by model capability (INT-1676). The structured JSON
 * edit_file / apply_patch tools are the format frontier models are trained on,
 * but weaker/untrained models botch them — Aider measured the SAME GPT-4-Turbo
 * jump from 20% (JSON) to 61% (diff blocks). We route per ADAPTER, the same
 * granularity the rest of the harness uses (getDefaultAdapterName, DRAFT_MODELS):
 * the in-process small/non-frontier adapters (local/lmstudio, OpenRouter pool)
 * get SEARCH/REPLACE; the capable paths (claude/codex/gpt) keep JSON.
 *
 * Rollback levers (issue requirement): an explicit `editFormat` on the call wins,
 * and `OPENSWARM_EDIT_FORMAT` forces a format globally if a model regresses.
 */
export function resolveEditFormat(adapterName: string | undefined): EditFormat {
  const env = process.env.OPENSWARM_EDIT_FORMAT;
  if (env === 'json' || env === 'search-replace' || env === 'whole-file') return env;

  switch (adapterName) {
    case 'local':
    case 'lmstudio':
    case 'openrouter':
      return 'search-replace';
    default:
      // claude / codex / codex-responses / gpt — capable with the JSON tools.
      return 'json';
  }
}

export interface EditBlock {
  filePath: string;
  search: string;
  replace: string;
  isNewFile?: boolean;
}

export interface ParseResult {
  success: boolean;
  blocks: EditBlock[];
  errors: string[];
}

// SEARCH/REPLACE markers
const HEAD = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const UPDATED = '>>>>>>> REPLACE';

/**
 * Extract SEARCH/REPLACE blocks from LLM output
 */
export function parseSearchReplaceBlocks(content: string): ParseResult {
  const blocks: EditBlock[] = [];
  const errors: string[] = [];

  // Extract code blocks (wrapped in ```)
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const blockContent = match[1];

    // Check for SEARCH/REPLACE pattern
    if (!blockContent.includes(HEAD)) {
      continue;
    }

    try {
      const parsed = parseBlock(blockContent, content, match.index);
      if (parsed) {
        blocks.push(parsed);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Also handle direct SEARCH/REPLACE usage without code blocks
  if (blocks.length === 0 && content.includes(HEAD)) {
    try {
      const directBlocks = parseDirectBlocks(content);
      blocks.push(...directBlocks);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    success: blocks.length > 0,
    blocks,
    errors,
  };
}

/**
 * Parse single code block
 */
function parseBlock(blockContent: string, fullContent: string, blockStart: number): EditBlock | null {
  const lines = blockContent.split('\n');

  let headIndex = -1;
  let dividerIndex = -1;
  let updatedIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === HEAD) headIndex = i;
    if (line === DIVIDER && headIndex !== -1) dividerIndex = i;
    if (line === UPDATED && dividerIndex !== -1) updatedIndex = i;
  }

  if (headIndex === -1 || dividerIndex === -1 || updatedIndex === -1) {
    return null;
  }

  // Extract SEARCH content
  const searchLines = lines.slice(headIndex + 1, dividerIndex);
  const search = searchLines.join('\n');

  // Extract REPLACE content
  const replaceLines = lines.slice(dividerIndex + 1, updatedIndex);
  const replace = replaceLines.join('\n');

  // Extract file path (from 1-3 lines before block)
  const filePath = extractFilePath(fullContent, blockStart);

  if (!filePath) {
    throw new Error('Could not determine file path for edit block');
  }

  return {
    filePath,
    search,
    replace,
    isNewFile: search.trim() === '',
  };
}

/**
 * Parse direct SEARCH/REPLACE blocks (without code blocks)
 */
function parseDirectBlocks(content: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === HEAD) {
      // Find file path (check preceding 3 lines)
      let filePath = '';
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const candidate = extractFilePathFromLine(lines[j]);
        if (candidate) {
          filePath = candidate;
          break;
        }
      }

      // Collect SEARCH content
      const searchLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== DIVIDER) {
        searchLines.push(lines[i]);
        i++;
      }

      // Collect REPLACE content
      const replaceLines: string[] = [];
      i++; // skip DIVIDER
      while (i < lines.length && lines[i].trim() !== UPDATED) {
        replaceLines.push(lines[i]);
        i++;
      }

      if (filePath) {
        blocks.push({
          filePath,
          search: searchLines.join('\n'),
          replace: replaceLines.join('\n'),
          isNewFile: searchLines.join('').trim() === '',
        });
      }
    }

    i++;
  }

  return blocks;
}

/**
 * Extract file path from before the block
 */
function extractFilePath(content: string, blockStart: number): string {
  // Text before block start
  const before = content.slice(Math.max(0, blockStart - 500), blockStart);
  const lines = before.split('\n').slice(-5); // Last 5 lines

  // Search for file path from the end
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = extractFilePathFromLine(lines[i]);
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

/**
 * Extract file path from a single line
 */
function extractFilePathFromLine(line: string): string {
  // Exclude empty lines and marker lines
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#')) {
    return '';
  }

  // File path pattern matching
  // e.g.: "src/worker.ts", "path/to/file.py:", "`file.js`"
  const patterns = [
    /^([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):?$/,           // simple path
    /^`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`:?$/,         // backtick wrapped
    /^\*\*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\*\*:?$/,   // bold wrapped
    /^File:\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i,     // File: prefix
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // String that looks like a path (contains slash, has extension)
  if (/^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(trimmed)) {
    return trimmed;
  }

  return '';
}

/**
 * Find SEARCH text using fuzzy matching
 * Simplified version of Aider's SequenceMatcher approach
 */
export function fuzzyMatch(
  fileContent: string,
  searchText: string,
  threshold: number = 0.8
): { found: boolean; start: number; end: number; similarity: number } {
  // Try exact match first
  const exactIndex = fileContent.indexOf(searchText);
  if (exactIndex !== -1) {
    return {
      found: true,
      start: exactIndex,
      end: exactIndex + searchText.length,
      similarity: 1.0,
    };
  }

  // Match after whitespace normalization
  const normalizedSearch = normalizeWhitespace(searchText);
  const normalizedContent = normalizeWhitespaceWithMap(fileContent);

  const normalizedIndex = normalizedSearch.length > 0
    ? normalizedContent.text.indexOf(normalizedSearch)
    : -1;
  if (normalizedIndex !== -1) {
    const normalizedEnd = normalizedIndex + normalizedSearch.length;
    const start = normalizedContent.offsets[normalizedIndex];
    const end = normalizedContent.offsets[normalizedEnd - 1] + 1;

    return {
      found: true,
      start,
      end,
      similarity: 0.95,
    };
  }

  // Line-by-line fuzzy matching
  const searchLines = searchText.split('\n');
  const contentLines = fileContent.split('\n');

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const candidate = contentLines.slice(i, i + searchLines.length);
    const similarity = calculateSimilarity(searchLines, candidate);

    if (similarity >= threshold) {
      const start = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      const end = start + candidate.join('\n').length;

      return { found: true, start, end, similarity };
    }
  }

  return { found: false, start: -1, end: -1, similarity: 0 };
}

/**
 * Normalize whitespace
 */
function normalizeWhitespace(text: string): string {
  return normalizeWhitespaceWithMap(text).text;
}

function normalizeWhitespaceWithMap(text: string): { text: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  const lines = text.split('\n');
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0) {
      chars.push('\n');
      offsets.push(lineStart - 1);
    }

    const trimmedStart = line.length - line.trimStart().length;
    for (let j = trimmedStart; j < line.length; j++) {
      chars.push(line[j]);
      offsets.push(lineStart + j);
    }
    lineStart += line.length + 1;
  }

  const normalized: string[] = [];
  const normalizedOffsets: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (!inWhitespace) {
        normalized.push(' ');
        normalizedOffsets.push(offsets[i]);
      }
      inWhitespace = true;
      continue;
    }

    normalized.push(chars[i]);
    normalizedOffsets.push(offsets[i]);
    inWhitespace = false;
  }

  return { text: normalized.join(''), offsets: normalizedOffsets };
}

/**
 * Calculate similarity between line arrays
 */
function calculateSimilarity(a: string[], b: string[]): number {
  if (a.length !== b.length) return 0;

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const simA = a[i].trim();
    const simB = b[i].trim();

    if (simA === simB) {
      matches++;
    } else {
      // Partial similarity
      const longer = Math.max(simA.length, simB.length);
      if (longer === 0) {
        matches++;
      } else {
        const distance = levenshteinDistance(simA, simB);
        const lineSim = 1 - (distance / longer);
        matches += lineSim;
      }
    }
  }

  return matches / a.length;
}

/**
 * Calculate Levenshtein distance
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Apply edit block
 */
export async function applyEditBlock(
  block: EditBlock,
  projectPath: string
): Promise<{ success: boolean; error?: string }> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const filePath = path.isAbsolute(block.filePath)
    ? block.filePath
    : path.join(projectPath, block.filePath);

  try {
    if (block.isNewFile) {
      // An empty SEARCH creates a file. On a file that already exists it would
      // replace the whole thing — the #501 rewrite path — so it is refused
      // there (AGT-4406). A created file ends with a newline like any other.
      const exists = await fs.access(filePath).then(() => true, () => false);
      if (exists) {
        return {
          success: false,
          error: `${block.filePath} already exists — an empty SEARCH only creates files. Copy the exact text to replace into SEARCH.`,
        };
      }
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const created = block.replace.length > 0 && !block.replace.endsWith('\n') ? `${block.replace}\n` : block.replace;
      await fs.writeFile(filePath, created);
      return { success: true };
    }

    // Modify existing file
    const content = await fs.readFile(filePath, 'utf-8');

    // Find position using fuzzy matching
    const match = fuzzyMatch(content, block.search);

    if (!match.found) {
      return {
        success: false,
        error: `Could not find search text in ${block.filePath}`,
      };
    }

    // Apply replacement
    const newContent =
      content.slice(0, match.start) +
      block.replace +
      content.slice(match.end);

    await fs.writeFile(filePath, newContent);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format description for Worker prompts
 */
export const SEARCH_REPLACE_PROMPT = `
## Code Edit Format (SEARCH/REPLACE)

Use the following format for all code changes:

filepath
\`\`\`language
<<<<<<< SEARCH
existing code (copied exactly from file)
=======
new code
>>>>>>> REPLACE
\`\`\`

Example:
src/utils.ts
\`\`\`typescript
<<<<<<< SEARCH
function oldName() {
  return "old";
}
=======
function newName() {
  return "new";
}
>>>>>>> REPLACE
\`\`\`

Rules:
- SEARCH section must exactly match existing code in the file
- When modifying multiple files, use separate blocks for each
- Leave SEARCH section empty when creating a new file
`;

/**
 * System-prompt injection for whole-file rewrite mode (editFormat === 'whole-file').
 * edit_file / apply_patch are hidden; the model must rewrite entire files.
 */
export const WHOLE_FILE_PROMPT = `
## Code Edit Format (Whole-File Rewrite)

When you must change a file, rewrite it IN FULL with the \`write_file\` tool.
The \`edit_file\` and \`apply_patch\` tools are not available in this mode.

Steps:
1. Read the current file with \`read_file\`.
2. Produce the complete new contents.
3. Write them with \`write_file\` (the whole file, not a fragment).

Only rewrite files you actually need to change; leave the rest untouched.
`;
