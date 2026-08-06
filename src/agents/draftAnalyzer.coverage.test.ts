// ============================================
// OpenSwarm - draftAnalyzer.ts coverage top-up
// ============================================
//
// Companion to draftAnalyzer.test.ts. That file already covers the adapter
// fallback/retry state machine and the drafter hard gate; this file targets
// what `vitest run src/agents/draftAnalyzer.test.ts --coverage` still showed
// as uncovered: the real (non-null) impact-analysis + registry-snapshot path
// through collectCodebaseState/buildDraftPrompt (every existing test mocks
// analyzeIssue to resolve `null`, which short-circuits that whole branch),
// the JSON/anchor extraction edge cases in parseDraftResponse, and a couple
// of parseDraftProse's section-bullet break conditions.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliAdapter, CliRunResult } from '../adapters/types.js';
import type { ImpactAnalysis } from '../knowledge/types.js';
import * as adapterModule from '../adapters/index.js';
import * as knowledgeModule from '../knowledge/index.js';
import * as registryModule from '../registry/sqliteStore.js';
import { runDraftAnalysis, parseDraftResponse, parseDraftProse } from './draftAnalyzer.js';

const makeAdapter = (name: string): CliAdapter => ({
  name,
  capabilities: {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  },
  isAvailable: vi.fn(async () => true),
  getDefaultModel: vi.fn(async () => 'default-model'),
  buildCommand: () => ({ command: 'echo', args: [] }),
  parseWorkerOutput: vi.fn(() => ({
    success: false, summary: '', filesChanged: [], commands: [], output: '',
  })),
  parseReviewerOutput: vi.fn(() => ({
    decision: 'approve', feedback: 'ok', issues: [], suggestions: [],
  })),
});

const sufficientBrief = {
  taskType: 'feature',
  intentSummary: 'Wire the resolver into the streaming path',
  relevantFiles: ['src/streaming.ts'],
  suggestedApproach: 'call resolve_turn_model from build_request',
  completionCriteria: ['resolve_turn_model invoked from streaming.ts (call site cited)'],
};

