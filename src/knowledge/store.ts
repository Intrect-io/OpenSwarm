// ============================================
// OpenSwarm - Knowledge Graph Store
// JSON 영속화 (load/save/list)
// ============================================

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { KnowledgeGraph } from './graph.js';
import { SerializedGraphSchema } from './types.js';
import type { SerializedGraph } from './types.js';

// ============================================
// Constants
// ============================================

const STORE_DIR = join(homedir(), '.openswarm', 'knowledge-graph');

// ============================================
// Store Operations
// ============================================

/**
 * 그래프를 JSON 파일로 저장
 */
export async function saveGraph(graph: KnowledgeGraph): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  const filePath = join(STORE_DIR, `${graph.projectSlug}.json`);
  const serialized = graph.serialize();
  await writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8');
  console.log(`[KnowledgeStore] Saved graph: ${graph.projectSlug} (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
}

/**
 * JSON 파일에서 그래프 로드
 */
export async function loadGraph(projectSlug: string): Promise<KnowledgeGraph | null> {
  const filePath = join(STORE_DIR, `${projectSlug}.json`);
  try {
    const content = await readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);
    const parsed = SerializedGraphSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[KnowledgeStore] Invalid graph data for ${projectSlug}:`, parsed.error.message);
      return null;
    }
    return KnowledgeGraph.deserialize(parsed.data);
  } catch {
    return null;
  }
}

/**
 * 저장된 모든 프로젝트 슬러그 목록
 */
export async function listGraphs(): Promise<string[]> {
  try {
    await mkdir(STORE_DIR, { recursive: true });
    const files = await readdir(STORE_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * 그래프 삭제
 */
export async function deleteGraph(projectSlug: string): Promise<void> {
  const filePath = join(STORE_DIR, `${projectSlug}.json`);
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
    console.log(`[KnowledgeStore] Deleted graph: ${projectSlug}`);
  } catch {
    // 이미 없으면 무시
  }
}

/**
 * 그래프 요약 정보 로드 (전체 deserialize 없이)
 */
export async function loadGraphSummary(projectSlug: string): Promise<SerializedGraph | null> {
  const filePath = join(STORE_DIR, `${projectSlug}.json`);
  try {
    const content = await readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);
    const parsed = SerializedGraphSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
