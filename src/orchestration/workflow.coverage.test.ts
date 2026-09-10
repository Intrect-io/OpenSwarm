import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable readdir failure, used only by the "listWorkflows surfaces disk
// errors as an empty list" test below. Mocking (rather than mutating real
// filesystem permissions on the user's actual ~/.openswarm directory) is the
// only safe way to exercise this catch branch.
const { readdirMock } = vi.hoisted(() => ({ readdirMock: vi.fn() }));

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  // Default behavior delegates to the real implementation; individual tests
  // can override it once via readdirMock.mockImplementationOnce(...).
  readdirMock.mockImplementation((...args: Parameters<typeof actual.readdir>) => actual.readdir(...args));
  return {
    ...actual,
    readdir: readdirMock,
  };
});

import {
  createCIPipelineTemplate,
  createReviewPipelineTemplate,
  EXECUTION_DIR,
  getExecutableSteps,
  getParallelGroups,
  listWorkflows,
  loadExecution,
  loadWorkflow,
  assertExecutionPersistable,
  saveExecution,
  saveWorkflow,
  topologicalSort,
  validateWorkflow,
  WORKFLOW_DIR,
  type StepResult,
  type WorkflowConfig,
  type WorkflowExecution,
  type WorkflowStep,
} from './workflow.js';

// Unique-but-recognizable IDs so parallel test runs on the real ~/.openswarm
// storage directory (see workflow.ts WORKFLOW_DIR/EXECUTION_DIR) don't collide.
// Follows the same convention as src/support/rollback.test.ts.
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const diamondSteps: WorkflowStep[] = [
  { id: 'd', name: 'D', prompt: 'run d', dependsOn: ['b', 'c'] },
  { id: 'c', name: 'C', prompt: 'run c', dependsOn: ['a'] },
  { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['a'] },
  { id: 'a', name: 'A', prompt: 'run a' },
];

describe('topologicalSort', () => {
  it('orders steps so dependencies come before dependents', () => {
    const sorted = topologicalSort(diamondSteps);
    const indexOf = (id: string) => sorted.findIndex(s => s.id === id);

    expect(sorted).toHaveLength(4);
    expect(indexOf('a')).toBeLessThan(indexOf('b'));
    expect(indexOf('a')).toBeLessThan(indexOf('c'));
    expect(indexOf('b')).toBeLessThan(indexOf('d'));
    expect(indexOf('c')).toBeLessThan(indexOf('d'));
  });

  it('throws when a step depends on an unknown step', () => {
    const steps: WorkflowStep[] = [
      { id: 'x', name: 'X', prompt: 'run x', dependsOn: ['missing'] },
    ];
    expect(() => topologicalSort(steps)).toThrow('Step "x" depends on unknown step "missing"');
  });

  it('throws on circular dependencies', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', name: 'A', prompt: 'run a', dependsOn: ['b'] },
      { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['a'] },
    ];
    expect(() => topologicalSort(steps)).toThrow('Workflow contains circular dependencies');
  });
});

describe('getExecutableSteps', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', name: 'A', prompt: 'run a' },
    { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['a'] },
    { id: 'c', name: 'C', prompt: 'run c', dependsOn: ['b'] },
  ];

  it('returns only steps with no unmet dependencies and not yet run', () => {
    const executable = getExecutableSteps(steps, {});
    expect(executable.map(s => s.id)).toEqual(['a']);
  });

  it('excludes steps that already have a result, includes newly-unblocked ones', () => {
    const results: Record<string, StepResult> = {
      a: { stepId: 'a', status: 'completed', startedAt: 0 },
    };
    const executable = getExecutableSteps(steps, results);
    expect(executable.map(s => s.id)).toEqual(['b']);
  });

  it('excludes steps whose dependency failed (not completed)', () => {
    const results: Record<string, StepResult> = {
      a: { stepId: 'a', status: 'completed', startedAt: 0 },
      b: { stepId: 'b', status: 'failed', startedAt: 0 },
    };
    const executable = getExecutableSteps(steps, results);
    expect(executable).toEqual([]);
  });
});

