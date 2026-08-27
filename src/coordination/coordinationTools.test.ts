import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignCallSign } from './agentNames.js';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(async () => {
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function tools() {
  dir = mkdtempSync(join(tmpdir(), 'osw-coordination-tools-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  return import('./coordinationTools.js');
}

describe('coordination tools', () => {
  it('delivers a request addressed by call sign to that agent only', async () => {
    const mod = await tools();
    const alice = assignCallSign({ repository: '/repo', executionId: 's1', role: 'worker' });
    const bob = assignCallSign({ repository: '/repo', executionId: 's2', role: 'worker' });

    await mod.executeCoordinationTool(
      'coordination_publish',
      { kind: 'advice-request', recipient: bob.name, summary: 'Is the auth helper safe to reuse?' },
      { repository: '/repo', taskId: 't1', actor: alice.address, actorName: alice.name },
    );

    const stranger = assignCallSign({ repository: '/repo', executionId: 's3', role: 'worker' });
    const unrelated = await mod.executeCoordinationTool('coordination_read', {}, {
      repository: '/repo', taskId: 't1', actor: stranger.address, actorName: stranger.name,
    });
    expect(JSON.parse(unrelated.content)).toEqual([]);

    const inbox = await mod.executeCoordinationTool('coordination_read', {}, {
      repository: '/repo', taskId: 't1', actor: bob.address, actorName: bob.name,
    });
    const messages = JSON.parse(inbox.content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ actorName: alice.name, recipientName: bob.name, kind: 'advice-request' });
  });

  it('pages the operator instead of answering its own question', async () => {
    const mod = await tools();
    const paged: string[] = [];
    const result = await mod.executeCoordinationTool('ask_human', { question: 'Ship v2?' }, {
      repository: '/repo', taskId: 't1', actor: 'magos-test', actorName: 'Magos Test-Vector',
      notifyOperator: async (message) => { paged.push(message); return true; },
    });
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ blocked: true, delivered: true });
    expect(payload.correlationId).toMatch(/^hq-/);
    expect(paged[0]).toContain('Ship v2?');
  });

  it('tells the agent nobody was paged when Discord is unreachable', async () => {
    const mod = await tools();
    const result = await mod.executeCoordinationTool('ask_human', { question: 'Ship v3?' }, {
      repository: '/repo', taskId: 't1', actor: 'magos-test',
      notifyOperator: async () => false,
    });
    const payload = JSON.parse(result.content);
    expect(payload.delivered).toBe(false);
    expect(payload.instruction).toContain('nobody has been paged');
  });
});
