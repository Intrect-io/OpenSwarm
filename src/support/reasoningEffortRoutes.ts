import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './httpBody.js';
import {
  readReasoningEffortOverride,
  writeReasoningEffortOverride,
  type ReasoningEffortOverride,
} from './reasoningEffortOverride.js';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function tryHandleReasoningEffortRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  onChanged: (effort: ReasoningEffortOverride | undefined) => void,
): Promise<boolean> {
  if (url !== '/api/reasoning-effort') return false;

  if (req.method === 'GET') {
    writeJson(res, 200, { effort: readReasoningEffortOverride() ?? null });
    return true;
  }
  if (req.method !== 'POST') return false;

  try {
    const parsed = JSON.parse(await readBody(req)) as { effort?: unknown };
    const effort = parsed.effort;
    if (effort !== null && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
      writeJson(res, 400, { error: 'effort must be null, low, medium, or high' });
      return true;
    }
    const normalized = (effort ?? undefined) as ReasoningEffortOverride | undefined;
    writeReasoningEffortOverride(normalized);
    onChanged(normalized);
    writeJson(res, 200, { ok: true, effort: effort ?? null });
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON' });
  }
  return true;
}
