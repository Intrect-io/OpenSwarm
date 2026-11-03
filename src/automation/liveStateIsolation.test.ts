import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUS_DIR, BUS_RETENTION_MS, createBus, pruneStaleBuses } from '../agents/agentBus.js';
import { DAILY_PACE_FILE, PROJECT_SELECTION_FILE, recordProjectCompletion } from './runnerState.js';

const operatorState = resolve(homedir(), '.openswarm');
const inside = (child: string, parent: string) => {
  const rel = relative(parent, resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

describe('live state isolation', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps daily pace and bus writes out of the operator state dir', async () => {
    for (const path of [DAILY_PACE_FILE, PROJECT_SELECTION_FILE, BUS_DIR]) {
      expect(inside(path, operatorState)).toBe(false);
      expect(inside(path, tmpdir())).toBe(true);
    }

    recordProjectCompletion('isolation-probe', 0);
    expect(existsSync(DAILY_PACE_FILE)).toBe(true);

    const id = `isolation-${process.pid}-${Date.now()}`;
    const bus = createBus(id);
    await bus.init('isolation');
    try {
      expect(existsSync(join(BUS_DIR, id, 'context.json'))).toBe(true);
    } finally {
      await bus.cleanup();
    }
  });

  it('prunes bus directories older than the TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-bus-prune-'));
    scratch.push(dir);
    const now = Date.now();
    const make = (id: string, ageMs: number, withMessages = true) => {
      const root = join(dir, id);
      mkdirSync(join(root, 'messages'), { recursive: true });
      writeFileSync(join(root, 'context.json'), '{}');
      const at = (now - ageMs) / 1000;
      for (const p of [join(root, 'context.json'), ...(withMessages ? [join(root, 'messages')] : []), root]) utimesSync(p, at, at);
    };
    make('stale', BUS_RETENTION_MS + 60_000);
    make('fresh', 60_000);
    // Old directory, but a message landed a minute ago: still in use.
    make('busy', BUS_RETENTION_MS + 60_000, false);
    utimesSync(join(dir, 'busy', 'messages'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    writeFileSync(join(dir, 'not-a-dir'), '');

    const removed = await pruneStaleBuses({ dir, now });

    expect(removed).toEqual(['stale']);
    expect(existsSync(join(dir, 'stale'))).toBe(false);
    expect(existsSync(join(dir, 'fresh'))).toBe(true);
    expect(existsSync(join(dir, 'busy'))).toBe(true);
    expect(existsSync(join(dir, 'not-a-dir'))).toBe(true);
    expect(await pruneStaleBuses({ dir: join(dir, 'missing') })).toEqual([]);
  });
});
