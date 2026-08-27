import { describe, it, expect } from 'vitest';
import { isKnownAdapter, listAdapterNames } from './index.js';

describe('isKnownAdapter', () => {
  it('accepts currently-registered adapters (incl. claude, the opt-in claude -p delegate)', () => {
    for (const name of ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'claude', 'cc-router', 'cursor']) {
      expect(isKnownAdapter(name)).toBe(true);
    }
  });

  it('rejects unknown providers', () => {
    expect(isKnownAdapter('')).toBe(false);
    expect(isKnownAdapter('anthropic')).toBe(false);
    expect(isKnownAdapter('gpt5')).toBe(false);
    // must not be fooled by Object.prototype members
    expect(isKnownAdapter('toString')).toBe(false);
    expect(isKnownAdapter('constructor')).toBe(false);
  });

  it('listAdapterNames returns every registered adapter', () => {
    expect([...listAdapterNames()].sort()).toEqual(
      ['atlascloud', 'cc-router', 'claude', 'codex', 'cursor', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter'].sort(),
    );
  });
});
