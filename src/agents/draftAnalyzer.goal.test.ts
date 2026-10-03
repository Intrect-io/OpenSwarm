import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter, CliRunResult } from '../adapters/types.js';
import { parseDraftResponse, runDraftAnalysis } from './draftAnalyzer.js';
import * as adapterModule from '../adapters/index.js';
import * as knowledgeModule from '../knowledge/index.js';
import * as registryModule from '../registry/sqliteStore.js';

// The project goal reaches the drafter's prompt, and a confident decline ends the
// retry loop even though a decline has no files or criteria by design (AGT-4662).
describe('runDraftAnalysis with a project goal (AGT-4662)', () => {
  const adapter = {
    name: 'codex',
    capabilities: { supportsStreaming: true, supportsJsonOutput: true, supportsModelSelection: true, managedGit: false, supportedSkills: [] },
    isAvailable: vi.fn(async () => true),
    getDefaultModel: vi.fn(async () => 'default-model'),
    buildCommand: () => ({ command: 'echo', args: [] }),
    parseWorkerOutput: vi.fn(),
    parseReviewerOutput: vi.fn(),
  } as unknown as CliAdapter;

  const sufficient = JSON.stringify({
    taskType: 'feature', intentSummary: 'Wire the ledger comparison into the report',
    relevantFiles: ['a.ts'], suggestedApproach: 'Extend the existing comparison module and call it.',
    completionCriteria: ['comparison is invoked from the report (cite the call site)', 'test covers the mismatch path'],
  });
  const decline = JSON.stringify({
    taskType: 'feature', intentSummary: '', relevantFiles: [], suggestedApproach: '', completionCriteria: [],
    scope: {
      applicable: false, kind: 'wrong_repository', confidence: 0.95,
      reason: 'The runtime this task names lives in kyte-portal.',
      evidence: ['no bin/kyte-chat-daemon in this repository', 'no KYTE_PYTHON reference in this repository'],
    },
  });

  function spawnReturning(stdout: string): { prompts: string[]; calls: () => number } {
    const prompts: string[] = [];
    vi.spyOn(adapterModule, 'spawnCli').mockImplementation(async (_adapter, options) => {
      prompts.push(options.prompt);
      await options.finishValidator?.(stdout, 1);
      return { exitCode: 0, stdout, stderr: '', durationMs: 1 } as CliRunResult;
    });
    return { prompts, calls: () => prompts.length };
  }

  beforeEach(() => {
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(null);
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue({
      getStats: vi.fn(() => ({ total: 0, deprecated: 0, untested: 0, withWarnings: 0, highRisk: 0 })),
      highRiskEntities: vi.fn(() => []),
      fileBrief: vi.fn(() => ({ filePath: 'a.ts', summary: 'ok', entities: [] })),
    } as never);
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(adapter);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const task = { taskTitle: 'Reconcile the card ledger', taskDescription: 'd', projectPath: '/tmp/project' };

  it('puts the goal and the scope question in the prompt', async () => {
    const spawn = spawnReturning(sufficient);
    await runDraftAnalysis({ ...task, projectGoal: 'Reconcile ledgers in dependency order, to a usable level.' });
    const [prompt] = spawn.prompts;
    expect(prompt).toContain('## Standing project goal');
    expect(prompt).toContain('Reconcile ledgers in dependency order, to a usable level.');
    expect(prompt).toContain('"scope"');
    expect(prompt).toContain('### scope');
  });

  it('adds neither the goal nor the scope question without a goal', async () => {
    const spawn = spawnReturning(sufficient);
    await runDraftAnalysis(task);
    const [prompt] = spawn.prompts;
    expect(prompt).not.toContain('Standing project goal');
    expect(prompt).not.toContain('"scope"');
    expect(prompt).not.toContain('### scope');
    // The JSON block still closes right after the last field it always had.
    expect(prompt).toContain('"duplicateEvidence": ["optional concrete requirement/code overlap evidence"]\n}');
  });

  it('returns a confident decline without retrying for the files and criteria a decline cannot have', async () => {
    const spawn = spawnReturning(decline);
    const draft = await runDraftAnalysis({ ...task, projectGoal: 'Ship usable ledger work.' });
    expect(draft.scope).toMatchObject({ kind: 'wrong_repository', confidence: 0.95 });
    expect(spawn.calls()).toBe(1);
    // A decline is settled, not a sufficient brief: the flag keeps its old meaning.
    expect(draft.sufficient).toBe(false);
  });

  it('keeps retrying when the decline is too weak to act on', async () => {
    const weak = JSON.stringify({
      taskType: 'feature', intentSummary: '', relevantFiles: [], suggestedApproach: '', completionCriteria: [],
      scope: { applicable: false, kind: 'out_of_goal', confidence: 0.6, reason: 'Maybe unrelated.', evidence: ['one thing'] },
    });
    const spawn = spawnReturning(weak);
    await runDraftAnalysis({ ...task, projectGoal: 'Ship usable ledger work.' });
    // The first call plus the fresh retry for an unsatisfied brief.
    expect(spawn.calls()).toBeGreaterThan(1);
  });
});

describe('parseDraftResponse scope (AGT-4662)', () => {
  it('carries a well-formed decline and ignores a malformed one', () => {
    const base = { taskType: 'feature', intentSummary: 'x', relevantFiles: ['a'], suggestedApproach: 'y', completionCriteria: ['z'] };
    const ok = parseDraftResponse(`\`\`\`json\n${JSON.stringify({ ...base, scope: { applicable: false, kind: 'human_action_only', confidence: 0.92, reason: 'Needs a customer message.', evidence: ['a', 'b'] } })}\n\`\`\``);
    expect(ok.scope?.kind).toBe('human_action_only');
    const bad = parseDraftResponse(`\`\`\`json\n${JSON.stringify({ ...base, scope: { applicable: false, kind: 'nonsense', reason: 'r' } })}\n\`\`\``);
    expect(bad.scope).toBeUndefined();
    expect(parseDraftResponse(`\`\`\`json\n${JSON.stringify(base)}\n\`\`\``).scope).toBeUndefined();
  });
});
