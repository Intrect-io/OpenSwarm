import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignCallSign } from './agentNames.js';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
// `ask_human` reads the durable trace so an answer survives the board's ring,
// and that trace lives in the automation database vitest.setup points at one
// path for the whole run — without a database per test, these suites see each
// other's questions already answered.
const ORIGINAL_AUTOMATION_DB = process.env.OPENSWARM_AUTOMATION_DB;
let dir = '';
afterEach(async () => {
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  (await import('./coordinationTrace.js')).resetTraceDbForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL_AUTOMATION_DB;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function tools() {
  dir = mkdtempSync(join(tmpdir(), 'osw-coordination-tools-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  (await import('./coordinationTrace.js')).resetTraceDbForTests();
  return import('./coordinationTools.js');
}

describe('coordination tools', () => {
  it('delivers a request addressed by call sign to that agent only', async () => {
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 's1', role: 'worker' });
    const bob = assignCallSign({ repository: '/repo', executionId: 's2', role: 'worker' });

    await mod.executeCoordinationTool(
      'coordination_publish',
      { kind: 'advice-request', recipient: bob.name, summary: 'Is the auth helper safe to reuse?' },
      { repository: '/repo', taskId: 't1', actor: alice.address, actorName: alice.name },
    );

    const stranger = assignCallSign({ repository: '/repo', executionId: 's3', role: 'worker' });
    const unrelated = await mod.executeCoordinationTool('coordination_read', {}, {
      repository: '/repo', taskId: 't1', actor: stranger.address, actorName: stranger.name,
    });
    expect(JSON.parse(unrelated.content)).toEqual([]);

    const inbox = await mod.executeCoordinationTool('coordination_read', {}, {
      repository: '/repo', taskId: 't1', actor: bob.address, actorName: bob.name,
    });
    const messages = JSON.parse(inbox.content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ actorName: alice.name, recipientName: bob.name, kind: 'advice-request' });
  });

  it('pages the operator instead of answering its own question', async () => {
    const mod = await tools();
    const paged: string[] = [];
    const result = await mod.executeCoordinationTool('ask_human', { question: 'Ship v2?' }, {
      repository: '/repo', taskId: 't1', actor: 'magos-test', actorName: 'Magos Test-Vector',
      notifyOperator: async (message) => { paged.push(message); return true; },
    });
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ blocked: true, delivered: true });
    expect(payload.correlationId).toMatch(/^hq-/);
    expect(paged[0]).toContain('Ship v2?');
  });

  it('tells the agent nobody was paged when Discord is unreachable', async () => {
    const mod = await tools();
    const result = await mod.executeCoordinationTool('ask_human', { question: 'Ship v3?' }, {
      repository: '/repo', taskId: 't1', actor: 'magos-test',
      notifyOperator: async () => false,
    });
    const payload = JSON.parse(result.content);
    expect(payload.delivered).toBe(false);
    expect(payload.instruction).toContain('nobody has been paged');
  });
});

