/** Agent-authored lessons stay here until the run has earned promotion. (AGT-4461) */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureScratchpad, scratchpadDir, ScratchpadBudgetError } from '../support/scratchpad.js';

const FILE = 'remember.json';
export const STAGED_MEMORY_BYTE_CAP = 32 * 1024;
export const STAGED_MEMORY_ENTRY_BYTE_CAP = 4 * 1024;
export type RememberKind = 'pattern' | 'constraint';
export interface StagedMemory { kind: RememberKind; title: string; content: string; taskId: string; iteration: number; }

function pathFor(runId: string): string { return join(scratchpadDir(runId), FILE); }
export async function readStagedMemories(runId: string): Promise<StagedMemory[]> {
  try { const value: unknown = JSON.parse(await readFile(pathFor(runId), 'utf8')); return Array.isArray(value) ? value.filter(valid) : []; } catch { return []; }
}
function valid(value: unknown): value is StagedMemory {
  const v = value as Partial<StagedMemory>;
  return !!v && (v.kind === 'pattern' || v.kind === 'constraint') && typeof v.title === 'string' && typeof v.content === 'string' && typeof v.taskId === 'string' && Number.isInteger(v.iteration);
}
async function write(runId: string, entries: StagedMemory[]): Promise<void> {
  const body = JSON.stringify(entries);
  if (Buffer.byteLength(body) > STAGED_MEMORY_BYTE_CAP) throw new ScratchpadBudgetError(`remember entries would exceed the ${STAGED_MEMORY_BYTE_CAP}-byte run limit. Nothing was written.`);
  await ensureScratchpad(runId);
  const target = pathFor(runId); const tmp = `${target}.writing`;
  await writeFile(tmp, body, 'utf8'); await rename(tmp, target);
}
export async function stageMemory(runId: string, entry: StagedMemory): Promise<void> {
  if (Buffer.byteLength(entry.title + entry.content) > STAGED_MEMORY_ENTRY_BYTE_CAP) throw new ScratchpadBudgetError(`remember entry exceeds the ${STAGED_MEMORY_ENTRY_BYTE_CAP}-byte limit. Nothing was written.`);
  await write(runId, [...await readStagedMemories(runId), entry]);
}
/** A rollback restores the worktree boundary and forgets lessons produced after it. */
export async function discardStagedMemoriesFrom(runId: string, iteration: number): Promise<void> {
  const entries = await readStagedMemories(runId);
  const kept = entries.filter((entry) => entry.iteration < iteration);
  if (kept.length !== entries.length) await write(runId, kept);
}