describe('getParallelGroups', () => {
  it('groups a diamond dependency graph into sequential parallel layers', () => {
    const groups = getParallelGroups(diamondSteps);
    expect(groups.map(g => g.map(s => s.id).sort())).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('puts fully independent steps into a single group', () => {
    const independent: WorkflowStep[] = [
      { id: 'x', name: 'X', prompt: 'run x' },
      { id: 'y', name: 'Y', prompt: 'run y' },
    ];
    const groups = getParallelGroups(independent);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(s => s.id).sort()).toEqual(['x', 'y']);
  });
});

describe('workflow storage round trips', () => {
  const cleanupWorkflowIds: string[] = [];
  const cleanupExecutionIds: string[] = [];
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const id of cleanupWorkflowIds.splice(0)) {
      await rm(resolve(WORKFLOW_DIR, `${id}.yaml`), { force: true });
    }
    for (const id of cleanupExecutionIds.splice(0)) {
      await rm(resolve(EXECUTION_DIR, `${id}.json`), { force: true });
    }
    for (const path of cleanupPaths.splice(0)) {
      await rm(path, { force: true });
    }
  });

  it('saves and loads a workflow by ID', async () => {
    const id = uniqueId('cov-workflow');
    cleanupWorkflowIds.push(id);

    const config: WorkflowConfig = {
      id,
      name: 'Coverage Test Workflow',
      projectPath: '/tmp/coverage-project',
      steps: [{ id: 'step', name: 'Step', prompt: 'Run step' }],
    };

    await saveWorkflow(config);
    const loaded = await loadWorkflow(id);

    expect(loaded).toEqual(config);
  });

  it('returns null when loading a well-formed but nonexistent workflow ID', async () => {
    const loaded = await loadWorkflow(uniqueId('cov-workflow-missing'));
    expect(loaded).toBeNull();
  });

  it('lists saved workflows and ignores non-yaml files', async () => {
    const id = uniqueId('cov-workflow-list');
    cleanupWorkflowIds.push(id);

    const config: WorkflowConfig = {
      id,
      name: 'Listed Workflow',
      projectPath: '/tmp/coverage-project',
      steps: [{ id: 'step', name: 'Step', prompt: 'Run step' }],
    };
    await saveWorkflow(config);

    // Stray non-.yaml file in the same directory must be skipped by the filter.
    const strayPath = resolve(WORKFLOW_DIR, `${uniqueId('cov-stray')}.txt`);
    await writeFile(strayPath, 'not a workflow');
    cleanupPaths.push(strayPath);

    const workflows = await listWorkflows();
    expect(workflows.some(w => w.id === id)).toBe(true);
  });

  it('returns an empty list when the workflow directory cannot be read', async () => {
    // Force a filesystem failure (e.g. permission error, disk error) to exercise
    // the catch-and-fall-back-to-[] path in listWorkflows.
    readdirMock.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const workflows = await listWorkflows();

    expect(workflows).toEqual([]);
  });

  it('saves and loads an execution by ID', async () => {
    const executionId = uniqueId('cov-execution');
    cleanupExecutionIds.push(executionId);

    const execution: WorkflowExecution = {
      workflowId: 'wf-1',
      executionId,
      status: 'running',
      startedAt: Date.now(),
      stepResults: {
        step: { stepId: 'step', status: 'completed', startedAt: 0, completedAt: 1 },
      },
    };

    await saveExecution(execution);
    const loaded = await loadExecution(executionId);

    expect(loaded).toEqual(execution);
  });

  it('returns null when loading a well-formed but nonexistent execution ID', async () => {
    const loaded = await loadExecution(uniqueId('cov-execution-missing'));
    expect(loaded).toBeNull();
  });
});

describe('createCIPipelineTemplate', () => {
  it('builds a lint -> test -> build -> pr chain', () => {
    const template = createCIPipelineTemplate('/tmp/ci-project');

    expect(template.id).toMatch(/^ci-pipeline-/);
    expect(template.projectPath).toBe('/tmp/ci-project');
    expect(template.onFailure).toBe('rollback');
    expect(template.steps.map(s => s.id)).toEqual(['lint', 'test', 'build', 'pr']);
    expect(template.steps.find(s => s.id === 'test')?.dependsOn).toEqual(['lint']);
    expect(template.steps.find(s => s.id === 'build')?.dependsOn).toEqual(['test']);
    expect(template.steps.find(s => s.id === 'pr')?.dependsOn).toEqual(['build']);
    expect(template.steps.find(s => s.id === 'pr')?.onFailure).toBe('notify');
  });
});

describe('createReviewPipelineTemplate', () => {
  it('builds a security/quality -> tests -> summary chain with the PR number interpolated', () => {
    const template = createReviewPipelineTemplate('/tmp/review-project', '42');

    expect(template.id).toMatch(/^review-pipeline-/);
    expect(template.onFailure).toBe('notify');
    expect(template.steps.map(s => s.id)).toEqual(['security', 'quality', 'tests', 'summary']);
    expect(template.steps.find(s => s.id === 'security')?.prompt).toContain('PR #42');
    expect(template.steps.find(s => s.id === 'tests')?.dependsOn).toEqual(['security', 'quality']);
    expect(template.steps.find(s => s.id === 'summary')?.dependsOn).toEqual(['tests']);
  });
});

