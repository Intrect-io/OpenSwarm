import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './atomicFile.js';

export type ReasoningEffortOverride = 'low' | 'medium' | 'high';

const OVERRIDE_FILE = join(homedir(), '.openswarm', 'reasoning-effort.json');
const VALID_EFFORTS = new Set<ReasoningEffortOverride>(['low', 'medium', 'high']);

export function readReasoningEffortOverride(path = OVERRIDE_FILE): ReasoningEffortOverride | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { effort?: unknown }).effort;
    return typeof value === 'string' && VALID_EFFORTS.has(value as ReasoningEffortOverride)
      ? value as ReasoningEffortOverride
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeReasoningEffortOverride(
  effort: ReasoningEffortOverride | undefined,
  path = OVERRIDE_FILE,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify({ effort: effort ?? null }, null, 2) + '\n', 0o600);
}

/** Supervisor override wins over task/profile defaults while it is enabled. */
export function applyReasoningEffortOverride<T extends object>(
  options: T,
  path = OVERRIDE_FILE,
): T & { reasoningEffort?: ReasoningEffortOverride } {
  const effort = readReasoningEffortOverride(path);
  return effort ? { ...options, reasoningEffort: effort } : options;
}
