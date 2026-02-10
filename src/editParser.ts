// ============================================
// Claude Swarm - Edit Parser
// Aider 스타일 SEARCH/REPLACE 블록 파싱
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

// SEARCH/REPLACE 마커
const HEAD = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const UPDATED = '>>>>>>> REPLACE';

/**
 * LLM 출력에서 SEARCH/REPLACE 블록 추출
 */
export function parseSearchReplaceBlocks(content: string): ParseResult {
  const blocks: EditBlock[] = [];
  const errors: string[] = [];

  // 코드 블록 추출 (```로 감싸진 부분)
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const blockContent = match[1];

    // SEARCH/REPLACE 패턴 확인
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

  // 코드 블록 없이 직접 SEARCH/REPLACE 사용한 경우도 처리
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
 * 단일 코드 블록 파싱
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

  // SEARCH 내용 추출
  const searchLines = lines.slice(headIndex + 1, dividerIndex);
  const search = searchLines.join('\n');

  // REPLACE 내용 추출
  const replaceLines = lines.slice(dividerIndex + 1, updatedIndex);
  const replace = replaceLines.join('\n');

  // 파일 경로 추출 (블록 앞 1-3줄에서)
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
 * 직접 SEARCH/REPLACE 블록 파싱 (코드 블록 없이)
 */
function parseDirectBlocks(content: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === HEAD) {
      // 파일 경로 찾기 (앞 3줄 검사)
      let filePath = '';
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const candidate = extractFilePathFromLine(lines[j]);
        if (candidate) {
          filePath = candidate;
          break;
        }
      }

      // SEARCH 내용 수집
      const searchLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== DIVIDER) {
        searchLines.push(lines[i]);
        i++;
      }

      // REPLACE 내용 수집
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
 * 블록 앞에서 파일 경로 추출
 */
function extractFilePath(content: string, blockStart: number): string {
  // 블록 시작 전 텍스트
  const before = content.slice(Math.max(0, blockStart - 500), blockStart);
  const lines = before.split('\n').slice(-5); // 마지막 5줄

  // 뒤에서부터 파일 경로 찾기
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = extractFilePathFromLine(lines[i]);
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

/**
 * 한 줄에서 파일 경로 추출
 */
function extractFilePathFromLine(line: string): string {
  // 빈 줄이나 마커 줄 제외
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#')) {
    return '';
  }

  // 파일 경로 패턴 매칭
  // 예: "src/worker.ts", "path/to/file.py:", "`file.js`"
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

  // 경로처럼 보이는 문자열 (슬래시 포함, 확장자 있음)
  if (/^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(trimmed)) {
    return trimmed;
  }

  return '';
}

/**
 * 퍼지 매칭으로 SEARCH 텍스트 찾기
 * Aider의 SequenceMatcher 방식 간소화 버전
 */
export function fuzzyMatch(
  fileContent: string,
  searchText: string,
  threshold: number = 0.8
): { found: boolean; start: number; end: number; similarity: number } {
  // 정확한 매칭 먼저 시도
  const exactIndex = fileContent.indexOf(searchText);
  if (exactIndex !== -1) {
    return {
      found: true,
      start: exactIndex,
      end: exactIndex + searchText.length,
      similarity: 1.0,
    };
  }

  // 공백 정규화 후 매칭
  const normalizedSearch = normalizeWhitespace(searchText);
  const normalizedContent = normalizeWhitespace(fileContent);

  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    // 원본에서 위치 찾기 (근사치)
    const ratio = normalizedIndex / normalizedContent.length;
    const approxStart = Math.floor(ratio * fileContent.length);

    return {
      found: true,
      start: approxStart,
      end: approxStart + searchText.length,
      similarity: 0.95,
    };
  }

  // 라인 단위 퍼지 매칭
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
 * 공백 정규화
 */
function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.trimStart())
    .join('\n')
    .replace(/\s+/g, ' ');
}

/**
 * 라인 배열 유사도 계산
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
      // 부분 유사도
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
 * Levenshtein 거리 계산
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
 * Edit 블록 적용
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
      // 새 파일 생성
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, block.replace);
      return { success: true };
    }

    // 기존 파일 수정
    const content = await fs.readFile(filePath, 'utf-8');

    // 퍼지 매칭으로 위치 찾기
    const match = fuzzyMatch(content, block.search);

    if (!match.found) {
      return {
        success: false,
        error: `Could not find search text in ${block.filePath}`,
      };
    }

    // 교체 적용
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
 * Worker 프롬프트용 형식 설명
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
