// AGT-3487 — malformed agent artifacts must not wedge history parsing, and
// fan-out must not silently proceed on a failed baseline capture.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentBus } from './agentBus.js';
import { parseAuditorOutput } from './auditor.js';
import { parseDocumenterOutput } from './documenter.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'openswarm-artifacts-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('agentBus malformed history quarantine', () => {
  it('skips and quarantines a corrupt message file without losing valid history', async () => {
    const bus = new AgentBus(`test-execution-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await bus.init('workflow-123');

    await bus.publish('log', 'step-1', { message: 'valid' });

    const messagesDir = resolve(homedir(), '.openswarm', 'bus', (bus as unknown as { executionId: string }).executionId, 'messages');
    const corruptPath = join(messagesDir, '9999-corrupt.json');
    await writeFile(corruptPath, '{ not json', 'utf-8');
    const wrongShapePath = join(messagesDir, '9998-wrong-shape.json');
    await writeFile(wrongShapePath, JSON.stringify({ hello: 'world' }), 'utf-8');

    const messages = await bus.getAllMessages();

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.every((m) => typeof m.id === 'string' && typeof m.type === 'string')).toBe(true);

    const quarantineDir = resolve(messagesDir, '..', 'quarantine');
    const quarantined = await readdir(quarantineDir);
    expect(quarantined).toContain('9999-corrupt.json');
    expect(quarantined).toContain('9998-wrong-shape.json');

    const quarantinedContent = await readFile(join(quarantineDir, '9999-corrupt.json'), 'utf-8');
    expect(quarantinedContent).toContain('not json');

    await bus.cleanup();
  });
});

describe('auditor/documenter non-string output guard', () => {
  it('rejects non-string auditor output instead of parsing it', () => {
    const result = parseAuditorOutput(undefined as unknown as string);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expected string output');
    expect(result.summary).toBe('Auditor output was not a string');
  });

  it('rejects non-string documenter output instead of parsing it', () => {
    const result = parseDocumenterOutput(123 as unknown as string);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expected string output');
    expect(result.summary).toBe('Documenter output was not a string');
  });
});
