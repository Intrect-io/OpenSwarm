// Created: 2026-11-22
// Purpose: Prove `review --max --adapter openrouter` at concurrency 16 through the real
//          reviewer, OpenRouter adapter and agentic loop, with only the HTTP dispatcher faked.
// Dependencies: vitest, undici MockAgent
// Test Status: npx vitest run src/cli/reviewAudit.openrouterConcurrency.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import type { AuditArea, AuditRun } from './reviewAudit.js';

// The ONLY fake: undici's `Agent` constructor hands back the test's MockAgent, so the
// real httpDispatcher.adapterFetch -> undici fetch path runs unchanged against it.
const fake = vi.hoisted(() => ({ agent: undefined as unknown }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: function FakeProviderAgent() {
      if (!fake.agent) throw new Error('test MockAgent not installed');
      return fake.agent;
    },
  };
});

const ORIGIN = 'https://openrouter.ai';
const FAKE_KEY = 'sk-or-fake-concurrency-test';
const CONCURRENCY = 16;
const AREA_COUNT = 20;
const BROKEN_LABEL = 'src/a07';
const NO_VERDICT_TEXT =
  'I read every file in this area and walked through the control flow carefully. ' +
  'The module wiring looks reasonable overall and the helpers are small.';

type ReviewAuditModule = typeof import('./reviewAudit.js');

interface ProviderLog {
  chatRequests: number;
  authHeaders: Set<string>;
  perArea: Map<string, number>;
  repairSeen: Set<string>;
  inFlight: number;
  maxInFlight: number;
}

const label = (i: number): string => `src/a${String(i).padStart(2, '0')}`;

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}`,
    'data: [DONE]',
    '',
  ].join('\n');
}

function verdictFor(area: string): string {
  return [
    `Audit of ${area} complete.`,
    '```json',
    JSON.stringify({
      decision: 'approve',
      feedback: `No defects found in ${area}.`,
      issues: [],
      suggestions: [],
      coverage: 'complete',
    }),
    '```',
  ].join('\n');
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const entries = Object.entries(headers as Record<string, string | string[]>);
  const hit = entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit ? String(hit[1]) : undefined;
}

