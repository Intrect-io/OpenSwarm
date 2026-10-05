import type { ServerResponse } from 'node:http';
import { parseUsageQuery, queryUsage } from './usageLedger.js';
import { writeJson } from './webAuth.js';

/** Serve the usage endpoint independently of the web server's route table. */
export async function handleUsageRoute(searchParams: URLSearchParams, res: ServerResponse): Promise<void> {
  const parsed = parseUsageQuery(searchParams);
  if (!parsed.ok) { writeJson(res, 400, { error: parsed.error }); return; }
  const result = queryUsage(parsed);
  if (!result.ok) { writeJson(res, 400, { error: result.error }); return; }
  writeJson(res, 200, { since: new Date(result.since).toISOString(), until: new Date(result.until).toISOString(), ...result.aggregate });
}
