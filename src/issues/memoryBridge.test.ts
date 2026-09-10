// ============================================
// OpenSwarm - Issue ↔ Memory Bridge Tests
// ============================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { autoLinkMemories, AUTO_LINK_SEARCH_DEADLINE_MS } from './memoryBridge.js';
import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue } from './schema.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSearchMemorySafe = vi.fn();
vi.mock('../memory/memoryCore.js', () => ({
  searchMemorySafe: (...args: unknown[]) => mockSearchMemorySafe(...args),
  saveMemory: vi.fn(),
  saveCognitiveMemory: vi.fn(),
  getMemoriesByIds: vi.fn(),
  hasMemoryDerivedFrom: vi.fn().mockResolvedValue(false),
  getMemoryIdsByDerivedFrom: vi.fn().mockResolvedValue([]),
}));

/** Minimal mock store that records linkMemory calls. */
function createMockStore(): SqliteIssueStore {
  const linked: Array<{ issueId: string; memoryId: string }> = [];
  return {
    linkMemory: vi.fn((issueId: string, memoryId: string) => {
      linked.push({ issueId, memoryId });
    }),
    getLinked: () => linked,
  } as unknown as SqliteIssueStore;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'test-issue-1',
    title: 'Fix login bug',
    description: 'Users cannot log in with SSO',
    status: 'todo',
    priority: 'medium',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Issue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoLinkMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when query is too short', async () => {
    const store = createMockStore();
    const issue = makeIssue({ title: 'Hi', description: '' });
    const result = await autoLinkMemories(store, issue);
    expect(result).toEqual([]);
    expect(mockSearchMemorySafe).not.toHaveBeenCalled();
  });

  it('links memories on successful search', async () => {
    const store = createMockStore();
    const issue = makeIssue();
    mockSearchMemorySafe.mockResolvedValue({
      success: true,
      memories: [
        { id: 'mem-1', content: 'SSO flow', similarity: 0.85 },
        { id: 'mem-2', content: 'Auth patterns', similarity: 0.72 },
      ],
    });

    const result = await autoLinkMemories(store, issue);
    expect(result).toEqual(['mem-1', 'mem-2']);
    expect(store.linkMemory).toHaveBeenCalledTimes(2);
    expect(store.linkMemory).toHaveBeenCalledWith('test-issue-1', 'mem-1');
    expect(store.linkMemory).toHaveBeenCalledWith('test-issue-1', 'mem-2');
  });

  it('returns empty when search returns no memories', async () => {
    const store = createMockStore();
    const issue = makeIssue();
    mockSearchMemorySafe.mockResolvedValue({
      success: true,
      memories: [],
    });

    const result = await autoLinkMemories(store, issue);
    expect(result).toEqual([]);
    expect(store.linkMemory).not.toHaveBeenCalled();
  });

  it('returns empty when search fails', async () => {
    const store = createMockStore();
    const issue = makeIssue();
    mockSearchMemorySafe.mockResolvedValue({
      success: false,
      memories: [],
      error: 'DB error',
      errorCode: 'DB_INIT_FAILED',
    });

    const result = await autoLinkMemories(store, issue);
    expect(result).toEqual([]);
    expect(store.linkMemory).not.toHaveBeenCalled();
  });

  it('recovers gracefully when searchMemorySafe hangs past deadline', async () => {
    const store = createMockStore();
    const issue = makeIssue();

    // Simulate a search that never settles (ignores AbortSignal)
    mockSearchMemorySafe.mockReturnValue(new Promise<never>(() => {
      /* never resolves or rejects — hangs forever */
    }));

    // The withDeadline wrapper should force rejection within ~10s.
    // Use a short timeout to keep the test fast.
    const start = Date.now();
    const result = await autoLinkMemories(store, issue);
    const elapsed = Date.now() - start;

    // Must settle within a reasonable bound (deadline + small overhead)
    expect(elapsed).toBeLessThan(15_000);
    expect(result).toEqual([]);
    expect(store.linkMemory).not.toHaveBeenCalled();
  }, 20_000);

  it('recovers gracefully when searchMemorySafe rejects after deadline', async () => {
    const store = createMockStore();
    const issue = makeIssue();

    // Simulate a search that rejects very late (after deadline)
    mockSearchMemorySafe.mockReturnValue(
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('too slow')), 30_000);
      }),
    );

    const start = Date.now();
    const result = await autoLinkMemories(store, issue);
    const elapsed = Date.now() - start;

    // Must settle within deadline, not wait 30s
    expect(elapsed).toBeLessThan(15_000);
    expect(result).toEqual([]);
    expect(store.linkMemory).not.toHaveBeenCalled();
  }, 20_000);

  it('frees the scheduler slot after the deadline so a subsequent job can start while the search is still pending', async () => {
    vi.useFakeTimers();
    try {
      // 1-슬롯 스케줄러 모의: 작업이 정산될 때만 slotFreed를 내보낸다.
      const scheduler = new EventEmitter();
      const MAX_CONCURRENT_JOBS = 1;
      let running = 0;
      let secondJobStarted = false;
      let searchSettled = false;

      // AbortSignal을 무시하고 영원히 pending인 검색
      mockSearchMemorySafe.mockImplementation(() => {
        const pending = new Promise<never>(() => {});
        void pending.then(
          () => { searchSettled = true; },
          () => { searchSettled = true; },
        );
        return pending;
      });

      const runJob = async (label: 'first' | 'second'): Promise<string[]> => {
        if (running >= MAX_CONCURRENT_JOBS) {
          await new Promise<void>((resolve) => scheduler.once('slotFreed', resolve));
        }
        running += 1;
        if (label === 'second') secondJobStarted = true;
        try {
          return await autoLinkMemories(createMockStore(), makeIssue());
        } finally {
          running -= 1;
          scheduler.emit('slotFreed');
        }
      };

      const firstJob = runJob('first');
      await vi.advanceTimersByTimeAsync(0);
      expect(running).toBe(1);
      expect(mockSearchMemorySafe).toHaveBeenCalledTimes(1);

      // 슬롯 1개가 점유 중이라 두 번째 작업은 대기 상태
      const secondJob = runJob('second');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(secondJobStarted).toBe(false);
      expect(running).toBe(1);

      // 기한 만료 → 첫 작업 정산 → slotFreed → 두 번째 작업이 슬롯 획득
      await vi.advanceTimersByTimeAsync(AUTO_LINK_SEARCH_DEADLINE_MS);
      expect(secondJobStarted).toBe(true);
      expect(mockSearchMemorySafe).toHaveBeenCalledTimes(2);

      // 두 번째 작업도 자체 기한 내 정산
      await vi.advanceTimersByTimeAsync(AUTO_LINK_SEARCH_DEADLINE_MS);
      const [firstResult, secondResult] = await Promise.all([firstJob, secondJob]);
      expect(firstResult).toEqual([]);
      expect(secondResult).toEqual([]);
      expect(running).toBe(0);

      // 첫 검색은 여전히 pending — 그럼에도 슬롯은 회수됐다
      expect(searchSettled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});