describe('validateWorkflow', () => {
  it('accepts a well-formed workflow', () => {
    const config: WorkflowConfig = {
      id: 'wf-valid',
      name: 'Valid Workflow',
      projectPath: '/tmp/project',
      steps: [
        { id: 'a', name: 'A', prompt: 'run a' },
        { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['a'] },
      ],
    };

    expect(validateWorkflow(config)).toEqual({ valid: true, errors: [] });
  });

  it('reports missing id, missing name, and empty steps', () => {
    const config: WorkflowConfig = {
      id: '',
      name: '',
      projectPath: '/tmp/project',
      steps: [],
    };

    const result = validateWorkflow(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow ID is required');
    expect(result.errors).toContain('Workflow name is required');
    expect(result.errors).toContain('Workflow must have at least one step');
  });

  it('tolerates a workflow object with steps entirely absent', () => {
    // Defensive runtime check: `!workflow.steps` must handle the property
    // being missing outright, not just an empty array.
    const malformed = { id: 'wf-malformed', name: 'Malformed', projectPath: '/tmp' } as unknown as WorkflowConfig;

    const result = validateWorkflow(malformed);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow must have at least one step');
  });

  it('reports a step missing an ID and skips further checks on it', () => {
    const config: WorkflowConfig = {
      id: 'wf-1',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [{ id: '', name: 'No ID', prompt: '' }],
    };

    const result = validateWorkflow(config);
    expect(result.errors).toContain('Each step must have an ID');
    // The empty-prompt error for the same step must NOT also appear, because
    // the loop `continue`s immediately after flagging the missing ID.
    expect(result.errors).not.toContain('Step "" must have a prompt');
  });

  it('reports duplicate step IDs', () => {
    const config: WorkflowConfig = {
      id: 'wf-dup',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [
        { id: 'a', name: 'A', prompt: 'run a' },
        { id: 'a', name: 'A again', prompt: 'run a again' },
      ],
    };

    const result = validateWorkflow(config);
    expect(result.errors).toContain('Duplicate step ID: a');
  });

  it('reports a step missing a prompt', () => {
    const config: WorkflowConfig = {
      id: 'wf-noprompt',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [{ id: 'a', name: 'A', prompt: '' }],
    };

    const result = validateWorkflow(config);
    expect(result.errors).toContain('Step "a" must have a prompt');
  });

  it('reports a dependency on an unknown step', () => {
    const config: WorkflowConfig = {
      id: 'wf-unknown-dep',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [
        { id: 'a', name: 'A', prompt: 'run a' },
        { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['missing'] },
      ],
    };

    const result = validateWorkflow(config);
    expect(result.errors).toContain('Step "b" depends on unknown step "missing"');
  });

  it('allows a forward reference to a step declared later in the list', () => {
    const config: WorkflowConfig = {
      id: 'wf-forward-ref',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [
        { id: 'a', name: 'A', prompt: 'run a', dependsOn: ['b'] },
        { id: 'b', name: 'B', prompt: 'run b' },
      ],
    };

    const result = validateWorkflow(config);
    expect(result.errors.some(e => e.includes('unknown step'))).toBe(false);
  });

  it('reports circular dependencies detected by the topological sort', () => {
    const config: WorkflowConfig = {
      id: 'wf-cycle',
      name: 'Workflow',
      projectPath: '/tmp/project',
      steps: [
        { id: 'a', name: 'A', prompt: 'run a', dependsOn: ['b'] },
        { id: 'b', name: 'B', prompt: 'run b', dependsOn: ['a'] },
      ],
    };

    const result = validateWorkflow(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow contains circular dependencies');
  });
});

describe('assertExecutionPersistable', () => {
  const cleanupWorkflowIds: string[] = [];

  afterEach(async () => {
    for (const id of cleanupWorkflowIds.splice(0)) {
      await rm(resolve(WORKFLOW_DIR, `${id}.yaml`), { force: true });
    }
  });

  it('rejects invalid execution status before persistence', async () => {
    await expect(assertExecutionPersistable({
      workflowId: 'wf-1',
      executionId: uniqueId('bad-status'),
      status: 'paused' as WorkflowExecution['status'],
      startedAt: Date.now(),
      stepResults: {},
    })).rejects.toThrow(/Invalid execution status/);
  });

  it('rejects step results that are not in the workflow definition', async () => {
    const workflowId = uniqueId('wf-assert');
    cleanupWorkflowIds.push(workflowId);
    await saveWorkflow({
      id: workflowId,
      name: 'Assertable',
      projectPath: '/tmp/project',
      steps: [{ id: 'only', name: 'Only', prompt: 'run' }],
    });

    await expect(assertExecutionPersistable({
      workflowId,
      executionId: uniqueId('bad-step'),
      status: 'running',
      startedAt: Date.now(),
      stepResults: {
        ghost: { stepId: 'ghost', status: 'completed', startedAt: 0, completedAt: 1 },
      },
    })).rejects.toThrow(/not in workflow/);
  });

  it('allows structurally valid executions when the definition is absent', async () => {
    await expect(assertExecutionPersistable({
      workflowId: uniqueId('missing-def'),
      executionId: uniqueId('ok-exec'),
      status: 'completed',
      startedAt: Date.now(),
      stepResults: {},
    })).resolves.toBeUndefined();
  });
});
