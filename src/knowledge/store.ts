// ============================================
// OpenSwarm - Knowledge Graph Store
// JSON persistence (load/save/list)
// ============================================

import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { KnowledgeGraph } from './graph.js';
import { SerializedGraphSchema } from './types.js';
import type { SerializedGraph } from './types.js';
import { atomicWriteFile } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';

// Constants

const STORE_DIR = join(homedir(), '.openswarm', 'knowledge-graph');

// Resolve `<STORE_DIR>/<slug>.json`, rejecting anything that escapes STORE_DIR.
// Protects against traversal even if a caller forgets to sanitize projectSlug.
function resolveGraphPath(projectSlug: string): string {
  const candidate = resolve(STORE_DIR, `${projectSlug}.json`);
  const prefix = STORE_DIR.endsWith(sep) ? STORE_DIR : STORE_DIR + sep;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`Invalid projectSlug: ${projectSlug}`);
  }
  return candidate;
}

// Store Operations

/**
 * Save graph to JSON file
 */
export async function saveGraph(graph: KnowledgeGraph): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  const filePath = resolveGraphPath(graph.projectSlug);
  const serialized = graph.serialize();
  await atomicWriteFile(filePath, JSON.stringify(serialized, null, 2), 0o600);
  console.log(`[KnowledgeStore] Saved graph: ${graph.projectSlug} (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
}

/**
 * Load graph from JSON file
 */
export async function loadGraph(projectSlug: string): Promise<KnowledgeGraph | null> {
  let filePath: string;
  try {
    filePath = resolveGraphPath(projectSlug);
  } catch {
    return null;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);
    const parsed = SerializedGraphSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[KnowledgeStore] Invalid graph data for %s:', projectSlug, parsed.error.message);
      return null;
    }
    return KnowledgeGraph.deserialize(parsed.data);
  } catch {
    return null;
  }
}

/**
 * List all saved project slugs
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
 * Delete graph
 */
export async function deleteGraph(projectSlug: string): Promise<void> {
  let filePath: string;
  try {
    filePath = resolveGraphPath(projectSlug);
  } catch {
    return;
  }
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
    console.log(`[KnowledgeStore] Deleted graph: ${projectSlug}`);
  } catch {
    // Ignore if already deleted
  }
}

/**
 * Load graph summary info (without full deserialization)
 */
export async function loadGraphSummary(projectSlug: string): Promise<SerializedGraph | null> {
  let filePath: string;
  try {
    filePath = resolveGraphPath(projectSlug);
  } catch {
    return null;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);
    const parsed = SerializedGraphSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
