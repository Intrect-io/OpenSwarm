// AGT-3487 — malformed agent artifacts must not wedge history parsing, and
// fan-out must not silently proceed on a failed baseline capture.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBus, BUS_DIR } from './agentBus.js';
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

    const messagesDir = resolve(BUS_DIR, (bus as unknown as { executionId: string }).executionId, 'messages');
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

describe('agentBus polling skips malformed message files (AGT-3441)', () => {
  it('quarantines a malformed file and still delivers the later valid message', async () => {
    const executionId = `test-poll-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const publisher = new AgentBus(executionId);
    const subscriber = new AgentBus(executionId);
    await publisher.init('workflow-123');
    const messagesDir = resolve(BUS_DIR, executionId, 'messages');
    // Sorted before every published file, so it is the first one polled.
    await writeFile(join(messagesDir, '0000-corrupt.json'), '{ not json', 'utf-8');
    await writeFile(join(messagesDir, '0001-wrong-shape.json'), JSON.stringify({ type: 'log' }), 'utf-8');

    const seen: unknown[] = [];
    subscriber.on('log', (msg) => { seen.push(msg.payload); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await publisher.publish('log', 'step-1', 'after the bad files');
      await subscriber.pollOnce();
      expect(seen).toEqual(['after the bad files']);

      const quarantined = await readdir(resolve(messagesDir, '..', 'quarantine'));
      expect(quarantined).toEqual(expect.arrayContaining(['0000-corrupt.json', '0001-wrong-shape.json']));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('0000-corrupt.json'));

      // A later poll sees the next message too; the bad files never come back.
      await publisher.publish('log', 'step-2', 'second');
      await subscriber.pollOnce();
      expect(seen).toEqual(['after the bad files', 'second']);
    } finally {
      warn.mockRestore();
      await publisher.cleanup();
    }
  });
});