describe('review --max over the real OpenRouter adapter (fake provider)', () => {
  let tempRoot: string;
  let repo: string;
  let mod: ReviewAuditModule;
  let resetDispatcher: () => void;
  let netFetch: ReturnType<typeof vi.fn>;
  let log: ProviderLog;
  let areas: AuditArea[];
  // When set, BROKEN_LABEL answers every turn (repair included) without a verdict.
  let brokenArea = false;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'os-review-max-or16-'));
    const home = join(tempRoot, 'home');
    repo = join(tempRoot, 'repo');
    mkdirSync(home, { recursive: true });
    areas = Array.from({ length: AREA_COUNT }, (_, i) => {
      const dir = label(i);
      mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'mod.ts'), `export const value${i} = ${i};\n`);
      return { label: dir, dir, files: [`${dir}/mod.ts`] };
    });
    // Isolate every home-relative path (model catalog, MCP registry, logs) and the
    // config search before the modules under test compute them at import time.
    vi.stubEnv('HOME', home);
    vi.stubEnv('OPENSWARM_MODEL_CATALOG_DIR', join(home, 'catalog'));
    vi.stubEnv('OPENSWARM_CONFIG', join(tempRoot, 'absent-config.yaml'));
    vi.stubEnv('OPENROUTER_API_KEY', FAKE_KEY);
    vi.stubEnv('OPENROUTER_API', '');
    vi.stubEnv('OPENROUTER_PROVIDER_ONLY', '');
    mod = await import('./reviewAudit.js');
    ({ resetAdapterDispatcherForTests: resetDispatcher } = await import('../adapters/httpDispatcher.js'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Anything that bypasses the adapter dispatcher would reach the real network.
    netFetch = vi.fn(async () => {
      throw new Error('unexpected global fetch');
    });
    vi.stubGlobal('fetch', netFetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    log = { chatRequests: 0, authHeaders: new Set(), perArea: new Map(), repairSeen: new Set(), inFlight: 0, maxInFlight: 0 };
    const agent = new MockAgent();
    agent.disableNetConnect();
    fake.agent = agent;
    resetDispatcher();

    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/api/v1/models', method: 'GET' })
      .reply(200, { data: [{ id: 'deepseek/deepseek-v4-flash', context_length: 131072 }, { id: 'z-ai/glm-5.3-flash' }] })
      .persist();

    // Hold every chat reply until CONCURRENCY are in flight (or a fallback fires),
    // then linger so an over-cap request would still raise the observed maximum.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fallback = setTimeout(() => release(), 4_000);
    void gate.then(() => clearTimeout(fallback));

    pool
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, async (opts) => {
        const body = typeof opts.body === 'string' ? opts.body : String(opts.body);
        const area = /Codebase audit: (src\/a\d{2})/.exec(body)?.[1] ?? 'unknown';
        log.chatRequests++;
        log.authHeaders.add(headerValue(opts.headers, 'authorization') ?? '');
        log.perArea.set(area, (log.perArea.get(area) ?? 0) + 1);
        if (body.includes('did not contain a verdict this harness can read')) log.repairSeen.add(area);
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        if (log.inFlight >= CONCURRENCY) setTimeout(release, 150);
        await gate;
        log.inFlight--;
        return sse(area === BROKEN_LABEL && brokenArea ? NO_VERDICT_TEXT : verdictFor(area));
      }, { headers: { 'content-type': 'text/event-stream' } })
      .persist();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetDispatcher();
    await (fake.agent as MockAgent | undefined)?.close();
    fake.agent = undefined;
    brokenArea = false;
  });

  const run = (): Promise<AuditRun> =>
    mod.runMaxReview(areas, repo, { concurrency: CONCURRENCY, adapter: 'openrouter', timeoutMs: 20_000 });

  it('runs 16 concurrent OpenRouter reviews through the real adapter loop against a fake provider', async () => {
    const result = await run();

    expect(result.summary.failed).toBe(0);
    expect(result.summary.completed).toBe(AREA_COUNT);
    expect(result.summary.decision).toBe('approve');
    for (const r of result.results) {
      expect(r.error).toBeUndefined();
      expect(r.review?.decision).toBe('approve');
      expect(r.review?.feedback).toContain(r.area.label);
    }
    expect(log.chatRequests).toBeGreaterThanOrEqual(AREA_COUNT);
    expect([...log.perArea.keys()].sort()).toEqual(areas.map((a) => a.label));
    // Measured, not assumed: the cap was reached and never exceeded.
    expect(log.maxInFlight).toBe(CONCURRENCY);
    expect([...log.authHeaders]).toEqual([`Bearer ${FAKE_KEY}`]);
    expect(netFetch).not.toHaveBeenCalled();
  }, 30_000);

  it('fails the aggregate when one area never yields a verdict even after the repair turn', async () => {
    const { reviewerOutputNeedsFormatRepair } = await import('../adapters/resultParsing.js');
    expect(reviewerOutputNeedsFormatRepair(NO_VERDICT_TEXT)).toBe(true);
    brokenArea = true;

    const result = await run();

    expect(result.summary.decision).not.toBe('approve');
    expect(result.summary.failed).toBe(1);
    expect(result.summary.completed).toBe(AREA_COUNT - 1);
    expect(result.infraAbort).toBeUndefined();
    const broken = result.summary.areas.find((a) => a.label === BROKEN_LABEL);
    expect(broken?.decision).toBe('error');
    expect(broken?.error).toMatch(/no parseable verdict/i);
    for (const r of result.results.filter((x) => x.area.label !== BROKEN_LABEL)) {
      expect(r.review?.decision).toBe('approve');
    }
    // The tool-less repair turn was actually asked for, and answered without a verdict.
    expect(log.repairSeen.has(BROKEN_LABEL)).toBe(true);
    expect(log.perArea.get(BROKEN_LABEL) ?? 0).toBeGreaterThanOrEqual(2);
    expect(netFetch).not.toHaveBeenCalled();
  }, 30_000);
});
