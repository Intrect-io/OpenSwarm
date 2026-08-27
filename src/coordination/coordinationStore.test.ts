import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinationStore } from './coordinationStore.js';
import { withFileLock } from '../support/fileLock.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
function store() { dir = mkdtempSync(join(tmpdir(), 'osw-coordination-')); return new CoordinationStore(join(dir, 'events.json')); }
function message(over: Record<string, unknown> = {}) {
  return { repository: '/repo', taskId: 't1', actor: 'worker-a', recipient: 'worker-b', kind: 'advice-request' as const, status: 'open' as const, correlationId: 'c1', summary: 'review this approach', ...over };
}

describe('CoordinationStore', () => {
  it('deduplicates publications and assigns monotonic sequences', async () => {
    const s = store();
    const first = await s.publish(message());
    const duplicate = await s.publish(message());
    const second = await s.publish(message({ correlationId: 'c2' }));
    expect(duplicate.id).toBe(first.id);
    expect(second.seq).toBe(first.seq + 1);
    expect(s.list()).toHaveLength(2);
  });

  it('announces a message once, so an imported event is not echoed back', async () => {
    // The Linear board mirror republishes whatever 'coordination:published'
    // reports. Startup imports remote comments through publish(); announcing a
    // deduplicated event would post it straight back to the board it came from.
    const s = store();
    const { getEventHub } = await import('../core/eventHub.js');
    const announced: unknown[] = [];
    const listener = (event: unknown) => announced.push(event);
    getEventHub().on('coordination:published', listener);
    try {
      await s.publish(message());
      await s.publish(message());
      expect(announced).toHaveLength(1);
    } finally {
      getEventHub().off('coordination:published', listener);
    }
  });

  it('waits for a lock another process holds before touching the board', async () => {
    // A daemon and a standalone `openswarm review` are separate OS processes:
    // their read-modify-write cycles genuinely interleave, and the loser's
    // event disappears while its sequence number is reused. Only the file lock
    // orders them, so assert the store actually blocks on a held lock.
    const cli = store();
    const lockPath = `${join(dir, 'events.json')}.lock`;

    let settled = false;
    let pending!: Promise<unknown>;
    await withFileLock(lockPath, async () => {
      pending = cli.publish(message({ correlationId: 'contended' }));
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(settled).toBe(false);
    });

    await pending;
    expect(settled).toBe(true);
    expect(cli.list({ limit: 10 })).toHaveLength(1);
  });

  it('consumes targeted messages at most once across store reopen', async () => {
    const s = store();
    await s.publish(message());
    expect(await s.consume('worker-b', { repository: '/repo' })).toHaveLength(1);
    const reopened = new CoordinationStore(join(dir, 'events.json'));
    expect(await reopened.consume('worker-b', { repository: '/repo' })).toEqual([]);
  });

  it('redacts secret fields and values before persistence', async () => {
    const s = store();
    await s.publish(message({ detail: 'Bearer abcdefghijk', metadata: { apiKey: 'secret', note: 'ghp_abcdefghijk' } }));
    const raw = readFileSync(join(dir, 'events.json'), 'utf8');
    expect(raw).not.toContain('abcdefghijk');
    expect(raw).not.toContain('secret');
    expect(raw).toContain('[redacted]');
    expect(statSync(join(dir, 'events.json')).mode & 0o777).toBe(0o600);
  });

  it('fails closed on corrupt persisted state', () => {
    const s = store();
    writeFileSync(join(dir, 'events.json'), '{bad json');
    expect(() => s.list()).toThrow('Coordination store is corrupt');
  });

  it('folds terminal correlation state out of pending', async () => {
    const s = store();
    await s.publish(message());
    await s.publish(message({ actor: 'worker-b', recipient: 'worker-a', kind: 'advice-response', status: 'completed', summary: 'use the existing helper' }));
    expect(s.snapshot('/repo').pending).toEqual([]);
  });
});
