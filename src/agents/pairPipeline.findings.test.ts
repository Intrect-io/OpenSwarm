import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runDocumenter = vi.fn();
const runAuditor = vi.fn();
const broadcastEvent = vi.fn();
const getDefaultModel = vi.fn();

// Override runWorker only; keep the real pure helpers (e.g. resolveWorkerBashTimeoutMs
// the worker stage now calls to set bashTimeoutMs — INT-2415).
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return {
    ...actual,
    runReviewer,
  };
});

vi.mock('./documenter.js', async () => {
  const actual = await vi.importActual<typeof import('./documenter.js')>('./documenter.js');
  return { ...actual, runDocumenter };
});

vi.mock('./auditor.js', async () => {
  const actual = await vi.importActual<typeof import('./auditor.js')>('./auditor.js');
  return { ...actual, runAuditor };
});

vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock('../core/eventHub.js', () => ({
  broadcastEvent,
}));

const boardEvents = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { boardEvents.list.push(event); }),
}));

// The deadlock clarification goes through the ask_human path; never page anyone from a test.
const postHumanQuestion = vi.hoisted(() => vi.fn());
vi.mock('../coordination/humanQuestions.js', () => ({ postHumanQuestion }));

// Guards run only when a test sets `config.guards`; passing by default.
const runGuards = vi.hoisted(() => vi.fn());
vi.mock('./pipelineGuards.js', async () => {
  const actual = await vi.importActual<typeof import('./pipelineGuards.js')>('./pipelineGuards.js');
  return { ...actual, runGuards };
});

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

