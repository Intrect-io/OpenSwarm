// ============================================
// OpenSwarm - CLI Stream Parser
// Claude CLI --output-format stream-json 파싱 유틸
// ============================================

/**
 * Claude CLI --output-format stream-json stdout에서 assistant text만 추출하여 onLog 호출.
 * stream-json은 NDJSON (줄 단위 JSON 객체) 형태로 스트리밍된다.
 *
 * 청크 경계가 줄 중간에 걸릴 수 있으므로, 불완전한 마지막 줄은 반환하여
 * 다음 청크에서 이어 붙일 수 있도록 한다.
 */
export function parseCliStreamChunk(
  text: string,
  onLog: (line: string) => void,
  buffer: string = '',
): string {
  const combined = buffer + text;
  const lines = combined.split('\n');
  // 마지막 줄은 불완전할 수 있으므로 보존
  const remainder = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processNdjsonLine(trimmed, onLog);
  }

  return remainder;
}

/**
 * NDJSON 한 줄 파싱하여 assistant text 추출.
 * 줄 간 구분을 위해 빈 줄(spacer)과 단락 마커를 삽입한다.
 */
function processNdjsonLine(line: string, onLog: (text: string) => void): void {
  try {
    const event = JSON.parse(line);

    // assistant 메시지에서 text 블록 추출
    if (event.type === 'assistant' && event.message?.content) {
      // 새 assistant turn 시작 — 구분선
      onLog('───');

      for (const block of event.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          emitFormattedText(block.text, onLog);
        }
        // tool_use 블록은 간략 표시
        if (block.type === 'tool_use' && block.name) {
          const input = summarizeToolInput(block.name, block.input);
          onLog(`▸ ${block.name}${input ? '  ' + input : ''}`);
        }
      }
    }
  } catch {
    // 유효하지 않은 JSON (partial chunk) — 무시
  }
}

/**
 * assistant text를 가독성 있게 포매팅하여 onLog에 전달.
 * - 빈 줄은 spacer로 변환 (단락 구분)
 * - 마크다운 헤더(##)는 강조 마커 추가
 * - 코드블록(```)은 시작/끝 표시
 * - 긴 줄은 300자에서 자름
 */
function emitFormattedText(text: string, onLog: (line: string) => void): void {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let prevWasEmpty = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    // 코드블록 토글
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      onLog(inCodeBlock ? '┌─ code ─' : '└────────');
      prevWasEmpty = false;
      continue;
    }

    // 빈 줄 → 단락 구분 (연속 빈 줄 방지)
    if (!trimmed) {
      if (!prevWasEmpty) {
        onLog('');
        prevWasEmpty = true;
      }
      continue;
    }
    prevWasEmpty = false;

    // 코드블록 내부는 그대로
    if (inCodeBlock) {
      onLog('│ ' + truncate(raw, 300));
      continue;
    }

    // 마크다운 헤더
    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      onLog('');
      onLog('■ ' + headerMatch[2]);
      continue;
    }

    // 리스트 아이템 (-, *, 1.)
    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      onLog('  ' + truncate(trimmed, 300));
      continue;
    }

    // 일반 텍스트
    onLog(truncate(trimmed, 300));
  }
}

/**
 * tool_use input 요약
 */
function summarizeToolInput(name: string, input: any): string {
  if (!input) return '';
  // 파일 관련 도구: 경로만 표시
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.command) return truncate(input.command, 80);
  if (input.pattern) return `"${truncate(input.pattern, 60)}"`;
  if (input.query) return `"${truncate(input.query, 60)}"`;
  // 나머지: 키만 표시
  const keys = Object.keys(input);
  if (keys.length <= 3) return keys.join(', ');
  return keys.slice(0, 3).join(', ') + '...';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * NDJSON 전체 stdout에서 result 항목의 result text 추출 (최종 파싱용).
 * parseWorkerOutput 등에서 사용.
 */
export function extractResultFromStreamJson(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'result' && event.result) {
        return event.result;
      }
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * 하위 호환: parseCliOutput (buffer 없는 단순 버전)
 */
export function parseCliOutput(text: string, onLog: (line: string) => void): void {
  parseCliStreamChunk(text, onLog);
}
