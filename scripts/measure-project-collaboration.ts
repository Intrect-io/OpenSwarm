/** Deterministic scale evidence; not a live-provider benchmark. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const artifact = process.argv[2];
assert(artifact, 'Usage: <output.json>');
const dir = mkdtempSync(join(tmpdir(), 'project-scale-'));
process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'board.json');
const { syncChannels, listChannelEntries } = await import('../src/coordination/channelStore.js');
const { channelDatabase } = await import('../src/coordination/channelSchema.js');
const { recordTraceEventRequired } = await import('../src/coordination/coordinationTrace.js');
const { queryProjectSnapshot } = await import('../src/coordination/projectQueries.js');
const { repositoryCell } = await import('../src/coordination/repositoryCell.js');
const { projectPage, tryHandleProjectRoutes } = await import('../src/coordination/projectRoutes.js');
const results = [];
for (const n of [10, 100]) {
  const paths = Array.from({ length: n }, (_, p) => { const path = join(dir, `project-${p}`); mkdirSync(path, { recursive: true }); return path; });
  const initStart = performance.now(); syncChannels(paths); const initMs = performance.now() - initStart;
  const db = channelDatabase();
  db.transaction(() => {
    for (let p = 0; p < n; p++) {
      const repoKey = repositoryCell(paths[p]).repoKey;
      for (let a = 0; a < 10; a++) recordTraceEventRequired(db, { id: `${n}:${p}:${a}`, seq: p * 10 + a + 1,
        timestamp: Date.now(), repository: paths[p], repoKey, taskId: `task-${a % 2}`, actor: `agent-${a}`,
        actorName: 'Same name', actorRole: a % 2 ? 'reviewer' : 'worker', recipient: `agent-${(a + 1) % 10}`,
        targetTaskId: `task-${(a + 1) % 2}`, kind: 'human-question', status: 'waiting',
        correlationId: `${n}:question:${p}:${a}`, summary: 'A deterministic operator question', fingerprint: `${n}:${p}:${a}` });
    }
  }).immediate();
  const runner = { getRunningTasks: () => paths.flatMap((projectPath) => [0, 1].map((a) => ({ projectPath,
    task: { id: `task-${a}`, title: 'Fixture running task' }, startedAt: Date.now(), stage: 'worker' }))), getQueuedTasks: () => [], isProjectCoordinatorAvailable: () => false };
  const times: number[] = []; const before = process.memoryUsage();
  for (let i = 0; i < 25; i++) {
    const start = performance.now(); const snapshot = queryProjectSnapshot(paths, runner as never);
    const page = projectPage(snapshot.projects, (p) => p.repoKey, 'projects', new URLSearchParams());
    assert.equal(snapshot.totals.runningTasks, n * 2); assert.equal(snapshot.totals.recentParticipants, n * 10);
    assert.equal(page.items.length, Math.min(50, n)); assert.equal(snapshot.partial, false);
    assert.equal(listChannelEntries(repositoryCell(paths[0]).repoKey).items.length, n === 10 ? 10 : 20);
    times.push(performance.now() - start);
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void tryHandleProjectRoutes(req, res, url.pathname, url, runner as never, paths, async () => '{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const httpTimes: number[] = [];
  try {
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/coordination/projects`);
      assert.equal(response.status, 200);
      const body = await response.json() as { totals: { recentParticipants: number }; items: unknown[] };
      assert.equal(body.totals.recentParticipants, n * 10);
      assert.equal(body.items.length, Math.min(n, 50));
      httpTimes.push(performance.now() - start);
    }
  } finally { await new Promise<void>((done) => server.close(() => done())); }
  httpTimes.sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  results.push({ projects: n, agents: n * 10, loops: times.length, initMs,
    queryP50Ms: times[12], queryP95Ms: times[23], queryMaxMs: times[24], httpP50Ms: httpTimes[12], httpP95Ms: httpTimes[23], httpMaxMs: httpTimes[24],
    heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed, rssBytes: process.memoryUsage().rss,
    aggregateScope: 'complete durable records; two synthetic sessions per project', stateDir: dir });
}
writeFileSync(artifact, JSON.stringify({ fixtureOnly: true, results }, null, 2));
console.log(JSON.stringify({ fixtureOnly: true, results }, null, 2));
