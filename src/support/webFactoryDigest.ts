// Dashboard route for the daily factory digest (AGT-4810):
//   GET /api/factory/digest -> { digest, text }
// Split out of web.ts, which sits at the repo's per-file line cap. Reads the
// automation database read-only; the daemon stays its only writer.
import type { ServerResponse } from 'node:http';
import { defaultAutomationDbPath } from '../automation/automationDbPath.js';
import { formatFactoryDigest, readFactoryDigest } from '../automation/factoryDigest.js';
import { safeErrorMessage } from './webServiceControl.js';

/** Returns false when the route is not this one, so the caller's router keeps looking. */
export function handleFactoryDigest(url: string, method: string | undefined, res: ServerResponse, dbPath = defaultAutomationDbPath()): boolean {
  if (url !== '/api/factory/digest' || method !== 'GET') return false;
  try {
    const digest = readFactoryDigest(dbPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ digest, text: formatFactoryDigest(digest) }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: safeErrorMessage(error) }));
  }
  return true;
}
