import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __clearPendingLinearMappingsForTests,
  __setLinearBridgeClientForTests,
  pushToLinear,
} from './linearBridge.js';
import { SqliteIssueStore } from './sqliteStore.js';

let dir: string | undefined;

function dbPath(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'openswarm-linear-bridge-'));
  return join(dir, 'issues.db');
}

function installFakeLinear(createIssue = vi.fn()) {
  const fakeClient = {
    createIssue,
    team: vi.fn(async () => ({
      states: async () => ({
        nodes: [
          { id: 'state-todo', name: 'Todo' },
          { id: 'state-backlog', name: 'Backlog' },
        ],
      }),
    })),
  };
  createIssue.mockResolvedValue({
    issue: Promise.resolve({
      id: 'lin-uuid-1',
      identifier: 'AGT-1',
      url: 'https://linear.app/agt-1',
    }),
  });
  __setLinearBridgeClientForTests(fakeClient, 'team-test');
  return { fakeClient, createIssue };
}

beforeEach(() => {
  __clearPendingLinearMappingsForTests();
});

afterEach(() => {
  __clearPendingLinearMappingsForTests();
  __setLinearBridgeClientForTests(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('pushToLinear mapping recovery', () => {
  it('returns the Linear id when local mapping persist fails and does not recreate on retry', async () => {
    const { createIssue } = installFakeLinear();
    const store = new SqliteIssueStore(dbPath());
    const issue = store.createIssue({ projectId: 'p', title: 'recover-me', status: 'todo' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const updateIssue = vi.spyOn(store, 'updateIssue').mockImplementation(() => {
      throw new Error('persist boom');
    });

    const first = await pushToLinear(store, issue.id);
    expect(first).toBe('lin-uuid-1');
    expect(createIssue).toHaveBeenCalledTimes(1);
    // Mapping never landed locally.
    expect(store.getIssue(issue.id)?.linearId).toBeUndefined();

    const second = await pushToLinear(store, issue.id);
    expect(second).toBe('lin-uuid-1');
    // Pending-map recovery must not call Linear create again.
    expect(createIssue).toHaveBeenCalledTimes(1);

    updateIssue.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    store.close();
  });

  it('retries pending mapping persist and recovers without a second Linear create', async () => {
    const { createIssue } = installFakeLinear();
    const store = new SqliteIssueStore(dbPath());
    const issue = store.createIssue({ projectId: 'p', title: 'retry-map', status: 'todo' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    let failuresLeft = 4; // 3 persist attempts + 1 updateIssue-only recovery path
    const realUpdate = store.updateIssue.bind(store);
    const updateIssue = vi.spyOn(store, 'updateIssue').mockImplementation((id, patch) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error(`persist fail ${failuresLeft}`);
      }
      return realUpdate(id, patch);
    });

    const first = await pushToLinear(store, issue.id);
    expect(first).toBe('lin-uuid-1');
    expect(store.getIssue(issue.id)?.linearId).toBeUndefined();
    expect(createIssue).toHaveBeenCalledTimes(1);

    updateIssue.mockRestore();
    const recovered = await pushToLinear(store, issue.id);
    expect(recovered).toBe('lin-uuid-1');
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(store.getIssue(issue.id)?.linearId).toBe('lin-uuid-1');
    expect(store.getIssue(issue.id)?.linearIdentifier).toBe('AGT-1');

    warn.mockRestore();
    error.mockRestore();
    store.close();
  });
});
