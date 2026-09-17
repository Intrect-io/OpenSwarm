import { describe, expect, it } from 'vitest';
import { fitPromptSections, WORKER_PROMPT_BUDGET_CHARS, type PromptSection } from './promptBudget.js';
import { WORKER_PROMPT_EVICTION_ORDER } from './promptSections.js';
import { enPrompts } from './en.js';
import { koPrompts } from './ko.js';
import type { WorkerContext } from '../types.js';

const notice = (dropped: readonly string[], truncated: readonly string[]): string =>
  `## withheld\ndropped=${dropped.join(',')} truncated=${truncated.join(',')}\n`;
const options = { evictionOrder: ['c', 'b', 'a'], notice, truncationMarker: '\n[cut]' };

function section(id: string, chars: number, evictable = true): PromptSection {
  return { id, evictable, text: `${id}:${'x'.repeat(chars)}` };
}

describe('fitPromptSections (AGT-4151)', () => {
  it('leaves a prompt that fits untouched, with no notice', () => {
    const fitted = fitPromptSections([section('core', 100, false), section('a', 100)], { ...options, budget: 10_000 });
    expect(fitted).toEqual({ text: `${section('core', 100, false).text}\n${section('a', 100).text}`, dropped: [], truncated: [] });
  });

  it('drops evictable sections whole, most disposable first, and stops as soon as the rest fits', () => {
    const fitted = fitPromptSections(
      [section('core', 1_000, false), section('a', 3_000), section('b', 3_000), section('c', 3_000)],
      { ...options, budget: 8_000 },
    );
    // 10k of data against 8k less the 1k notice reserve: dropping c (→7k)
    // is not enough, dropping b (→4k) is. a survives in its original place.
    expect(fitted.dropped).toEqual(['c', 'b']);
    expect(fitted.truncated).toEqual([]);
    expect(fitted.text.startsWith('core:')).toBe(true);
    expect(fitted.text).toContain('\na:');
    expect(fitted.text).not.toContain('\nb:');
    expect(fitted.text).toContain('dropped=c,b truncated=');
    expect(fitted.text.length).toBeLessThanOrEqual(8_000);
  });

  it('never drops a non-evictable section, or an evictable one missing from the order', () => {
    const fitted = fitPromptSections(
      [section('core', 5_000, false), section('unlisted', 5_000), section('a', 5_000)],
      { ...options, budget: 12_000 },
    );
    expect(fitted.dropped).toEqual(['a']);
    expect(fitted.text).toContain('\nunlisted:');
    expect(fitted.text.length).toBeLessThanOrEqual(12_000);
  });

  it('cuts non-evictable sections from the last one backwards once nothing is left to drop', () => {
    const fitted = fitPromptSections(
      [section('task', 4_000, false), section('a', 2_000), section('dod', 4_000, false)],
      { ...options, budget: 6_000 },
    );
    expect(fitted.dropped).toEqual(['a']);
    expect(fitted.truncated).toEqual(['dod']);
    // The task is intact; the DoD carries the in-place marker; the total holds.
    expect(fitted.text).toContain(section('task', 4_000, false).text);
    expect(fitted.text).toContain('dod:');
    expect(fitted.text).toContain('[cut]');
    expect(fitted.text.length).toBeLessThanOrEqual(6_000);
  });

  it('holds the ceiling no matter how many sections there are', () => {
    const many = Array.from({ length: 200 }, (_, i) => section(`s${i}`, 5_000, i % 2 === 0));
    const fitted = fitPromptSections(many, { ...options, budget: 50_000 });
    expect(fitted.text.length).toBeLessThanOrEqual(50_000);
    // Only the listed ids may be dropped; the rest of the overage is cut in place.
    expect(fitted.dropped).toEqual([]);
    expect(fitted.truncated.length).toBeGreaterThan(0);
  });
});

/** A context whose every collection is at its per-item cap — the shape the per-item caps cannot bound. */
function oversizedContext(): WorkerContext {
  const big = (label: string) => `${label} ${'y'.repeat(20_000)}`;
  return {
    fileScope: ['src/a.ts'],
    repository: { workspaces: [], manifests: ['package.json'], verificationCommands: [big('cmd')], sharedPaths: [], dependencyGraphAvailable: true },
    siblingWork: [{ identifier: 'INT-1', files: [big('sibling')] }],
    repoMemories: Array.from({ length: 6 }, (_, i) => ({ type: 'pattern', title: `memory ${i}`, content: big('memory') })),
    draftAnalysis: {
      taskType: 'fix', intentSummary: big('intent'), suggestedApproach: big('approach'), relevantFiles: [],
      completionCriteria: ['criterion one', 'criterion two'], sufficient: true,
    },
    impactAnalysis: { directModules: [big('direct')], dependentModules: [], testFiles: [], estimatedScope: 'small' },
    registryBriefs: Array.from({ length: 3 }, (_, i) => ({ filePath: `src/f${i}.ts`, summary: big('summary'), highlights: [] })),
  };
}

describe.each([
  ['en', enPrompts, 'Context withheld', 'Sections dropped whole'],
  ['ko', koPrompts, '보류된 컨텍스트', '통째로 제외된 섹션'],
] as const)('buildWorkerPrompt aggregate budget — %s (AGT-4151)', (_locale, prompts, noticeHeading, droppedLabel) => {
  it('keeps the prompt under the budget with every collection oversized, evicting in the documented order', () => {
    const prompt = prompts.buildWorkerPrompt({
      taskTitle: 'title', taskDescription: 'description', previousFeedback: 'fix the tests', context: oversizedContext(),
    });
    // The static rules that follow the budgeted sections are the only thing
    // outside the ceiling, and they are a few thousand characters.
    expect(prompt.length).toBeLessThanOrEqual(WORKER_PROMPT_BUDGET_CHARS + 6_000);
    expect(prompt).toContain(noticeHeading);
    // Registry briefs and repo memories go first; the task, the boundary, the
    // feedback and the DoD are all still there.
    const droppedLine = prompt.split('\n').find((line) => line.includes(droppedLabel)) ?? '';
    expect(droppedLine).toContain(WORKER_PROMPT_EVICTION_ORDER[0]);
    expect(droppedLine).toContain(WORKER_PROMPT_EVICTION_ORDER[1]);
    expect(droppedLine.indexOf('registry-briefs')).toBeLessThan(droppedLine.indexOf('repo-memories'));
    for (const kept of ['> title', '> description', '> fix the tests', '> src/a.ts', '> criterion one', '> criterion two']) {
      expect(prompt).toContain(kept);
    }
  });

  it('adds no notice and changes nothing when the context fits', () => {
    const prompt = prompts.buildWorkerPrompt({
      taskTitle: 'title', taskDescription: 'description',
      context: { fileScope: ['src/a.ts'], repoMemories: [{ type: 'pattern', title: 'm', content: 'c' }] },
    });
    expect(prompt).not.toContain(noticeHeading);
    expect(prompt).toContain('> m');
  });
});
