import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// callChatModel is a thin wrapper over chatBackend.runChatCompletion; mock the
// backend so the wrapper is exercised without spawning a real provider.
vi.mock('./chatBackend.js', () => ({
  getDefaultChatModel: (p: string) => `default-${p}`,
  runChatCompletion: vi.fn(async (opts: { onText?: (t: string, k: boolean) => void }) => {
    opts.onText?.('streamed', false);
    return { response: 'streamed', sessionId: 'sess-1', cost: 0.25, tokens: 12 };
  }),
}));

// Pass-through spy so the coalescing test can count real writes. (AGT-3494)
const atomicWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock('./atomicFile.js', async () => {
  const actual = await vi.importActual<typeof import('./atomicFile.js')>('./atomicFile.js');
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      atomicWrites.count += 1;
      return actual.atomicWriteFileSync(...args);
    },
  };
});

import {
  generateSessionId,
  inferProvider,
  saveSession,
  loadSession,
  listSessions,
  latestSession,
  callChatModel,
  appendSessionArchive,
  sessionArchivePath,
  type Session,
} from './chatSession.js';

describe('generateSessionId', () => {
  it('produces a YYYYMMDD-HHMM id', () => {
    expect(generateSessionId()).toMatch(/^\d{8}-\d{4}$/);
  });
});

describe('listSessions / latestSession (INT-2014)', () => {
  const mk = (id: string): Session => ({
    id, provider: 'codex', model: 'm', messages: [], totalCost: 0, totalTokens: 0, createdAt: '', updatedAt: '',
  });

  it('lists newest-first and returns the latest id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'os-sess-'));
    try {
      await saveSession(mk('s1'), dir);
      await new Promise((r) => setTimeout(r, 15));
      await saveSession(mk('s2'), dir);
      const list = await listSessions(dir);
      expect(list.map((m) => m.id)).toEqual(['s2', 's1']);
      expect(await latestSession(dir)).toBe('s2');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] / null for a missing dir', async () => {
    const nope = path.join(os.tmpdir(), 'os-nope-' + process.pid);
    expect(await listSessions(nope)).toEqual([]);
    expect(await latestSession(nope)).toBeNull();
  });
});

describe('inferProvider', () => {
  it('passes through a known adapter', () => {
    expect(inferProvider('codex')).toBe('codex');
    expect(inferProvider('openrouter')).toBe('openrouter');
  });

  it('infers codex from a gpt-/codex model when no valid provider', () => {
    expect(inferProvider(undefined, 'gpt-4o')).toBe('codex');
    expect(inferProvider(undefined, 'something-codex-mini')).toBe('codex');
    // An unknown provider string is not trusted; the model still routes it.
    expect(inferProvider('bogus' as never, 'gpt-4o')).toBe('codex');
  });

  it('falls back to the default provider for an unknown model', () => {
    // Whatever the env default is, it must be a non-empty adapter name.
    expect(inferProvider(undefined, 'mystery-model')).toBeTruthy();
  });
});

describe('saveSession / loadSession (injectable dir)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatsess-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const mk = (over: Partial<Session> = {}): Session => ({
    id: '20260626-1200',
    provider: 'codex',
    model: 'gpt-5.2-codex',
    messages: [{ role: 'user', content: 'hi' }],
    totalCost: 0.5,
    totalTokens: 42,
    createdAt: '2026-06-26T12:00:00.000Z',
    updatedAt: '2026-06-26T12:00:00.000Z',
    ...over,
  });

  it('round-trips a session, preserving a valid provider/model', async () => {
    await saveSession(mk(), dir);
    const loaded = await loadSession('20260626-1200', dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.provider).toBe('codex');
    expect(loaded!.model).toBe('gpt-5.2-codex');
    expect(loaded!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(loaded!.totalTokens).toBe(42);
  });

  it('collapses a burst of saves into the newest snapshot without losing the final state (AGT-3494)', async () => {
    const snap = (n: number) => mk({ messages: Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `m${i}` })) });
    const before = atomicWrites.count;
    await Promise.all([1, 2, 3, 4, 5].map((n) => saveSession(snap(n), dir)));
    const loaded = await loadSession('20260626-1200', dir);
    expect(loaded!.messages).toHaveLength(5);
    expect(atomicWrites.count - before).toBeLessThanOrEqual(2);
  });

  it('never leaves an older snapshot on disk after a newer save resolves', async () => {
    const first = saveSession(mk({ messages: [{ role: 'user', content: 'old' }] }), dir);
    const second = saveSession(mk({ messages: [{ role: 'user', content: 'new' }] }), dir);
    await second;
    expect((await loadSession('20260626-1200', dir))!.messages[0].content).toBe('new');
    await first;
    expect((await loadSession('20260626-1200', dir))!.messages[0].content).toBe('new');
  });

  it('recovers after a failed directory step instead of reusing its rejection', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    await fs.writeFile(blocker, 'x');
    await expect(saveSession(mk(), path.join(blocker, 'sub'))).rejects.toThrow();
    await expect(saveSession(mk(), path.join(blocker, 'sub'))).rejects.toThrow();
    await saveSession(mk(), dir);
    expect(await loadSession('20260626-1200', dir)).not.toBeNull();
  });

  it('returns null for a missing session', async () => {
    expect(await loadSession('does-not-exist', dir)).toBeNull();
  });

  it('returns null for a corrupt session and creates snapshots owner-only', async () => {
    await fs.writeFile(path.join(dir, 'broken.json'), '{broken');
    expect(await loadSession('broken', dir)).toBeNull();
    await saveSession(mk(), dir);
    expect((await fs.stat(path.join(dir, '20260626-1200.json'))).mode & 0o777).toBe(0o600);
  });

  it('repairs an unknown persisted provider on load (default model from backend)', async () => {
    // Hand-write a session whose provider is no longer a valid adapter.
    await fs.writeFile(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', provider: 'bogus', model: 'gpt-4o', messages: [], createdAt: '', updatedAt: '' }),
    );
    const loaded = await loadSession('bad', dir);
    expect(loaded!.provider).toBe('codex'); // inferred from the gpt- model
    expect(loaded!.model).toBe('default-codex'); // provider changed → default model
    expect(loaded!.totalCost).toBe(0); // missing fields defaulted
  });
});

describe('appendSessionArchive (resume trim archive)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatarch-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('appends messages as JSON lines next to the session file and stays out of listSessions', async () => {
    appendSessionArchive('s1', [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }], dir);
    appendSessionArchive('s1', [{ role: 'user', content: 'q2' }], dir);
    appendSessionArchive('s1', [], dir);
    const file = sessionArchivePath('s1', dir);
    expect(file).toBe(path.join(dir, 's1.archive.jsonl'));
    const lines = (await fs.readFile(file, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(await listSessions(dir)).toEqual([]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects an id that would escape the chat directory', () => {
    expect(() => appendSessionArchive('../evil', [{ role: 'user', content: 'x' }], dir)).toThrow();
  });
});

describe('callChatModel', () => {
  it('forwards to the backend and normalizes the result', async () => {
    const streamed: string[] = [];
    const out = await callChatModel('hi', 'codex', 'gpt-5.2-codex', (t) => streamed.push(t));
    expect(out).toEqual({ response: 'streamed', sessionId: 'sess-1', cost: 0.25, tokens: 12 });
    expect(streamed).toContain('streamed');
  });
});
