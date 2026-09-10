// ============================================
// OpenSwarm — an unopenable memory store reports once, not per recall (AGT-4267)
// ============================================
//
// Measured on vela 2026-09-10: seven zero-byte manifests left by a single
// interrupted write on 2026-09-01 made every recall throw, and each caller
// swallowed it — 95 identical stacks in five minutes, burying every other
// diagnostic. The one fact nobody could read off that log was the only one
// that mattered: long-term recall was off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn());
vi.mock('@lancedb/lancedb', () => ({ connect, Table: class {}, Connection: class {} }));
const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock('@huggingface/transformers', () => ({ pipeline: pipelineMock, env: {} }));
// vitest.setup.ts redirects four home-dir paths but not this one. MEMORY_DIR is
// `resolve(homedir(), '.openswarm/memory')`, evaluated at module load, and the
// operator's real store lives there — opening it reads their own embedding
// signature and, on the create-table branch, writes to it.
const testHome = vi.hoisted(() => `/tmp/openswarm-recall-status-${process.pid}`);
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => testHome,
}));

describe('memory recall status (AGT-4267)', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    connect.mockReset();
    // Reset rather than rely on restoreAllMocks: a mockRejectedValue set by one
    // test outlives it and turns every later search into EMBEDDING_FAILED.
    pipelineMock.mockReset();
    // A usable extractor, so a search that gets past the store reaches the
    // query rather than stopping at EMBEDDING_FAILED.
    pipelineMock.mockImplementation(async () => async () => ({ data: Float32Array.from([1, 0, 0, 0]) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const corrupt = () => new Error('lance error: Invalid range 0..0 for object of size 0 bytes');
  const openable = () => ({
    tableNames: async () => ['cognitive_memory'],
    openTable: async () => ({ schema: async () => ({ fields: [] }) }),
  });
  const reportsIn = (lines: string[]) => lines.filter(e => e.includes('recall is UNAVAILABLE'));

  it('reports the first failure and suppresses the identical repeats', async () => {
    connect.mockRejectedValue(corrupt());
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();

    for (let i = 0; i < 20; i += 1) {
      await expect(core.initDatabase()).rejects.toThrow();
    }

    expect(reportsIn(errors)).toHaveLength(1);
    expect(reportsIn(errors)[0]).toContain('Invalid range 0..0');
  });

  it('says recall is unavailable, and how many failures it swallowed', async () => {
    connect.mockRejectedValue(corrupt());
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();

    await expect(core.initDatabase()).rejects.toThrow();
    await expect(core.initDatabase()).rejects.toThrow();
    await expect(core.initDatabase()).rejects.toThrow();

    // "no memories found" and "recall is dead" were indistinguishable before.
    const st = core.memoryRecallStatus();
    expect(st.available).toBe(false);
    expect(st.error).toContain('Invalid range 0..0');
    expect(st.suppressedCount).toBe(2);
  });

  it('reports again once the window elapses, carrying the suppressed count', async () => {
    // Suppression is a rate limit, not a mute. Without this a persistent outage
    // would be announced once and then never mentioned again, which is how a
    // store that stayed broken for nine days went unnoticed.
    vi.useFakeTimers();
    connect.mockRejectedValue(corrupt());
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();

    for (let i = 0; i < 5; i += 1) await expect(core.initDatabase()).rejects.toThrow();
    expect(reportsIn(errors)).toHaveLength(1);

    vi.advanceTimersByTime(11 * 60_000);
    await expect(core.initDatabase()).rejects.toThrow();

    const reports = reportsIn(errors);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('4 further failure(s) since the last report');
    expect(core.memoryRecallStatus().suppressedCount).toBe(0);
  });

  it('reports the whole outage on recovery, not just the last window', async () => {
    // The suppressed count resets on every re-report the window forces, so an
    // outage spanning three windows would have announced its last ten minutes
    // as its size. vela's store was broken for nine days — the headline case
    // for this ticket is exactly the one where that number is wrong by orders
    // of magnitude.
    vi.useFakeTimers();
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockRejectedValue(corrupt());

    for (let i = 0; i < 5; i += 1) await expect(core.initDatabase()).rejects.toThrow();
    vi.advanceTimersByTime(11 * 60_000);
    for (let i = 0; i < 5; i += 1) await expect(core.initDatabase()).rejects.toThrow();
    vi.advanceTimersByTime(11 * 60_000);
    for (let i = 0; i < 3; i += 1) await expect(core.initDatabase()).rejects.toThrow();
    expect(reportsIn(errors)).toHaveLength(3);
    // One more window holding a single failure, so the window count is 0 at the
    // moment of recovery. Guarding the annotation on that count instead of the
    // outage total drops the number entirely here — a long outage that happens
    // to recover just after a window boundary reports nothing, which is the
    // defect this pair of commits is about.
    vi.advanceTimersByTime(11 * 60_000);
    await expect(core.initDatabase()).rejects.toThrow();
    expect(core.memoryRecallStatus().suppressedCount).toBe(0);

    connect.mockResolvedValue(openable());
    await core.initDatabase();

    expect(errors.some(e => /long-term recall restored after 14 failure\(s\)/.test(e))).toBe(true);
  });

  it('bounds reports even when the store alternates between two errors', async () => {
    // Suppressing only *identical* messages matches neither of an alternating
    // pair, so every recall reports — the original unbounded logging wearing a
    // hat. The window has to bound reports, not identical reports.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    let n = 0;
    connect.mockImplementation(async () => {
      n += 1;
      throw n % 2 === 0 ? new Error('Too many concurrent writers') : corrupt();
    });

    for (let i = 0; i < 20; i += 1) await expect(core.initDatabase()).rejects.toThrow();

    const reports = reportsIn(errors);
    expect(reports).toHaveLength(1);
    expect(core.memoryRecallStatus().suppressedCount).toBe(19);
  });

  it('names the other errors it saw while suppressing, not just the last one', async () => {
    vi.useFakeTimers();
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockRejectedValueOnce(corrupt());
    await expect(core.initDatabase()).rejects.toThrow();
    connect.mockRejectedValue(new Error('ENOSPC: no space left on device'));
    for (let i = 0; i < 3; i += 1) await expect(core.initDatabase()).rejects.toThrow();

    vi.advanceTimersByTime(11 * 60_000);
    await expect(core.initDatabase()).rejects.toThrow();

    const reports = reportsIn(errors);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('ENOSPC');
    expect(reports[1]).toContain('3 further failure(s)');
    // The suppressed window held a different error; dropping it loses the only
    // record that the store failed two distinct ways.
    expect(reports[1]).toContain('Invalid range 0..0');
  });

  it('caps how many distinct messages one report names', async () => {
    // Errors that embed a varying detail — a byte range, a timestamped
    // predicate — produce a new string every call. Uncapped, one window's
    // report measured 131 KB on a single line. Ninety-five stacks were at
    // least greppable line by line; that is not.
    vi.useFakeTimers();
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    let n = 0;
    connect.mockImplementation(async () => {
      n += 1;
      throw new Error(`lance error: Invalid range ${n}..${n} for object of size 0 bytes`);
    });

    for (let i = 0; i < 400; i += 1) await expect(core.initDatabase()).rejects.toThrow();
    vi.advanceTimersByTime(11 * 60_000);
    await expect(core.initDatabase()).rejects.toThrow();

    const reports = reportsIn(errors);
    expect(reports).toHaveLength(2);
    expect(reports[1].length).toBeLessThan(1500);
    // The ones it could not list are still counted, so the scale survives.
    expect(reports[1]).toMatch(/and \d+ further occurrence\(s\) of unlisted messages/);
    expect(reports[1]).toContain('399 further failure(s)');
  });

  it('rate-limits a dead embedder too, instead of leaving it the one uncovered path', async () => {
    // A healthy store with a broken embedder returned early before either
    // reporter: 40 recalls, 40 stacks, and memoryRecallStatus() answering
    // available:true while every recall failed.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockResolvedValue(openable());
    pipelineMock.mockRejectedValue(new Error('model weights are corrupt'));

    for (let i = 0; i < 40; i += 1) {
      const res = await core.searchMemorySafe('anything');
      expect(res.errorCode).toBe('EMBEDDING_FAILED');
    }

    expect(reportsIn(errors)).toHaveLength(1);
    expect(reportsIn(errors)[0]).toContain('the query could not be embedded');
    const st = core.memoryRecallStatus();
    expect(st.available).toBe(false);
    expect(st.phase).toBe('embed');
  });

  it('does not credit one phase\'s failures to another phase\'s report', async () => {
    // query → embed is the one transition with no clear in between: the
    // query-phase clear lives at the end of a successful search, which does not
    // run when the embedder throws. Carrying the tally there tells an operator
    // the embedder failed 40 times when it failed once and the store's query
    // path failed 39.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockResolvedValue({
      ...openable(),
      openTable: async () => ({
        schema: async () => ({ fields: [] }),
        vectorSearch: () => { throw new Error('lance: query is broken'); },
      }),
    });
    // The extractor is cached after its first load, so a post-warm-up embed
    // failure comes from the extractor throwing — tensor allocation under
    // memory pressure — not from the pipeline failing to load.
    let embedderBroken = false;
    pipelineMock.mockImplementation(async () => async () => {
      if (embedderBroken) throw new Error('failed to allocate tensor');
      return { data: Float32Array.from([1, 0, 0, 0]) };
    });
    // Spans three windows on purpose, the last holding a single failure. The
    // suppressed count resets on every re-report, so at the moment of the phase
    // change it is 0 while the outage total is 40 — the report has to name the
    // second, and must not gate itself on the first.
    vi.useFakeTimers();
    for (let i = 0; i < 20; i += 1) await core.searchMemorySafe('anything');
    vi.advanceTimersByTime(11 * 60_000);
    for (let i = 0; i < 19; i += 1) await core.searchMemorySafe('anything');
    vi.advanceTimersByTime(11 * 60_000);
    await core.searchMemorySafe('anything');
    expect(core.memoryRecallStatus().suppressedCount).toBe(0);

    embedderBroken = true;
    expect((await core.searchMemorySafe('anything')).errorCode).toBe('EMBEDDING_FAILED');

    const embedReport = reportsIn(errors).at(-1)!;
    expect(embedReport).toContain('the query could not be embedded');
    expect(embedReport).not.toContain('39 further failure(s)');
    expect(embedReport).not.toContain('query is broken');
    // But the outgoing phase's scale is not simply dropped: a phase's FIRST
    // report always prints a count of zero, so without naming it here the 40
    // failed queries would never be stated anywhere at all.
    expect(embedReport).toContain('ends a query-phase outage of 40 failure(s)');
  });

  it('clears an embed-phase outage once the embedder works again', async () => {
    // Without this the outage sticks forever: the clear at the end of a
    // successful search is phase-scoped to 'query', so it would never match an
    // 'embed' failure and recall would report dead for the process lifetime.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockResolvedValue({
      ...openable(),
      openTable: async () => ({
        schema: async () => ({ fields: [] }),
        vectorSearch: () => ({ where: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      }),
    });
    pipelineMock.mockRejectedValueOnce(new Error('model weights are corrupt'));

    expect((await core.searchMemorySafe('anything')).errorCode).toBe('EMBEDDING_FAILED');
    expect(core.memoryRecallStatus().phase).toBe('embed');

    expect((await core.searchMemorySafe('anything')).success).toBe(true);

    expect(core.memoryRecallStatus().available).toBe(true);
    const restored = errors.filter(e => e.includes('long-term recall restored'));
    expect(restored).toHaveLength(1);
    // A single blip carries no count — annotating it is the noise the guard
    // exists to prevent.
    expect(restored[0]).not.toMatch(/after \d+ failure\(s\)/);
  });

  it('rate-limits a store that breaks AFTER it opened, and stops claiming it is available', async () => {
    // The `db && table` fast path holds for the process lifetime, so this never
    // re-enters openDatabase: before, 40 recalls printed 40 stacks while
    // memoryRecallStatus() answered available:true for a store failing 100% of
    // recalls. vela's corruption came from one interrupted write, so meeting it
    // mid-run rather than at startup was purely a matter of restart timing.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockResolvedValue({
      ...openable(),
      openTable: async () => ({
        schema: async () => ({ fields: [] }),
        vectorSearch: () => { throw corrupt(); },
      }),
    });

    for (let i = 0; i < 40; i += 1) {
      const res = await core.searchMemorySafe('anything');
      expect(res.errorCode).toBe('QUERY_FAILED');
    }

    expect(reportsIn(errors)).toHaveLength(1);
    expect(reportsIn(errors)[0]).toContain('the store opened but recall failed');
    const st = core.memoryRecallStatus();
    expect(st.available).toBe(false);
    expect(st.phase).toBe('query');
    expect(st.suppressedCount).toBe(39);
  });

  it('clears a query-phase outage when a recall actually succeeds again', async () => {
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    let broken = true;
    connect.mockResolvedValue({
      ...openable(),
      openTable: async () => ({
        schema: async () => ({ fields: [] }),
        vectorSearch: () => {
          if (broken) throw corrupt();
          return { where: () => ({ limit: () => ({ toArray: async () => [] }) }) };
        },
      }),
    });
    for (let i = 0; i < 3; i += 1) await core.searchMemorySafe('anything');
    expect(core.memoryRecallStatus().suppressedCount).toBe(2);

    broken = false;
    await core.searchMemorySafe('anything');

    expect(core.memoryRecallStatus().available).toBe(true);
    // An outage that self-heals must still say how big it was: "was memory dead
    // during that run, and how badly" is what an operator asks afterwards, and
    // the count died with the record before this.
    expect(errors.some(e => /long-term recall restored after 3 failure\(s\)/.test(e))).toBe(true);
  });

  it('makes a caller arriving mid-open wait rather than reading a table being rewritten', async () => {
    // openDatabase assigns `table` and only then runs the schema migration,
    // which rewrites that table with mode:'overwrite'. Checking `db && table`
    // before the in-flight promise let a second caller fast-path straight onto
    // the handle whose storage was being replaced.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    let releaseMigration: () => void = () => {};
    let migrationEntered: () => void = () => {};
    const migrationGate = new Promise<void>(r => { releaseMigration = r; });
    // Resolves the moment the migration starts reading the schema, i.e. exactly
    // when `table` is assigned but its storage is about to be rewritten. Waiting
    // a fixed number of ticks instead would let the second call arrive before
    // `table` was set, where both orderings behave the same and pin nothing.
    const migrationStarted = new Promise<void>(r => { migrationEntered = r; });
    connect.mockResolvedValue({
      tableNames: async () => ['cognitive_memory'],
      openTable: async () => ({
        schema: async () => { migrationEntered(); await migrationGate; return { fields: [] }; },
      }),
    });

    const first = core.initDatabase();
    await migrationStarted;
    let secondSettled = false;
    const second = core.initDatabase().then(() => { secondSettled = true; });

    await new Promise(r => setTimeout(r, 5));
    expect(secondSettled).toBe(false);

    releaseMigration();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
  });

  it('does not re-log the same failure a second time as a "Search error"', async () => {
    // Two sites logged the same stack per recall: initDatabase's catch and
    // searchMemorySafe's. Rate-limiting only the first would have halved the
    // spam, not removed it.
    connect.mockRejectedValue(corrupt());
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();

    for (let i = 0; i < 12; i += 1) {
      const res = await core.searchMemorySafe('anything');
      expect(res.success).toBe(false);
      // A dead store is not a failed query, and repoKnowledge renders this code
      // straight into the agent's prompt.
      expect(res.errorCode).toBe('DB_INIT_FAILED');
    }

    expect(reportsIn(errors)).toHaveLength(1);
  });

  it('still reports a genuine query error on a healthy store', async () => {
    // The two phases are tracked separately so that suppressing one kind of
    // failure cannot hide the other.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    connect.mockResolvedValue({
      ...openable(),
      openTable: async () => ({
        schema: async () => ({ fields: [] }),
        vectorSearch: () => { throw new Error('No field named expiresat'); },
      }),
    });

    const res = await core.searchMemorySafe('anything');

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('QUERY_FAILED');
    expect(reportsIn(errors)).toHaveLength(1);
    expect(reportsIn(errors)[0]).toContain('No field named expiresat');
  });

  it('does not latch — an externally repaired store comes back without a restart', async () => {
    // The vela fix was moving seven zero-byte manifests aside; recall returned
    // on the next call with the daemon still running. A permanent disable
    // would have kept it dark until someone noticed.
    connect.mockRejectedValueOnce(corrupt());
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    await expect(core.initDatabase()).rejects.toThrow();
    expect(core.memoryRecallStatus().available).toBe(false);

    connect.mockResolvedValue(openable());
    await core.initDatabase();

    expect(core.memoryRecallStatus().available).toBe(true);
    // Announced on the same stream as the outage, or an error log shows a
    // failure that never ends.
    expect(errors.some(e => e.includes('long-term recall restored'))).toBe(true);
  });

  it('a failing concurrent open does not destroy the connection another caller just made', async () => {
    // Sixteen reviewers each search memory (see searchMemorySafe's concurrency
    // note). Nulling db/table in the catch made a loser's failure tear down the
    // winner's live handles, and the next search died on `null.vectorSearch`
    // while the fresh failure flag suppressed the log line that would have
    // shown it. Reproduced by an independent reviewer, 2026-09-10.
    const core = await import('./memoryCore.js');
    core.resetMemoryRecallStatusForTests();
    let call = 0;
    connect.mockImplementation(async () => {
      call += 1;
      if (call > 1) throw new Error('Too many concurrent writers');
      return openable();
    });

    const settled = await Promise.allSettled([core.initDatabase(), core.initDatabase()]);

    expect(settled.map(s => s.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(core.getTable()).not.toBeNull();
    expect(core.getDb()).not.toBeNull();
    expect(core.memoryRecallStatus().available).toBe(true);
    // One shared open, not one per caller — on a first run those were N racing
    // createTable calls.
    expect(call).toBe(1);
  });
});
