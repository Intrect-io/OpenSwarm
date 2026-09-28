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

// Discord caps a single field value at 1024 and an embed's parts at 6000 in
// total, and the embed builder THROWS on the former while the API rejects the
// latter outright — either way the whole report is lost, not trimmed. The
// per-field slices bound each contribution but not their sum, and `stages`
// (one line per stage per iteration) had no bound at all. (AGT-3422)
describe('formatPipelineResult aggregate budget (AGT-3422)', () => {
  const stageAt = (i: number): PipelineResult['stages'][number] => ({
    stage: 'worker',
    success: true,
    result: { success: true, summary: 's', filesChanged: [], commands: [], output: 'o' },
    duration: 1000 + i,
    startedAt: 1000 + i,
    completedAt: 2000 + i,
  });

  const isStage = (s: PipelineResult['stages'][number]) => {
    const duration = (s.duration / 1000).toFixed(1);
    const time = new Date(s.startedAt).toLocaleTimeString('en-GB', { hour12: false });
    return `${s.success ? '✅' : '❌'} **${s.stage}** (${duration}s) @ ${time}`;
  };

  /**
   * Every input near its per-field maximum — the shape the slices cannot bound.
   * The title defaults past the embed description ceiling (4096) so that clamp is
   * exercised too; callers that care about the message headline pass a
   * realistic issue title instead.
   */
  const wideResult = (taskTitle = 't'.repeat(4000)): PipelineResult => baseResult({
    finalStatus: 'rejected',
    stages: Array.from({ length: 200 }, (_, i) => stageAt(i)),
    taskContext: {
      projectName: 'OpenSwarm',
      issueIdentifier: 'INT-3422',
      taskTitle,
    },
    workerResult: {
      success: true,
      summary: 'summary '.repeat(100),
      filesChanged: Array.from({ length: 40 }, (_, i) => `src/${'deep/nested/dir/'.repeat(10)}file-${i}.ts`),
      commands: [],
      output: 'o',
    },
    reviewResult: { decision: 'revise', feedback: 'feedback '.repeat(200), issues: ['a', 'b'] },
    testerResult: {
      success: false,
      testsPassed: 1,
      testsFailed: 9,
      output: '',
      failedTests: Array.from({ length: 9 }, (_, i) => `suite/case-${i}.spec.ts > ${'fails '.repeat(80)}`),
    },
    prUrl: 'https://github.com/org/repo/pull/1',
  });

  /** The one thing the test cannot control is the host timezone; nothing else is stripped. */
  const stripClock = (s: string) => s.replace(/\d{2}:\d{2}:\d{2}/g, 'HH:MM:SS');

  it('keeps a wide embed inside the 6000 total and the 1024 per-field ceiling, marked and with stats intact', () => {
    const embed = formatPipelineResultEmbed(wideResult());
    const data = embed.data;

    expect(embed.length).toBeLessThanOrEqual(6000);
    for (const field of data.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(stripClock(data.description ?? '').length).toBeLessThanOrEqual(4096);

    // Clipped rather than silently short.
    expect((data.fields ?? []).some((f) => /\.\.\.\(\d+ chars omitted\)/.test(f.value))).toBe(true);

    // The summary stats are short and are what a report is read for: pinned.
    const byName = new Map((data.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.get('🔄 Iterations')).toBe('2');
    expect(byName.get('⏱️ Duration')).toBe('5.0s');
    expect(byName.get('💰 Cost')).toBe('N/A');
    expect(data.footer!.text).toBe('Session: session-...');
  });

  it('keeps a wide message inside the 2000 content limit, marked, with the header intact', () => {
    const text = formatPipelineResult(wideResult('Reject the oversize pipeline report'));

    expect(text.length).toBeLessThanOrEqual(2000);
    // Clipping keeps the start, so the context header and the status line — the
    // point of the message — survive even when the tail is dropped.
    expect(text.startsWith('📁 OpenSwarm | 🔖 INT-3422')).toBe(true);
    expect(text).toContain('❌ **Pipeline REJECTED**');
    expect(text).toMatch(/\.\.\.\(\d+ chars omitted\)$/);
  });

  it('clamps the SUM last: a result that busts 6000 even with every field legal comes back inside it', () => {
    // Every field individually legal (<= 1024) and the description legal
    // (<= 4096), yet the parts still sum past 6000 — the case no per-field slice
    // can see. The final pass must trim and say so, not hand the API an embed it
    // rejects whole.
    const stages = Array.from({ length: 200 }, (_, i) => stageAt(i));
    const embed = formatPipelineResultEmbed(baseResult({
      finalStatus: 'rejected',
      stages,
      taskContext: { projectName: 'OpenSwarm', issueIdentifier: 'INT-3422', taskTitle: 't'.repeat(8000) },
      workerResult: {
        success: true, summary: 'w'.repeat(4000),
        filesChanged: Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`), commands: [], output: 'o',
      },
      reviewResult: { decision: 'revise', feedback: 'r'.repeat(4000), issues: ['a', 'b'] },
      testerResult: {
        success: false, testsPassed: 0, testsFailed: 9, output: '',
        failedTests: Array.from({ length: 9 }, (_, i) => `c${i} > ${'f'.repeat(200)}`),
      },
      prUrl: 'https://github.com/org/repo/pull/1',
    }));
    const data = embed.data;

    expect(embed.length).toBeLessThanOrEqual(6000);
    for (const field of data.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(stripClock(data.description ?? '').length).toBeLessThanOrEqual(4096);

    // What was trimmed says so, and the count folds every step so the arithmetic
    // still reaches the string that went in.
    const stagesField = data.fields!.find((f) => f.name === '📊 Stages')!;
    const marker = /\.\.\.\((\d+) chars omitted\)$/.exec(stagesField.value);
    expect(marker).not.toBeNull();
    const raw = stages.map(isStage).join('\n');
    expect(stagesField.value.length - marker![0].length + Number(marker![1])).toBe(raw.length);

    // The summary stats survive the trim: they are short and are the first thing
    // a report is read for.
    const byName = new Map((data.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.get('🔄 Iterations')).toBe('2');
    expect(byName.get('⏱️ Duration')).toBe('5.0s');
    expect(byName.get('💰 Cost')).toBe('N/A');
  });

  it('leaves a normal result byte-identical: no marker, same composed output', () => {
    const result = baseResult({
      workerResult: {
        success: true, summary: 'did the work', filesChanged: ['src/a.ts', 'src/b.ts'], commands: [], output: 'o',
      },
      reviewResult: { decision: 'approve', feedback: 'looks good', issues: [] },
      testerResult: { success: true, testsPassed: 12, testsFailed: 0, coverage: 88.25, output: '' },
      prUrl: 'https://github.com/org/repo/pull/7',
    });

    const text = stripClock(formatPipelineResult(result));
    expect(text).toBe([
      '✅ **Pipeline APPROVED**',
      '',
      '**Session:** `session-abc-123`',
      '**Iterations:** 2',
      '**Duration:** 5.0s',
      '',
      '**Stages:**',
      '  ✅ worker (1.2s) @ HH:MM:SS',
      '  ❌ reviewer (0.5s) @ HH:MM:SS',
    ].join('\n'));
    expect(text).not.toContain('chars omitted');

    const data = formatPipelineResultEmbed(result).data;
    expect(data.description).toBeUndefined();
    expect(data.title).toBe('✅ Pipeline SUCCESS');
    expect(data.footer!.text).toBe('Session: session-...');
    expect((data.fields ?? []).map((f) => ({ name: f.name, value: stripClock(f.value), inline: f.inline ?? false })))
      .toEqual([
        { name: '🔄 Iterations', value: '2', inline: true },
        { name: '⏱️ Duration', value: '5.0s', inline: true },
        { name: '💰 Cost', value: 'N/A', inline: true },
        { name: '📊 Stages', value: '✅ **worker** (1.2s) @ HH:MM:SS\n❌ **reviewer** (0.5s) @ HH:MM:SS', inline: false },
        { name: '🔨 Worker', value: 'did the work\n\n**Files:** `src/a.ts`, `src/b.ts`', inline: false },
        { name: '✅ Reviewer', value: '**Decision:** APPROVE\n\nlooks good', inline: false },
        { name: '🧪 Tests', value: '✅ Passed: 12/12 (100.0%)\n📊 Coverage: 88.3%', inline: false },
        { name: '🔗 Pull Request', value: '[View PR](https://github.com/org/repo/pull/7)', inline: false },
      ]);
  });

  it('bounds the stages field at every stage count, untouched at or below the ceiling and honestly counted above it', () => {
    // Sweep the boundary densely rather than 1..400: the property can only
    // change where the raw value crosses 1024, and 400 full renders cost ~6.5 s
    // for no extra coverage (the crossing is between 33 and 34 stages). Below
    // and far above are sampled; the crossing neighbourhood is exhaustive.
    const counts = [
      1, 2, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 50, 64, 100, 200, 400,
    ];
    for (const n of counts) {
      const stages = Array.from({ length: n }, (_, i) => stageAt(i));
      const raw = stages.map(isStage).join('\n');
      const value = formatPipelineResultEmbed(baseResult({ stages }))
        .data.fields!.find((f) => f.name === '📊 Stages')!.value;

      expect(value.length).toBeLessThanOrEqual(1024);

      const marker = /\.\.\.\((\d+) chars omitted\)$/.exec(value);
      if (raw.length <= 1024) {
        expect(value).toBe(raw);
      } else {
        expect(marker).not.toBeNull();
        // The count is the real remainder: kept + dropped is the value that went in.
        expect(value.length - marker![0].length + Number(marker![1])).toBe(raw.length);
      }
    }
  });
});
