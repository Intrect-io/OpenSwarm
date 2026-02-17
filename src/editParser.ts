// ============================================
// Claude Swarm - Edit Parser
// Aider-style SEARCH/REPLACE block parsing
// ============================================

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
  const normalizedContent = normalizeWhitespace(fileContent);

  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    // Find position in original (approximate)
    const ratio = normalizedIndex / normalizedContent.length;
    const approxStart = Math.floor(ratio * fileContent.length);

    return {
      found: true,
      start: approxStart,
      end: approxStart + searchText.length,
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
  return text
    .split('\n')
    .map(line => line.trimStart())
    .join('\n')
    .replace(/\s+/g, ' ');
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
      // Create new file
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, block.replace);
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
## 코드 편집 형식 (SEARCH/REPLACE)

모든 코드 변경은 다음 형식을 사용하라:

파일경로
\`\`\`언어
<<<<<<< SEARCH
기존 코드 (파일에서 정확히 복사)
=======
새 코드
>>>>>>> REPLACE
\`\`\`

예시:
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

규칙:
- SEARCH 부분은 파일의 기존 코드와 정확히 일치해야 함
- 여러 파일을 수정할 때는 각각 별도의 블록으로 작성
- 새 파일 생성 시 SEARCH 부분을 비워둠
`;