function mockSufficientSpawnCli(): void {
  vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
  vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(makeAdapter('codex'));
  vi.spyOn(adapterModule, 'spawnCli').mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify(sufficientBrief),
    stderr: '',
    durationMs: 1,
  } as CliRunResult);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runDraftAnalysis — real impact analysis + registry snapshot path', () => {
  it('builds highlights (deprecated/broken/critical) for direct+dependent modules and skips files with no entities', async () => {
    mockSufficientSpawnCli();
    const impact: ImpactAnalysis = {
      directModules: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      // 9 items: only the first 8 are folded into the affected-files set.
      dependentModules: Array.from({ length: 9 }, (_, i) => `src/dep${i}.ts`),
      testFiles: ['src/a.test.ts'],
      estimatedScope: 'large',
    };
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(impact);

    const fileBrief = vi.fn((filePath: string) => {
      if (filePath === 'src/a.ts') {
        return {
          filePath,
          summary: 'core module with issues',
          entities: [
            { kind: 'function', name: 'depFn', signature: 'depFn(): void', status: 'deprecated', hasTests: true, warnings: [] },
            { kind: 'function', name: 'brokenFn', signature: 'brokenFn(): void', status: 'broken', hasTests: false, warnings: [] },
            {
              kind: 'function', name: 'criticalFn', signature: 'criticalFn(): void', status: 'active', hasTests: true,
              warnings: [{ severity: 'critical', resolved: false }, { severity: 'info', resolved: false }],
            },
          ],
        };
      }
      if (filePath === 'src/b.ts' || filePath === 'src/c.ts') {
        // Real entities, but nothing worth flagging — exercises the
        // no-highlights branch of buildDraftPrompt's file-health section.
        return {
          filePath,
          summary: 'clean module',
          entities: [{ kind: 'function', name: 'cleanFn', signature: 'cleanFn(): void', status: 'active', hasTests: true, warnings: [] }],
        };
      }
      // Every dependent module (dep0..dep8) has no registry entry at all —
      // exercises the "skip files with zero entities" continue branch.
      return { filePath, summary: '', entities: [] };
    });
    const registryStore = {
      getStats: vi.fn(() => ({
        total: 42, byKind: [], byStatus: [], deprecated: 2, untested: 3, withWarnings: 1, highRisk: 1,
      })),
      highRiskEntities: vi.fn(() => []),
      fileBrief,
    };
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue(registryStore as never);

    const logs: string[] = [];
    const result = await runDraftAnalysis({
      taskTitle: 'Fix streaming resolver',
      taskDescription: 'Test',
      projectPath: '/tmp/project',
      onLog: (line) => logs.push(line),
    });

    // 3 files got real registry entries (a, b, c) — the < 3 highRiskEntities
    // fallback must NOT fire (all 3 direct modules produced a snapshot entry).
    expect(result.registrySnapshot).toHaveLength(3);
    expect(registryStore.highRiskEntities).not.toHaveBeenCalled();
    const aSnapshot = result.registrySnapshot.find((s) => s.filePath === 'src/a.ts');
    expect(aSnapshot?.highlights).toEqual(
      expect.arrayContaining(['depFn (deprecated)', 'brokenFn (broken)', 'criticalFn (1 critical)']),
    );
    const bSnapshot = result.registrySnapshot.find((s) => s.filePath === 'src/b.ts');
    expect(bSnapshot?.highlights).toEqual([]);
    // Only 8 of the 9 dependent modules were looked up (slice(0, 8)).
    expect(fileBrief).toHaveBeenCalledTimes(3 + 8);
    expect(fileBrief).not.toHaveBeenCalledWith('src/dep8.ts');
    // Project stats line reflects every non-zero stat bucket.
    expect(result.projectStats).toBe('42 entities, 2 deprecated, 3 untested, 1 with warnings, 1 high-risk');
    expect(logs.some((l) => l.includes('[Draft] Impact: 3 direct, 9 dependent, scope=large'))).toBe(true);
    expect(logs.some((l) => l.includes('[Draft] Registry: 42 entities'))).toBe(true);
  });

  it('falls back to highRiskEntities when fewer than 3 files got a registry snapshot, honoring the affected-files overlap check', async () => {
    mockSufficientSpawnCli();
    const impact: ImpactAnalysis = {
      directModules: ['src/x.ts'],
      dependentModules: [],
      testFiles: [],
      estimatedScope: 'small',
    };
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(impact);

    const registryStore = {
      getStats: vi.fn(() => ({ total: 5, byKind: [], byStatus: [], deprecated: 0, untested: 0, withWarnings: 0, highRisk: 0 })),
      highRiskEntities: vi.fn(() => [
        // Already covered by the direct-module snapshot — must be skipped.
        { filePath: 'src/x.ts', name: 'xFn', complexityScore: 9 },
        // Not otherwise covered — must be appended as a high-risk entry.
        { filePath: 'src/z.ts', name: 'zFn', complexityScore: 8 },
      ]),
      fileBrief: vi.fn((filePath: string) => ({
        filePath,
        summary: 'x module',
        entities: [{ kind: 'function', name: 'xFn', signature: 'xFn(): void', status: 'active', hasTests: true, warnings: [] }],
      })),
    };
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue(registryStore as never);

    const result = await runDraftAnalysis({
      taskTitle: 'Fix x', taskDescription: 'Test', projectPath: '/tmp/project',
    });

    expect(registryStore.highRiskEntities).toHaveBeenCalled();
    expect(result.registrySnapshot).toHaveLength(2);
    const zEntry = result.registrySnapshot.find((s) => s.filePath === 'src/z.ts');
    expect(zEntry?.summary).toBe('high-risk: zFn (complexity 8, no tests)');
    // The already-affected x.ts high-risk duplicate is not appended a second time.
    expect(result.registrySnapshot.filter((s) => s.filePath === 'src/x.ts')).toHaveLength(1);
  });

  it('swallows a registry initialization failure and still returns a best-effort draft', async () => {
    mockSufficientSpawnCli();
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(null);
    vi.spyOn(registryModule, 'getRegistryStore').mockImplementation(() => {
      throw new Error('registry not initialized');
    });

    const result = await runDraftAnalysis({
      taskTitle: 'Fix x', taskDescription: 'Test', projectPath: '/tmp/project',
    });

    expect(result.registrySnapshot).toEqual([]);
    expect(result.projectStats).toBeUndefined();
    expect(result.sufficient).toBe(true); // the drafter call itself still succeeds
  });
});

