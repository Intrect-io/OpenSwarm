import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { recoveryText } from './loopRecoveryEvidence.js';

/** 도구를 허용하지 않고 원래 diff의 저장소 내부 소스만 진단 패킷에 제공한다. */
export async function premiseSources(cwd: string, files: string[]): Promise<Record<string, string>> {
  const root = await realpath(cwd);
  const evidence: Record<string, string> = {};
  const unique = [...new Set(files)];
  if (unique.length > 6) evidence['truncated:file-list'] = `${unique.length - 6} files were omitted; missing context requires unknown`;
  for (const file of unique.slice(0, 6)) {
    try {
      const path = await realpath(resolve(root, file));
      const rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel) || (await stat(path)).size > 64_000) {
        evidence[`unavailable:${file}`] = 'Source is outside the bounded repository read scope; missing context requires unknown';
        continue;
      }
      const text = await readFile(path, 'utf8');
      // 일부 코드만 보았다는 사실을 유지한다. 긴 파일에서 임의의 결론을 내릴 수 없다.
      for (let offset = 0; offset < Math.min(text.length, 2000); offset += 400) {
        evidence[`source:${rel}:${offset}`] = recoveryText(text.slice(offset, offset + 400));
      }
      if (text.length > 2000) evidence[`truncated:${rel}`] = 'Only the first 2000 characters were supplied; missing context requires unknown';
    } catch (error) {
      evidence[`unavailable:${file}`] = recoveryText(error instanceof Error ? error.message : String(error));
    }
  }
  return evidence;
}
