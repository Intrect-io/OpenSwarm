// Purpose: cover formatPipelineResult / formatPipelineResultEmbed (Discord message +
// embed formatting for pipeline results). Pure formatting functions — no mocking needed.
import { describe, it, expect } from 'vitest';
import { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
import type { PipelineResult } from './pairPipelineTypes.js';

function baseResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    success: true,
    sessionId: 'session-abc-123',
    stages: [
      { stage: 'worker', success: true, result: { success: true, summary: 's', filesChanged: [], commands: [], output: 'o' }, duration: 1234, startedAt: 1000, completedAt: 2234 },
      { stage: 'reviewer', success: false, result: { decision: 'reject', feedback: 'nope' }, duration: 500, startedAt: 2234, completedAt: 2734 },
    ],
    finalStatus: 'approved',
    totalDuration: 5000,
    iterations: 2,
    ...overrides,
  };
}

describe('formatPipelineResult (Discord plain-text message)', () => {
  it('renders header, session, iterations, duration and stage list', () => {
    const text = formatPipelineResult(baseResult());
    expect(text).toContain('Pipeline APPROVED');
    expect(text).toContain('session-abc-123');
    expect(text).toContain('**Iterations:** 2');
    expect(text).toContain('**Duration:** 5.0s');
    expect(text).toContain('worker');
    expect(text).toContain('reviewer');
  });

  it('maps each finalStatus to its emoji', () => {
    const statuses: PipelineResult['finalStatus'][] = [
      'approved', 'rejected', 'failed', 'cancelled', 'decomposed', 'deferred', 'rate_limited', 'infra_error',
    ];
    const emojis = ['✅', '❌', '💥', '🚫', '🔀', '⏳', '⏸', '🔌'];
    statuses.forEach((status, i) => {
      const text = formatPipelineResult(baseResult({ finalStatus: status }));
      expect(text).toContain(`${emojis[i]} **Pipeline ${status.toUpperCase()}**`);
    });
  });

  it('includes cost line when totalCost is present', () => {
    const text = formatPipelineResult(baseResult({
      totalCost: { costUsd: 0.1234, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1000 },
    }));
    expect(text).toContain('**Cost:** $0.1234');
  });

  it('omits cost line when totalCost is absent', () => {
    const text = formatPipelineResult(baseResult());
    expect(text).not.toContain('**Cost:**');
  });

  it('renders task context header with projectName, issueIdentifier and taskTitle', () => {
    const text = formatPipelineResult(baseResult({
      taskContext: {
        projectName: 'OpenSwarm',
        issueIdentifier: 'INT-1234',
        projectPath: '/home/user/dev/OpenSwarm',
        taskTitle: 'Fix the bug',
      },
    }));
    expect(text).toContain('📁 OpenSwarm');
    expect(text).toContain('🔖 INT-1234');
    expect(text).toContain('`dev/OpenSwarm`');
    expect(text).toContain('📋 Fix the bug');
  });

  it('falls back to deriving displayName from projectPath when projectName is missing', () => {
    const text = formatPipelineResult(baseResult({
      taskContext: { projectPath: '/home/user/dev/MyRepo' },
    }));
    expect(text).toContain('📁 MyRepo');
  });

  it('omits the context header line entirely when taskContext has no usable fields', () => {
    const text = formatPipelineResult(baseResult({ taskContext: {} }));
    // No context lines should be injected before the status line.
    const statusLineIdx = text.indexOf('**Pipeline APPROVED**');
    expect(text.slice(0, statusLineIdx)).not.toContain('📁');
    expect(text.slice(0, statusLineIdx)).not.toContain('📋');
  });

  it('formats each stage line with emoji, name, duration and timestamp', () => {
    const text = formatPipelineResult(baseResult());
    const lines = text.split('\n');
    const workerLine = lines.find((l) => l.includes('worker') && l.includes('✅'));
    const reviewerLine = lines.find((l) => l.includes('reviewer') && l.includes('❌'));
    expect(workerLine).toMatch(/✅ worker \(1\.2s\) @ \d{2}:\d{2}:\d{2}/);
    expect(reviewerLine).toMatch(/❌ reviewer \(0\.5s\) @ \d{2}:\d{2}:\d{2}/);
  });

  it('handles an empty stages array', () => {
    const text = formatPipelineResult(baseResult({ stages: [] }));
    expect(text).toContain('**Stages:**');
    expect(text.trim().endsWith('**Stages:**')).toBe(true);
  });
});

