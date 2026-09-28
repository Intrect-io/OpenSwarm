import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `saveParsedTask`/`loadParsedTask` persist to `~/.openswarm/parsed-tasks`.
// Mock `fs/promises` so these tests never touch the real home directory.
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

const fileLockMock = vi.hoisted(() => ({
  withFileLock: vi.fn((_path: string, operation: () => unknown) => operation()),
}));
vi.mock('../support/fileLock.js', () => fileLockMock);

const atomicFileMock = vi.hoisted(() => ({
  atomicWriteFile: vi.fn(),
}));
vi.mock('../support/atomicFile.js', () => atomicFileMock);

import * as fs from 'fs/promises';
import {
  formatParsedTaskSummary,
  loadParsedTask,
  parseTask,
  saveParsedTask,
  type ParsedTask,
} from './taskParser.js';

const PARSED_TASKS_DIR = resolve(homedir(), '.openswarm/parsed-tasks');

describe('parseTask - optional description', () => {
  it('defaults to an empty description when the issue omits it', () => {
    const parsed = parseTask({ id: 'INT-214', title: 'Add config toggle' });

    expect(parsed.original.description).toBe('');
    expect(parsed.analysis.type).toBe('feature');
  });
});

describe('detectTaskType fallback', () => {
  it('falls back to "unknown" when no keyword pattern matches title or description', () => {
    const parsed = parseTask({
      id: 'INT-200',
      title: 'Quarterly stakeholder summary',
      description: 'Prepare quarterly stakeholder summary for department review meeting.',
    });

    expect(parsed.analysis.type).toBe('unknown');
  });
});

describe('analyzeComplexity - description length thresholds', () => {
  // Neutral filler with no complexity-indicator or task-type keyword substrings.
  const fillerSentence =
    'The team reviewed the quarterly summary spreadsheet with department stakeholders in a routine meeting. ';

  function makeFiller(targetLen: number): string {
    let s = '';
    while (s.length < targetLen) s += fillerSentence;
    return s.slice(0, targetLen);
  }

  it('classifies a description over 500 chars (and under 1500) as medium complexity', () => {
    const description = makeFiller(600);
    const parsed = parseTask({ id: 'INT-201', title: 'Status update', description });

    expect(description.length).toBeGreaterThan(500);
    expect(description.length).toBeLessThanOrEqual(1500);
    expect(parsed.analysis.complexity).toBe('medium');
    expect(parsed.analysis.estimatedSteps).toBe(4);
    expect(parsed.analysis.risks).toEqual([]);
  });

  it('classifies a description over 1500 chars as complex complexity', () => {
    const description = makeFiller(1600);
    const parsed = parseTask({ id: 'INT-202', title: 'Status update', description });

    expect(description.length).toBeGreaterThan(1500);
    expect(parsed.analysis.complexity).toBe('complex');
    expect(parsed.analysis.estimatedSteps).toBe(6);
    expect(parsed.analysis.risks).toEqual([]);
  });
});

describe('analyzeComplexity - keyword indicators', () => {
  it('reaches medium complexity via indicators alone, mixing a risk-bearing and a risk-free match', () => {
    const parsed = parseTask({
      id: 'INT-203',
      title: 'Improve internal metrics dashboard',
      description:
        'We need to adjust the database schema and improve performance for the reporting dashboard.',
    });

    expect(parsed.analysis.complexity).toBe('medium');
    expect(parsed.analysis.estimatedSteps).toBe(4);
    expect(parsed.analysis.risks).toEqual(['Database change required']);
  });

  it('reaches complex complexity purely from stacked indicator weight, without a long description', () => {
    const parsed = parseTask({
      id: 'INT-204',
      title: 'Overhaul entire data layer',
      description: 'This covers the entire database migration across the api layer for every module.',
    });

    expect(parsed.analysis.complexity).toBe('complex');
    expect(parsed.analysis.estimatedSteps).toBe(8);
    expect(parsed.analysis.risks).toEqual([
      'Data migration risk',
      'Database change required',
      'API change compatibility risk',
    ]);
  });
});

describe('adjustComplexityWithGraph', () => {
  // Base complexity: 'simple', estimatedSteps 3 (only the risk-free "performance" indicator fires).
  const graphBaseTitle = 'Improve reporting speed';
  const graphBaseDescription =
    'The dashboard performance needs improvement for the internal reporting view.';

  it('bumps to complex complexity using a large impact scope plus many affected modules', () => {
    const parsed = parseTask({
      id: 'INT-205',
      title: graphBaseTitle,
      description: graphBaseDescription,
      impactScope: 'large',
      affectedModuleCount: 8,
    });

    expect(parsed.analysis.complexity).toBe('complex');
    expect(parsed.analysis.estimatedSteps).toBe(6);
    expect(parsed.analysis.risks).toEqual([
      'Knowledge graph: wide impact range (large scope)',
      'Knowledge graph: 8 modules affected',
    ]);
    expect(parsed.analysis.requiresHumanReview).toBe(true);
  });

  it('bumps to exactly medium complexity using a medium impact scope alone', () => {
    const parsed = parseTask({
      id: 'INT-206',
      title: graphBaseTitle,
      description: graphBaseDescription,
      impactScope: 'medium',
    });

    expect(parsed.analysis.complexity).toBe('medium');
    expect(parsed.analysis.estimatedSteps).toBe(4);
    expect(parsed.analysis.risks).toEqual([]);
  });

  it('leaves complexity unchanged when the affected module count is at or below the threshold', () => {
    const parsed = parseTask({
      id: 'INT-207',
      title: graphBaseTitle,
      description: graphBaseDescription,
      affectedModuleCount: 3,
    });

    expect(parsed.analysis.complexity).toBe('simple');
    expect(parsed.analysis.estimatedSteps).toBe(3);
    expect(parsed.analysis.risks).toEqual([]);
  });
});

