// Dashboard route for the daily factory digest (AGT-4810):
//   GET /api/factory/digest -> { digest, text }
// Split out of web.ts, which sits at the repo's per-file line cap. Reads the
// automation database read-only; the daemon stays its only writer.
import type { ServerResponse } from 'node:http';
import { defaultAutomationDbPath } from '../automation/automationDbPath.js';
import { formatFactoryDigest, readFactoryDigest, type DigestOptions } from '../automation/factoryDigest.js';
import { safeErrorMessage } from './webServiceControl.js';

/** The digest is a day's figures; recomputing it on every panel open buys nothing. */
export const FACTORY_DIGEST_MEMO_MS = 60_000;
const memo = new Map<string, { at: number; body: string }>();
let digestOptions: DigestOptions = {};

/** The daemon's spend settings, so the dashboard prices unpriced attempts as the budget does. */
export function setFactoryDigestOptions(options: DigestOptions): void {
  digestOptions = { ...options };
  memo.clear();
}

/** Returns false when the route is not this one, so the caller's router keeps looking. */
export function handleFactoryDigest(url: string, method: string | undefined, res: ServerResponse, dbPath = defaultAutomationDbPath()): boolean {
  if (url !== '/api/factory/digest' || method !== 'GET') return false;
  try {
    const now = Date.now();
    const cached = memo.get(dbPath);
    let body: string;
    if (cached && now >= cached.at && now - cached.at < FACTORY_DIGEST_MEMO_MS) {
      body = cached.body;
    } else {
      const digest = readFactoryDigest(dbPath, now, digestOptions);
      body = JSON.stringify({ digest, text: formatFactoryDigest(digest) });
      memo.set(dbPath, { at: now, body });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: safeErrorMessage(error) }));
  }
  return true;
}
