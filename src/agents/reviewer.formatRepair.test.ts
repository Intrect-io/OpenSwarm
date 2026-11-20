// The reviewer asks for the format repair, and only where its verdict shape
// applies (AGT-4313 / AGT-4413). The loop-side behaviour is pinned in
// adapters/agenticLoop.formatRepair.test.ts; this pins the wiring between them.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runReviewer, REVIEWER_FORMAT_REPAIR_PROMPT } from './reviewer.js';
import * as adapters from '../adapters/index.js';
import { parseReviewerResult } from '../adapters/resultParsing.js';
import type { CliRunOptions } from '../adapters/types.js';
import { initLocale } from '../locale/index.js';

const PROSE = 'I read src/a.ts. The retry at src/a.ts:42 swallows the error and the caller never sees it.';
const REPAIRED =
  '```json\n{"decision": "revise", "feedback": "One defect.", "issues": ["src/a.ts:42 swallows the error"]}\n```';

/**
 * A spawnCli double that behaves like the agentic loop's last step: the model
 * ends in prose, and if — and only if — the caller asked for a format repair
 * that wants this text repaired, it answers the repair prompt with JSON.
 */
function loopDouble() {
  const seen: { repair?: CliRunOptions['finalAnswerRepair'] } = {};
  vi.spyOn(adapters, 'spawnCli').mockImplementation(async (_adapter, opts) => {
    seen.repair = opts.finalAnswerRepair;
    const repaired = opts.finalAnswerRepair?.needsRepair(PROSE) ? REPAIRED : PROSE;
    return { exitCode: 0, stdout: repaired, stderr: '', durationMs: 1 } as never;
  });
  vi.spyOn(adapters, 'getAdapter').mockReturnValue({
    name: 'openrouter',
    getDefaultModel: async () => 'm',
    parseReviewerOutput: (raw: { stdout: string }) => parseReviewerResult(raw.stdout),
  } as never);
  return seen;
}

const base = {
  taskTitle: 't',
  taskDescription: 'd',
  workerResult: { success: true, summary: 's', filesChanged: ['src/a.ts'], commands: [], output: '' },
  projectPath: '/tmp',
};

describe('runReviewer format repair wiring (AGT-4313)', () => {
  beforeAll(() => { initLocale('en'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['change', 'direct', 'audit', undefined] as const)(
    'asks the loop for one format repair in %s mode, so a prose-only reviewer still yields a decision',
    async (mode) => {
      const seen = loopDouble();
      const result = await runReviewer({ ...base, mode });
      expect(seen.repair?.prompt).toBe(REVIEWER_FORMAT_REPAIR_PROMPT);
      expect(seen.repair?.acceptRepair).toBeTypeOf('function');
      expect(result.decision).toBe('revise');
      expect(result.issues).toEqual(['src/a.ts:42 swallows the error']);
    },
  );

  it('does not ask for a repair in blocker mode, where approve means "claim confirmed"', async () => {
    const seen = loopDouble();
    await expect(runReviewer({ ...base, mode: 'blocker', blockerClaim: 'cannot be done' }))
      .rejects.toThrow(/reviewer-stage: produced no parseable verdict: .*carried no verdict/);
    expect(seen.repair).toBeUndefined();
  });
});
