import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadExecution,
  loadWorkflow,
  saveExecution,
  saveWorkflow,
  WorkflowConfigSchema,
  WorkflowExecutionSchema,
  type WorkflowConfig,
  type WorkflowExecution,
} from './workflow.js';

const workflow = (id: string, over: Partial<WorkflowConfig> = {}): WorkflowConfig => ({
  id,
  name: 'test workflow',
  projectPath: '/tmp/project',
  steps: [{ id: 'step', name: 'Step', prompt: 'Run step' }],
  ...over,
});

const execution = (executionId: string, over: Partial<WorkflowExecution> = {}): WorkflowExecution => ({
  workflowId: 'workflow',
  executionId,
  status: 'running',
  startedAt: 0,
  stepResults: {},
  ...over,
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

describe('workflow schema validation', () => {
  it('rejects persisting a workflow with an empty step list', async () => {
    await expect(saveWorkflow(workflow('bad', { steps: [] }))).rejects.toThrow(/Invalid workflow/);
  });

  it('rejects persisting a workflow step without a prompt', async () => {
    await expect(
      saveWorkflow(workflow('bad-step', {
        steps: [{ id: 'a', name: 'A', prompt: '' }],
      })),
    ).rejects.toThrow(/Invalid workflow/);
  });

  it('accepts a well-formed workflow config schema', () => {
    expect(WorkflowConfigSchema.safeParse(workflow('ok')).success).toBe(true);
  });

  it('rejects malformed execution state that must not be resumed', () => {
    const parsed = WorkflowExecutionSchema.safeParse({
      workflowId: 'workflow',
      executionId: 'schema-check',
      status: 'not-a-status',
      startedAt: 0,
      stepResults: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed execution schema', () => {
    expect(WorkflowExecutionSchema.safeParse(execution('ok')).success).toBe(true);
  });

  it('refuses to resume execution state that fails schema validation on load', async () => {
    const id = `exec-invalid-${Date.now()}`;
    await saveExecution(execution(id));
    const filePath = resolve(homedir(), '.openswarm/executions', `${id}.json`);
    await writeFile(filePath, JSON.stringify({
      workflowId: 'workflow',
      executionId: id,
      status: 'not-a-status',
      startedAt: 0,
      stepResults: {},
    }), 'utf-8');
    await expect(loadExecution(id)).resolves.toBeNull();
  });
});