// An agent that waited for a reply used to be killed for waiting: three checks
// of a quiet inbox looked exactly like a stalled model. (AGT-4065)
describe('coordination_wait', () => {
  it('reports an unreadable board instead of an empty inbox', async () => {
    // A board that cannot be read is not a board with no mail. Returning []
    // would let an agent conclude nobody answered and proceed. (Caught by the
    // commit-gate review.)
    const mod = await tools();
    const store = { consume: async () => { throw new Error('EACCES coordination.json'); } };
    await expect(mod.waitForInbox(store, { repository: '/repo', taskId: 't1', actor: 'a' }, 120))
      .rejects.toThrow(/Coordination board unavailable.*EACCES/);
  });

  it('still reports an empty inbox as empty when the board is readable', async () => {
    const mod = await tools();
    const store = { consume: async () => [] as unknown[] };
    await expect(mod.waitForInbox(store, { repository: '/repo', taskId: 't1', actor: 'a' }, 120))
      .resolves.toEqual([]);
  });

  it('does not fail the wait for a transient read error that later succeeds', async () => {
    const mod = await tools();
    let call = 0;
    const store = {
      consume: async () => {
        call += 1;
        if (call === 1) throw new Error('transient');
        return [];
      },
    };
    // The 2s re-drain gives the second attempt a chance before the deadline.
    await expect(mod.waitForInbox(store, { repository: '/repo', taskId: 't1', actor: 'a' }, 3_000))
      .resolves.toEqual([]);
  }, 10_000);

  it('wakes for a publisher the in-process hub cannot see', async () => {
    // `openswarm attach` and the CLI write to the board file from their own
    // processes, where an in-memory emitter never fires. Without a slow
    // re-drain the wait would silently always time out for exactly the
    // operator path it exists to serve. Simulate by writing through the store
    // with the hub deafened. (Caught by the commit-gate review.)
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 'w-xp', role: 'worker' });
    const bob = assignCallSign({ repository: '/repo', executionId: 'w-xp-b', role: 'reviewer' });
    const { getEventHub } = await import('../core/eventHub.js');
    const hub = getEventHub();

    const waiting = mod.executeCoordinationTool(
      'coordination_wait', { timeout_ms: 8_000 },
      { repository: '/repo', taskId: 't1', actor: alice.address },
    );
    setTimeout(() => {
      // Deafen the hub for this publish, so only the re-drain can notice.
      const listeners = hub.listeners('coordination:published');
      hub.removeAllListeners('coordination:published');
      void mod.executeCoordinationTool(
        'coordination_publish',
        { kind: 'advice-response', recipient: alice.address, summary: 'from another process' },
        { repository: '/repo', taskId: 't1', actor: bob.address },
      ).then(() => {
        for (const l of listeners) hub.on('coordination:published', l as () => void);
      });
    }, 30);

    const events = JSON.parse((await waiting).content) as Array<{ summary: string }>;
    expect(events.map((e) => e.summary)).toContain('from another process');
  }, 15_000);

  it('does not drop a wake-up that arrives while a drain is in flight', async () => {
    // The window is milliseconds wide against the real store, so drive it with
    // a fake: the first drain is still running when the event fires. Guarding
    // the drain without remembering the wake-up left that message waiting for
    // the next poll — or forever, if nothing else was ever published.
    const mod = await tools();
    const { getEventHub } = await import('../core/eventHub.js');
    const hub = getEventHub();
    let call = 0;
    const store = {
      consume: async () => {
        call += 1;
        if (call === 1) {
          // Fire the wake-up mid-drain, then finish this drain empty.
          setTimeout(() => hub.emit('coordination:published', {}), 5);
          await new Promise((r) => setTimeout(r, 40));
          return [];
        }
        return [{ summary: 'landed mid-drain' }];
      },
    };

    const started = Date.now();
    const events = await mod.waitForInbox(
      store, { repository: '/repo', taskId: 't1', actor: 'a' }, 5_000,
    ) as Array<{ summary: string }>;
    expect(events.map((e) => e.summary)).toContain('landed mid-drain');
    // Well under the 2s re-drain interval: the wake-up itself has to be what
    // produced the second drain.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('returns at the deadline when nothing arrives', async () => {
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 'w-quiet', role: 'worker' });
    const started = Date.now();
    const result = await mod.executeCoordinationTool(
      'coordination_wait',
      { timeout_ms: 120 },
      { repository: '/repo', taskId: 't1', actor: alice.address },
    );
    expect(JSON.parse(result.content)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('returns as soon as a message addressed to the agent arrives', async () => {
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 'w-a', role: 'worker' });
    const bob = assignCallSign({ repository: '/repo', executionId: 'w-b', role: 'reviewer' });

    const started = Date.now();
    // A generous deadline: the point is that it returns long before it.
    const waiting = mod.executeCoordinationTool(
      'coordination_wait',
      { timeout_ms: 5_000 },
      { repository: '/repo', taskId: 't1', actor: alice.address },
    );
    setTimeout(() => {
      void mod.executeCoordinationTool(
        'coordination_publish',
        { kind: 'advice-response', recipient: alice.address, summary: 'here is the answer' },
        { repository: '/repo', taskId: 't1', actor: bob.address },
      );
    }, 30);

    const events = JSON.parse((await waiting).content) as Array<{ summary: string }>;
    expect(events.map((e) => e.summary)).toContain('here is the answer');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('does not lose a message that landed before the wait began', async () => {
    // Waiting must not be a way to miss mail: anything that arrived since the
    // agent's last read has to come back on the first drain.
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 'w-pre', role: 'worker' });
    const bob = assignCallSign({ repository: '/repo', executionId: 'w-pre-b', role: 'reviewer' });
    await mod.executeCoordinationTool(
      'coordination_publish',
      { kind: 'advice-request', recipient: alice.address, summary: 'sent earlier' },
      { repository: '/repo', taskId: 't1', actor: bob.address },
    );
    const result = await mod.executeCoordinationTool(
      'coordination_wait', { timeout_ms: 50 },
      { repository: '/repo', taskId: 't1', actor: alice.address },
    );
    expect((JSON.parse(result.content) as Array<{ summary: string }>).map((e) => e.summary)).toContain('sent earlier');
  });

  it('clamps a requested wait to something a stage can afford', async () => {
    const { resolveWaitMs, COORDINATION_WAIT_MAX_MS, COORDINATION_WAIT_DEFAULT_MS } =
      await import('./coordinationTools.js');
    // Worker stages get 20 min and the agentic loop 5 — a wait must never be a
    // way to burn that budget and fail the stage as infra_error.
    expect(resolveWaitMs(60 * 60_000)).toBe(COORDINATION_WAIT_MAX_MS);
    // The fixed ceiling is not enough on its own: a loop with seconds left
    // would still grant a full-length wait and then time out instead of
    // returning the answer that was about to arrive.
    const now = 1_000_000;
    const { COORDINATION_WAIT_LOOP_MARGIN_MS } = await import('./coordinationTools.js');
    expect(resolveWaitMs(60_000, now + 20_000, now)).toBe(20_000 - COORDINATION_WAIT_LOOP_MARGIN_MS);
    // Past the deadline already: nothing left to spend.
    expect(resolveWaitMs(60_000, now + 1_000, now)).toBe(0);
    // A generous loop deadline does not raise the fixed ceiling.
    expect(resolveWaitMs(60 * 60_000, now + 60 * 60_000, now)).toBe(COORDINATION_WAIT_MAX_MS);
    expect(resolveWaitMs(undefined)).toBe(COORDINATION_WAIT_DEFAULT_MS);
    expect(resolveWaitMs('soon')).toBe(COORDINATION_WAIT_DEFAULT_MS);
    expect(resolveWaitMs(-5)).toBe(0);
    expect(resolveWaitMs(1_500)).toBe(1_500);
  });

  it('is dispatchable — the adapter derives its tool names from the definitions', async () => {
    const { COORDINATION_TOOL_NAMES, COORDINATION_TOOL_DEFINITIONS } = await import('./coordinationTools.js');
    // The adapter used to keep a hardcoded copy of this list, so a new tool was
    // defined, advertised, and then silently undispatchable.
    expect(COORDINATION_TOOL_NAMES.has('coordination_wait')).toBe(true);
    expect([...COORDINATION_TOOL_NAMES].sort())
      .toEqual(COORDINATION_TOOL_DEFINITIONS.map((d) => d.function.name).sort());
  });
});