describe('runDraftAnalysis — real tracked-file count (countTrackedFiles success path)', () => {
  it('counts tracked files in a real git repo instead of falling back to 0', async () => {
    mockSufficientSpawnCli();
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(null);
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue({
      getStats: vi.fn(() => ({ total: 0, byKind: [], byStatus: [], deprecated: 0, untested: 0, withWarnings: 0, highRisk: 0 })),
      highRiskEntities: vi.fn(() => []),
      fileBrief: vi.fn(() => ({ filePath: '', summary: '', entities: [] })),
    } as never);

    const repo = mkdtempSync(join(tmpdir(), 'osw-draft-tracked-'));
    try {
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

      const logs: string[] = [];
      await runDraftAnalysis({
        taskTitle: 'T', taskDescription: 'D', projectPath: repo,
        onLog: (line) => logs.push(line),
      });

      expect(logs.some((l) => l.includes('[Draft] Budget: 2 tracked files'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('parseDraftResponse — JSON/anchor extraction edge cases', () => {
  it('parses a high-confidence duplicate grooming recommendation', () => {
    const r = parseDraftResponse(JSON.stringify({
      taskType: 'feature',
      intentSummary: 'Implement the existing card status write-back behavior.',
      relevantFiles: ['src/cards.ts'],
      suggestedApproach: 'Reuse the existing mutation path.',
      completionCriteria: ['Status mutation is observable in the dashboard'],
      duplicateOfIssueId: 'older-issue',
      duplicateConfidence: 0.96,
      duplicateReason: 'Both request the same mutation and UI flow.',
      duplicateEvidence: ['same endpoint', 'same acceptance criterion'],
    }));
    expect(r).toMatchObject({
      duplicateOfIssueId: 'older-issue',
      duplicateConfidence: 0.96,
      duplicateEvidence: ['same endpoint', 'same acceptance criterion'],
    });
  });

  it('falls all the way through to prose salvage when there is no fence and no field anchor at all', () => {
    const text = 'The repository is large and the task is unclear. No structured answer was produced.';
    const r = parseDraftResponse(text);
    expect(r.taskType).toBe('unknown');
    expect(r.relevantFiles).toEqual([]);
  });

  it('gives up on an anchor whose brief field appears with no preceding brace anywhere', () => {
    // "taskType" is present as a substring, but nothing brace-shaped precedes
    // it anywhere in the text — findJsonObject must bail via `start < 0`.
    const text = 'Note: the field "taskType" was not filled in and no braces exist here.';
    const r = parseDraftResponse(text);
    expect(r.taskType).toBe('unknown');
    expect(r.relevantFiles).toEqual([]);
  });

  it('gives up on an anchor whose braces never balance to close', () => {
    const text = 'Partial dump: {"taskType": "bugfix", "relevantFiles": ["a.ts"'; // never closes
    const r = parseDraftResponse(text);
    // No balanced object was found for any anchor, so it falls through to prose
    // salvage, which finds no brief-shaped structure either.
    expect(r.taskType).toBe('unknown');
  });

  it('falls back to empty string/array defaults when brief fields are the wrong type', () => {
    const malformed = JSON.stringify({
      taskType: 'bugfix',
      intentSummary: 42,       // not a string
      relevantFiles: 'not-an-array',
      suggestedApproach: null,
      completionCriteria: { not: 'an array' },
    });
    const r = parseDraftResponse('```json\n' + malformed + '\n```');
    expect(r.taskType).toBe('bugfix');
    expect(r.intentSummary).toBe('');
    expect(r.relevantFiles).toEqual([]);
    expect(r.suggestedApproach).toBe('');
    expect(r.completionCriteria).toEqual([]);
  });
});

describe('parseDraftProse — section-bullet edge cases', () => {
  it('returns the empty draft for blank/whitespace-only text', () => {
    const r = parseDraftProse('   \n  \t ');
    expect(r.taskType).toBe('unknown');
    expect(r.relevantFiles).toEqual([]);
    expect(r.completionCriteria).toEqual([]);
  });

  it('stops collecting completion criteria at a blank line after the bullets', () => {
    const prose = [
      'Task type: bugfix',
      '### Completion criteria',
      '- first criterion is met',
      '- second criterion is met',
      '', // blank line — must stop the bullet scan here
      'Unrelated trailing paragraph that must not be collected.',
    ].join('\n');
    const r = parseDraftProse(prose);
    expect(r.completionCriteria).toEqual(['first criterion is met', 'second criterion is met']);
  });

  it('stops collecting completion criteria at the next heading-ish line', () => {
    const prose = [
      'Task type: bugfix',
      '### Completion criteria',
      '- only criterion here',
      '#### Next section',
      '- this bullet belongs to the next section, not completion criteria',
    ].join('\n');
    const r = parseDraftProse(prose);
    expect(r.completionCriteria).toEqual(['only criterion here']);
  });

  it('gives up scanning for bullets after more than 6 non-bullet lines with none found', () => {
    const prose = [
      'Task type: bugfix',
      '### Completion criteria',
      'line 1 with no bullet',
      'line 2 with no bullet',
      'line 3 with no bullet',
      'line 4 with no bullet',
      'line 5 with no bullet',
      'line 6 with no bullet',
      'line 7 with no bullet',
      '- this bullet arrives too late and is never reached',
    ].join('\n');
    const r = parseDraftProse(prose);
    expect(r.completionCriteria).toEqual([]);
  });
});