describe('generateSubtasks - optional subtask skipping', () => {
  it('skips the optional documentation subtask for a simple-complexity feature task', () => {
    const parsed = parseTask({
      id: 'INT-208',
      title: 'Add config toggle',
      description: 'Add a boolean toggle option to config for user preference settings.',
    });

    expect(parsed.analysis.type).toBe('feature');
    expect(parsed.analysis.complexity).toBe('simple');
    expect(parsed.subtasks.map(st => st.id)).toEqual([
      'feature-design',
      'feature-implement',
      'feature-test',
    ]);
    expect(parsed.subtasks.some(st => st.id === 'feature-docs')).toBe(false);
  });
});

describe('parsedTaskFilePath validation (via saveParsedTask/loadParsedTask)', () => {
  function makeParsedTask(id: string): ParsedTask {
    return parseTask({ id, title: 'Add config toggle', description: 'Add a toggle.' });
  }

  beforeEach(() => {
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(fs.readFile).mockReset();
    fileLockMock.withFileLock.mockImplementation((_path: string, operation: () => unknown) => operation());
    atomicFileMock.atomicWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['empty id', ''],
    ['literal ".."', '..'],
    ['id containing a path separator', 'sub/dir'],
    ['id that is all dots (defeats the equality check, still traversal-shaped)', '...'],
  ])('rejects saving a parsed task with an invalid id: %s', async (_label, invalidId) => {
    await expect(saveParsedTask(makeParsedTask(invalidId))).rejects.toThrow(
      'Invalid parsed task ID',
    );
  });

  it('resolves to null (not throwing) when loading with an invalid id', async () => {
    const result = await loadParsedTask('sub/dir');
    expect(result).toBeNull();
  });

  it('writes the parsed task to the expected path for a valid id', async () => {
    const parsed = makeParsedTask('INT-209');

    await saveParsedTask(parsed);

    expect(fs.mkdir).toHaveBeenCalledWith(PARSED_TASKS_DIR, { recursive: true });
    expect(fileLockMock.withFileLock).toHaveBeenCalled();
    expect(atomicFileMock.atomicWriteFile).toHaveBeenCalledWith(
      resolve(PARSED_TASKS_DIR, 'INT-209.json'),
      JSON.stringify(parsed, null, 2),
    );
  });

  it('loads and parses a previously saved task for a valid id', async () => {
    const parsed = makeParsedTask('INT-210');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(parsed) as never);

    const result = await loadParsedTask('INT-210');

    expect(fs.readFile).toHaveBeenCalledWith(
      resolve(PARSED_TASKS_DIR, 'INT-210.json'),
      'utf-8',
    );
    expect(result).toEqual(parsed);
  });

  it('resolves to null when the underlying file read fails', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await loadParsedTask('INT-211');

    expect(result).toBeNull();
  });

  it('resolves to null when stored JSON fails schema validation', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ invalid: true }) as never);

    const result = await loadParsedTask('INT-212');

    expect(result).toBeNull();
  });
});

describe('formatParsedTaskSummary', () => {
  it('includes a warnings section and the review notice for complex tasks with risks', () => {
    const parsed = parseTask({
      id: 'INT-212',
      title: 'Overhaul entire data layer',
      description: 'This covers the entire database migration across the api layer for every module.',
    });

    const summary = formatParsedTaskSummary(parsed);

    expect(summary).toContain('## Auto Analysis Result');
    expect(summary).toContain('**Type:** unknown');
    expect(summary).toContain('**Complexity:** complex');
    expect(summary).toContain('### Warnings');
    expect(summary).toContain('- Data migration risk');
    expect(summary).toContain('- Database change required');
    expect(summary).toContain('- API change compatibility risk');
    expect(summary).toContain('### Execution Plan');
    // First subtask has no dependency, so it must not render a "(<- ...)" suffix.
    expect(summary).toContain('1. **Understand requirements**\n');
    // A later subtask depends on an earlier one and must render the suffix.
    expect(summary).toContain('(← unknown-understand)');
    expect(summary).toContain('**Complex task. Review before execution is recommended.**');
    expect(summary.trim().endsWith('_OpenSwarm Task Parser_')).toBe(true);
  });

  it('omits the warnings section and review notice for simple, risk-free tasks', () => {
    const parsed = parseTask({
      id: 'INT-213',
      title: 'Add config toggle',
      description: 'Add a boolean toggle option to config for user preference settings.',
    });

    const summary = formatParsedTaskSummary(parsed);

    expect(parsed.analysis.risks).toEqual([]);
    expect(parsed.analysis.requiresHumanReview).toBe(false);
    expect(summary).not.toContain('### Warnings');
    expect(summary).not.toContain('Complex task. Review before execution is recommended.');
  });
});
