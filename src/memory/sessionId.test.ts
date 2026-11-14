// ============================================
// OpenSwarm - codex session id uniqueness tests
// ============================================
//
// Session ids used to be `session-${Date.now()}`, so two sessions started in
// the same millisecond (parallel workers) got the same id and their records
// mixed. The id keeps the `session-<ms>` prefix and adds a random suffix.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBuilder, newSessionId, sessionFilenameSuffix } from './codex.js';

const AT = 1_785_050_644_884;

describe('codex session id', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives two sessions started in the same millisecond different ids', () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const a = new SessionBuilder('same title').getSession();
    const b = new SessionBuilder('same title').getSession();
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.id).not.toBe(b.id);
    expect(sessionFilenameSuffix(a.id)).not.toBe(sessionFilenameSuffix(b.id));
  });

  it('keeps the session-<ms> prefix so ids still read by start time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    expect(new SessionBuilder('t').getSession().id.startsWith(`session-${AT}-`)).toBe(true);
    expect(newSessionId(AT)).toMatch(new RegExp(`^session-${AT}-[0-9a-f-]{36}$`));
  });
});