// Unref'd timers let a process whose only pending handles are those timers
// exit mid-wait, and the awaited promise simply never resolves. Nothing
// in-process can observe that — vitest's own worker always has other handles —
// so drive a real child. (Caught by the PR review; AGT-4065)
describe('a wait keeps its process alive until it settles', () => {
  it('resolves in a child process with nothing else pending', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const scriptDir = mkdtempSync(join(tmpdir(), 'osw-wait-alive-'));
    const script = join(scriptDir, 'probe.mts');
    await fsp.writeFile(script, [
      `import { waitForInbox } from ${JSON.stringify(join(process.cwd(), 'src/coordination/coordinationTools.ts'))};`,
      'const store = { consume: async () => [] };',
      'const started = Date.now();',
      "const events = await waitForInbox(store, { repository: '/r', taskId: 't', actor: 'a' }, 1200);",
      "console.log('SETTLED', JSON.stringify(events), Date.now() - started >= 1000);",
    ].join('\n'), 'utf-8');

    try {
      const { stdout } = await run(
        process.execPath,
        [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), script],
        { cwd: process.cwd(), timeout: 60_000 },
      );
      // Without the fix the child exits silently and this never appears.
      expect(stdout).toContain('SETTLED [] true');
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('the deadline does not throw away mail a drain was collecting', () => {
  it('returns a message whose drain outlived the timeout', async () => {
    // `consume` is destructive: it marks what it returns as seen. Resolving []
    // while a drain was in flight consumed the message and discarded it — the
    // agent saw "nobody answered" for mail that had arrived.
    // (Caught by the PR review; AGT-4065)
    const mod = await tools();
    const store = {
      consume: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return [{ summary: 'arrived just before the deadline' }];
      },
    };
    const events = await mod.waitForInbox(
      store, { repository: '/r', taskId: 't', actor: 'a' }, 80,
    ) as Array<{ summary: string }>;
    expect(events.map((e) => e.summary)).toContain('arrived just before the deadline');
  }, 10_000);

  it('still settles under a stream of wake-ups after the deadline', async () => {
    // The post-expiry catch-up is bounded by detaching the wake-up sources at
    // the deadline. Without that, continuous publishing keeps re-arming the
    // catch-up and the wait never returns.
    const mod = await tools();
    const { getEventHub } = await import('../core/eventHub.js');
    const noise = setInterval(() => getEventHub().emit('coordination:published', {}), 10);
    const store = {
      consume: async () => { await new Promise((r) => setTimeout(r, 30)); return [] as unknown[]; },
    };
    try {
      const started = Date.now();
      await expect(mod.waitForInbox(store, { repository: '/r', taskId: 't', actor: 'a' }, 100))
        .resolves.toEqual([]);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      clearInterval(noise);
    }
  }, 10_000);

  it('honours a wake-up recorded during the drain that outlived the deadline', async () => {
    // The message was published BEFORE the deadline; only its delivery landed
    // after. Dropping the recorded wake-up reported an empty inbox for mail
    // that had already arrived. (Caught by the PR review; AGT-4065)
    const mod = await tools();
    const { getEventHub } = await import('../core/eventHub.js');
    let call = 0;
    const store = {
      consume: async () => {
        call += 1;
        if (call === 1) {
          setTimeout(() => getEventHub().emit('coordination:published', {}), 20);
          await new Promise((r) => setTimeout(r, 200));
          return [];
        }
        return [{ summary: 'published before the deadline' }];
      },
    };
    const events = await mod.waitForInbox(
      store, { repository: '/r', taskId: 't', actor: 'a' }, 80,
    ) as Array<{ summary: string }>;
    expect(events.map((e) => e.summary)).toContain('published before the deadline');
  }, 10_000);

});