// Split from pairPipeline.test.ts (LOC cap); same mocks.
// AGT-4535: per-finding ids in the revise loop. Same mocks as the blocker tests.
describe('PairPipeline finding ledger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getDefaultModel.mockResolvedValue('codex-live-model');
    postHumanQuestion.mockResolvedValue({ correlationId: 'hq-test', delivered: false, openAskCount: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function task(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'task-findings',
      source: 'linear',
      title: 'findings task',
      description: 'exercise the finding ledger',
      priority: 1,
      createdAt: Date.now(),
      estimatedMinutes: 60,
      ...overrides,
    };
  }

  const config = (maxIterations: number, maxFindingRounds?: number) => ({
    workerSandbox: 'off' as const, stages: ['worker', 'reviewer'] as ('worker' | 'reviewer')[],
    maxIterations,
    maxFindingRounds,
    roles: {
      worker: { enabled: true, model: 'w', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'r', timeoutMs: 0 },
    },
  });

  const worked = (summary: string) => ({
    success: true, summary, filesChanged: ['src/a.ts'], commands: ['npm test'], output: '', confidencePercent: 100,
  });

  it('asks the worker to answer each id and shows the reviewer those answers', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue(worked('F1: fixed — src/a.ts:12 checks the bound'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'one problem', issues: ['range() stops one short'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'F1: resolved' });

    const result = await new PairPipeline(config(5)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    const second = runWorker.mock.calls[1][0] as WorkerOptions;
    expect(second.previousFeedback).toContain('- F1: range() stops one short');
    expect(second.previousFeedback).toContain('F<n>: disputed');
    const reviewerSecond = runReviewer.mock.calls[1][0] as ReviewerOptions;
    expect(reviewerSecond.findingLedger).toContain('worker said fixed (round 2): src/a.ts:12 checks the bound');

    // The ruling instruction is trusted prompt text, outside every data block;
    // the worker's answer stays inside one.
    const { buildReviewerPrompt } = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
    const prompt = buildReviewerPrompt(reviewerSecond);
    // At the start of a line: the diff under review (this repository's own working tree here) quotes it with '> '.
    const heading = prompt.search(/^## Open findings from earlier review rounds/m);
    const before = prompt.slice(0, heading);
    expect(heading).toBeGreaterThan(0);
    // Every data block opened before the heading is closed before it.
    expect(before.split('<openswarm-untrusted-data>').length).toBe(before.split('</openswarm-untrusted-data>').length);
    expect(prompt.slice(heading)).toMatch(/<openswarm-untrusted-data>\n> - F1: range\(\) stops one short\n>.*worker said fixed/);
  });

  it('stops — never approves — when worker and reviewer deadlock on one id', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue(worked('F1: disputed — README.md:4 says the bound is exclusive'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'bound', issues: ['bound is wrong'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong, README is stale'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'fine' });

    const result = await new PairPipeline(config(10, 10)).run(task(), process.cwd());

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(3);
    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(result.lastReviewFeedback).toContain('Review loop stopped (deadlock)');
  });

  it('posts a clarification question to the advisor on deadlock before stopping', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue(worked('F1: disputed — README.md:4 says the bound is exclusive'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'bound', issues: ['bound is wrong'] })
      .mockResolvedValue({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong, README is stale'] });
    const order: string[] = [];
    postHumanQuestion.mockImplementation(async () => {
      order.push('clarification');
      return { correlationId: 'hq-test', delivered: false, openAskCount: 1 };
    });

    const pipeline = new PairPipeline(config(10, 10));
    pipeline.on('iteration:fail', () => order.push('stop'));
    const result = await pipeline.run(task({ issueIdentifier: 'AGT-77' }), process.cwd());

    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(3);
    expect(postHumanQuestion).toHaveBeenCalledTimes(1);
    const asked = postHumanQuestion.mock.calls[0][0] as { questionClass: string; question: string; actorRole: string; taskLabel: string };
    expect(asked.questionClass).toBe('clarification');
    expect(asked.actorRole).toBe('worker');
    expect(asked.taskLabel).toBe('AGT-77');
    expect(asked.question).toContain('deadlocked on F1 (AGT-77)');
    expect(asked.question).toContain('- F1: bound is wrong');
    expect(asked.question).toContain('worker said disputed (round 3): README.md:4 says the bound is exclusive');
    // Asked first, then the same stop as before: never an approval.
    expect(order.slice(-2)).toEqual(['clarification', 'stop']);
    expect(result.lastReviewFeedback).toContain('Review loop stopped (deadlock)');

    // A round-cap stop is not a disagreement to settle; nothing is asked.
    postHumanQuestion.mockClear();
    runWorker.mockReset().mockResolvedValue(worked('tried'));
    runReviewer.mockReset()
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'a', issues: ['missing null check'] })
      .mockResolvedValue({ decision: 'revise', feedback: 'F1: still open', issues: [] });
    expect((await new PairPipeline(config(10, 2)).run(task(), process.cwd())).finalStatus).toBe('failed');
    expect(postHumanQuestion).not.toHaveBeenCalled();
  });

  it('reads F<n> responses from CLI adapter JSON event output', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const { ClaudeCliAdapter } = await import('../adapters/claude.js');
    const { CodexCliAdapter } = await import('../adapters/codex.js');
    const { recordWorkerResponses, createFindingLedger, recordReviewRound } = await import('./findingLedger.js');
    const ndjson = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');
    const raw = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', durationMs: 1 });
    const report = JSON.stringify({ success: true, summary: 'F1: disputed — README.md:4 says the bound is exclusive\nF2: fixed — src/a.ts:12 returns early' });
    const finalText = `Done.\n\`\`\`json\n${report}\n\`\`\``;
    const toolQuote = { type: 'user', message: { content: [{ type: 'tool_result', content: 'F1: fixed — quoted/by/a/tool.ts:1' }] } };

    // A claude stream cut off before its `result` event: the adapter finds no
    // result, so it hands back the raw stream-json as `output` and a summary
    // scraped from it. The answer is the last assistant message, not the tool
    // result that quotes an F1 line.
    const claude = new ClaudeCliAdapter();
    const cutOff = claude.parseWorkerOutput(raw(ndjson([
      { type: 'system', subtype: 'init' },
      toolQuote,
      { type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
    ])));
    expect(cutOff.output).toContain('"type":"assistant"');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue({ ...worked(cutOff.summary), output: cutOff.output });
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'two problems', issues: ['range() stops one short', 'no empty-input check'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'F1: resolved\nF2: resolved' });

    const result = await new PairPipeline(config(5)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    const ledger = (runReviewer.mock.calls[1][0] as ReviewerOptions).findingLedger;
    expect(ledger).toContain('worker said disputed (round 2): README.md:4 says the bound is exclusive');
    expect(ledger).toContain('worker said fixed (round 2): src/a.ts:12 returns early');
    expect(ledger).not.toContain('quoted/by/a/tool.ts');

    // The other adapter outputs read the same answers: a complete claude
    // stream (the adapter returns the result text), the same cut-off stream
    // behind the retention marker, and a codex `exec --json` stream.
    const open = recordReviewRound(createFindingLedger(), { round: 1, decision: 'revise', issues: ['a', 'b'] });
    const answers = (parsed: { summary: string; output: string }) => recordWorkerResponses(open, { round: 2, ...parsed })
      .findings.map((f) => `${f.id} ${f.lastWorkerResponse?.kind} ${f.lastWorkerResponse?.evidence}`);
    const expected = ['F1 disputed README.md:4 says the bound is exclusive', 'F2 fixed src/a.ts:12 returns early'];
    expect(answers(claude.parseWorkerOutput(raw(ndjson([toolQuote, { type: 'result', subtype: 'success', result: finalText }]))))).toEqual(expected);
    expect(answers({ summary: cutOff.summary, output: `[openswarm: 99 earlier characters of output were not retained]\n${cutOff.output}` })).toEqual(expected);
    const codex = new CodexCliAdapter().parseWorkerOutput(raw(ndjson([
      { type: 'thread.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'F1: fixed — early.ts:1' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } },
      { type: 'item.completed', item: { type: 'agent_message', text: finalText } },
    ])));
    expect(answers(codex)).toEqual(expected);
  });

  it('continues the ids of an earlier run of the same issue from the coordination thread', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const durable = (maxIterations: number) => ({
      ...config(maxIterations, 10),
      runMetadata: { coordinationRepository: '/repo/durable-ledger', repoKey: 'durable-ledger-key' },
    });
    const issue = task({ id: `task-durable-${Date.now()}`, issueIdentifier: 'AGT-88' });
    runWorker.mockResolvedValue(worked('first pass'));
    runReviewer.mockResolvedValue({ decision: 'revise', feedback: 'bound', issues: ['range() stops one short'] });
    expect((await new PairPipeline(durable(1)).run(issue, process.cwd())).finalStatus).toBe('failed');

    // A new process: the run starts over at iteration 1, the ledger does not.
    runWorker.mockReset().mockResolvedValue(worked('F1: disputed — README.md:4 says the bound is exclusive'));
    runReviewer.mockReset()
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong', 'no empty-input test'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'F1: resolved\nF2: resolved' });
    expect((await new PairPipeline(durable(3)).run(issue, process.cwd())).finalStatus).toBe('approved');

    const firstWorker = runWorker.mock.calls[0][0] as WorkerOptions;
    expect(firstWorker.previousFeedback).toContain('- F1: range() stops one short');
    const reviewerFirst = runReviewer.mock.calls[0][0] as ReviewerOptions;
    expect(reviewerFirst.findingLedger).toContain('worker said disputed (round 2): README.md:4');
    const reviewerSecond = runReviewer.mock.calls[1][0] as ReviewerOptions;
    expect(reviewerSecond.findingLedger).toContain('- F2: no empty-input test');
  });

  it('stops at the round cap while an id stays open', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('tried'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'a', issues: ['missing null check'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: still open — null check absent', issues: [] })
      .mockResolvedValue({ decision: 'approve', feedback: 'fine' });

    const result = await new PairPipeline(config(10, 2)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(2);
    expect(result.lastReviewFeedback).toContain('Review loop stopped (round_cap)');
  });

  it('downgrades an approve that rules a known open id open, bounded by the round cap', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('F1: fixed — src/a.ts:12'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'bound', issues: ['range() stops one short'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'LGTM\nF1: open — still stops one short' });

    const result = await new PairPipeline(config(10, 3)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(3);
    const third = runWorker.mock.calls[2][0] as WorkerOptions;
    expect(third.previousFeedback).toContain('downgraded to revise');
    expect(result.lastReviewFeedback).toContain('Review loop stopped (round_cap)');
  });

  it('renames this session\'s ids to prev-F<n> in the feedback carried to the next attempt', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('tried'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'a', issues: ['missing null check'] })
      .mockResolvedValue({ decision: 'revise', feedback: 'F1: open — null check absent', issues: [] });

    const result = await new PairPipeline(config(10, 2)).run(task(), process.cwd());

    expect(result.lastReviewFeedback).toContain('prev-F1: open');
    expect(result.lastReviewFeedback).toContain('- prev-F1: missing null check');
    expect(result.lastReviewFeedback).not.toMatch(/(?<![\w-])F1\b/);
  });

  it('keeps feeding open ids to the worker after a guard failure skips the review', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runGuards
      .mockResolvedValueOnce({ allPassed: true, results: [] })
      .mockResolvedValueOnce({ allPassed: false, results: [{ guard: 'qualityGate', passed: false, blocking: true, issues: ['lint: x'] }] })
      .mockResolvedValue({ allPassed: true, results: [] });
    runWorker.mockResolvedValue(worked('F1: fixed — src/a.ts:12'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'bound', issues: ['range() stops one short'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'F1: resolved' });

    const result = await new PairPipeline({ workerSandbox: 'off', ...config(5), guards: { qualityGate: true } }).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    expect(runReviewer).toHaveBeenCalledTimes(2);
    const third = runWorker.mock.calls[2][0] as WorkerOptions;
    expect(third.previousFeedback).toContain('lint: x');
    expect(third.previousFeedback).toContain('- F1: range() stops one short');
  });

  it('keeps the old free-text path when the reviewer gives no structured issues', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('tried'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'tighten the loop' })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'handle the empty case' })
      .mockResolvedValue({ decision: 'approve', feedback: 'ok' });

    const result = await new PairPipeline(config(5, 1)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    const second = runWorker.mock.calls[1][0] as WorkerOptions;
    expect(second.previousFeedback).not.toContain('Open review findings');
  });
});
