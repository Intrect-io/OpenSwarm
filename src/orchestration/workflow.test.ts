import { describe, expect, it } from 'vitest';
import {
  loadExecution,
  loadWorkflow,
  saveExecution,
  saveWorkflow,
  validateExecution,
  type WorkflowConfig,
  type WorkflowExecution,
} from './workflow.js';

const workflow = (id: string): WorkflowConfig => ({
  id,
  name: 'test workflow',
  projectPath: '/tmp/project',
  steps: [{ id: 'step', name: 'Step', prompt: 'Run step' }],
});

const execution = (executionId: string): WorkflowExecution => ({
  workflowId: 'workflow',
  executionId,
  status: 'running',
  startedAt: 0,
  stepResults: {},
});

describe('workflow storage IDs', () => {
  it('rejects workflow IDs that would escape the workflow directory', async () => {
    await expect(saveWorkflow(workflow('../outside'))).rejects.toThrow('Invalid storage ID');
    await expect(saveWorkflow(workflow('..\\outside'))).rejects.toThrow('Invalid storage ID');
    await expect(loadWorkflow('../outside')).resolves.toBeNull();
  });

  it('rejects execution IDs that would escape the execution directory', async () => {
    await expect(saveExecution(execution('../outside'))).rejects.toThrow('Invalid storage ID');
    await expect(saveExecution(execution('..\\outside'))).rejects.toThrow('Invalid storage ID');
    await expect(loadExecution('../outside')).resolves.toBeNull();
  });
});

describe('validateExecution', () => {
  it('rejects completed steps missing completedAt', () => {
    expect(() => validateExecution({
      workflowId: 'wf',
      executionId: 'ex',
      status: 'running',
      startedAt: 0,
      stepResults: {
        step: { stepId: 'step', status: 'completed', startedAt: 0 },
      },
    })).toThrow(/completed but has no completedAt/);
  });

  it('rejects failed steps missing error', () => {
    expect(() => validateExecution({
      workflowId: 'wf',
      executionId: 'ex',
      status: 'failed',
      startedAt: 0,
      stepResults: {
        step: { stepId: 'step', status: 'failed', startedAt: 0, completedAt: 1 },
      },
    })).toThrow(/failed but has no error/);
  });

  it('rejects DAG-illegal advancement past pending dependencies', () => {
    expect(() => validateExecution({
      workflowId: 'wf',
      executionId: 'ex',
      status: 'running',
      startedAt: 0,
      stepResults: {
        a: { stepId: 'a', status: 'pending', startedAt: 0 },
        b: { stepId: 'b', status: 'completed', startedAt: 0, completedAt: 1 },
      },
    }, [
      { id: 'a', name: 'A', prompt: 'a' },
      { id: 'b', name: 'B', prompt: 'b', dependsOn: ['a'] },
    ])).toThrow(/cannot be completed when dependency a is pending/);
  });
});