describe('formatPipelineResultEmbed (Discord embed)', () => {
  it('sets title/color for a known finalStatus and adds iteration/duration/cost fields', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      totalCost: { costUsd: 0.5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1 },
    }));
    const data = embed.data;
    expect(data.title).toBe('✅ Pipeline SUCCESS');
    expect(data.color).toBe(0x00FF00);
    const fieldNames = (data.fields || []).map((f) => f.name);
    expect(fieldNames).toContain('🔄 Iterations');
    expect(fieldNames).toContain('⏱️ Duration');
    expect(fieldNames).toContain('💰 Cost');
    const costField = data.fields!.find((f) => f.name === '💰 Cost');
    expect(costField!.value).toContain('$0.5000');
  });

  it('shows "N/A" cost when totalCost is absent', () => {
    const embed = formatPipelineResultEmbed(baseResult());
    const costField = embed.data.fields!.find((f) => f.name === '💰 Cost');
    expect(costField!.value).toBe('N/A');
  });

  it('falls back to UNKNOWN styling for an unrecognized finalStatus', () => {
    const embed = formatPipelineResultEmbed(baseResult({ finalStatus: 'some_bogus_status' as PipelineResult['finalStatus'] }));
    expect(embed.data.title).toBe('❓ Pipeline UNKNOWN');
    expect(embed.data.color).toBe(0x808080);
  });

  it('sets description from projectName + issueIdentifier when both are present', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      taskContext: { projectName: 'OpenSwarm', issueIdentifier: 'INT-9', taskTitle: 'Do the thing' },
    }));
    expect(embed.data.description).toContain('OpenSwarm');
    expect(embed.data.description).toContain('INT-9');
    expect(embed.data.description).toContain('Do the thing');
  });

  it('sets description from taskTitle alone when projectName/issueIdentifier are missing', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      taskContext: { taskTitle: 'Just a title' },
    }));
    expect(embed.data.description).toBe('Just a title');
  });

  it('renders "No stages" when stages is empty', () => {
    const embed = formatPipelineResultEmbed(baseResult({ stages: [] }));
    const stagesField = embed.data.fields!.find((f) => f.name === '📊 Stages');
    expect(stagesField!.value).toBe('No stages');
  });

  it('adds a Worker field with summary and truncated file list (+more)', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      workerResult: {
        success: true,
        summary: 'x'.repeat(250),
        filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        commands: [],
        output: 'o',
      },
    }));
    const workerField = embed.data.fields!.find((f) => f.name === '🔨 Worker');
    expect(workerField).toBeDefined();
    expect(workerField!.value).toContain('...');
    expect(workerField!.value).toContain('+1 more');
  });

  it('omits the Worker field entirely when workerResult has no summary/files', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      workerResult: { success: true, summary: '', filesChanged: [], commands: [], output: '' },
    }));
    expect(embed.data.fields!.find((f) => f.name === '🔨 Worker')).toBeUndefined();
  });

  it('adds a Reviewer field with decision, truncated feedback, and issue count', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      reviewResult: { decision: 'revise', feedback: 'y'.repeat(350), issues: ['i1', 'i2'] },
    }));
    const reviewField = embed.data.fields!.find((f) => f.name === '✅ Reviewer');
    expect(reviewField!.value).toContain('REVISE');
    expect(reviewField!.value).toContain('...');
    expect(reviewField!.value).toContain('Issues found:** 2');
  });

  it('adds a Tests field with pass rate, coverage, and truncated failed-test list', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      testerResult: {
        success: false,
        testsPassed: 7,
        testsFailed: 3,
        coverage: 42.567,
        output: '',
        failedTests: ['t1', 't2', 't3'],
      },
    }));
    const testField = embed.data.fields!.find((f) => f.name === '🧪 Tests');
    expect(testField!.value).toContain('7/10 (70.0%)');
    expect(testField!.value).toContain('Coverage: 42.6%');
    expect(testField!.value).toContain('❌ t1');
    expect(testField!.value).toContain('+1 more');
  });

  it('shows 0% pass rate when there are zero total tests', () => {
    const embed = formatPipelineResultEmbed(baseResult({
      testerResult: { success: true, testsPassed: 0, testsFailed: 0, output: '' },
    }));
    const testField = embed.data.fields!.find((f) => f.name === '🧪 Tests');
    expect(testField!.value).toContain('0/0 (0%)');
  });

  it('adds a Pull Request field with a markdown link when prUrl is set', () => {
    const embed = formatPipelineResultEmbed(baseResult({ prUrl: 'https://github.com/org/repo/pull/1' }));
    const prField = embed.data.fields!.find((f) => f.name === '🔗 Pull Request');
    expect(prField!.value).toBe('[View PR](https://github.com/org/repo/pull/1)');
  });

  it('sets a footer with the truncated session id', () => {
    const embed = formatPipelineResultEmbed(baseResult());
    expect(embed.data.footer!.text).toBe('Session: session-...');
  });
});
