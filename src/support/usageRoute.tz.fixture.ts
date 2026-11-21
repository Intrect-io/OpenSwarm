// Child process for usageRoute.test.ts (AGT-4297): Node fixes the process time
// zone from TZ at startup, so each zone needs its own process. Runs the
// parent and drilldown usage queries the route serves against the ledger in
// OPENSWARM_USAGE_DIR and prints the result as JSON.
import { queryUsage } from './usageLedger.js';

const [since, nowIso] = process.argv.slice(2);
if (!since || !nowIso) throw new Error('usage: usageRoute.tz.fixture.ts <since> <now-iso>');
const now = Date.parse(nowIso);

function aggregate(by: string, filters?: Record<string, string>) {
  const result = queryUsage({ since, by, filters, now });
  if (!result.ok) throw new Error(result.error);
  return { since: result.since, rows: result.aggregate.rows, total: result.aggregate.total };
}

const byProject = aggregate('project');
const drills = byProject.rows.map((parent) => ({ parent, drill: aggregate('stage', { project: parent.key }) }));
const byDay = aggregate('day');
const dayDrills = byDay.rows.map((parent) => ({ parent, drill: aggregate('project', { day: parent.key }) }));
process.stdout.write(`${JSON.stringify({
  offsetMinutes: new Date(now).getTimezoneOffset(),
  since: byProject.since,
  calls: byProject.total.calls,
  drills,
  dayDrills,
})}\n`);
