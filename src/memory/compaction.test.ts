import { describe, expect, it } from 'vitest';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { removeDuplicates } from './compaction.js';

function record(id: string, metadata: string): CognitiveMemoryRecord {
  return {
    id, type: 'constraint', content: id, vector: [1, 0], importance: 0.5,
    confidence: 1, createdAt: 1, lastUpdated: 1, lastAccessed: 1,
    derivedFrom: 'source', repo: 'repo', title: id, metadata, trust: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe('memory compaction deduplication', () => {
  it('compares JSON metadata structurally regardless of key order', () => {
    expect(removeDuplicates([
      record('a', '{"project":"p","nested":{"x":1,"y":2}}'),
      record('b', '{"nested":{"y":2,"x":1},"project":"p"}'),
    ])).toHaveLength(1);
  });

  it('deduplicates a near-duplicate pair that straddles a pagination boundary', () => {
    // Page 1 ends at p1-9999; the straddler is the first record of page 2 and
    // shares p1-9999's identity (same metadata), so the pair only meets if
    // dedup considers records from both pages together. It has a near-identical
    // but not equal vector, and higher importance, so it must win the merge.
    const page1 = Array.from({ length: 10_000 }, (_, i) =>
      record(`p1-${i}`, `{"i":${i}}`));
    const page2 = Array.from({ length: 10_000 }, (_, i) =>
      record(`p2-${i}`, `{"j":${i}}`));
    const straddler = {
      ...record('p2-straddler', '{"i":9999}'),
      vector: [1, 0.05],
      importance: 0.9,
      lastUpdated: 2,
    };

    const result = removeDuplicates([...page1, straddler, ...page2]);
    const ids = new Set(result.map((r) => r.id));

    // 20_001 inputs collapse to 20_000: the cross-page pair merges into one.
    expect(result).toHaveLength(20_000);
    expect(ids.has('p2-straddler')).toBe(true);
    expect(ids.has('p1-9999')).toBe(false);
    // Records whose identity merely neighbours the boundary are untouched.
    expect(ids.has('p1-9998')).toBe(true);
    expect(ids.has('p2-0')).toBe(true);
  });

  it('keeps records that share identity metadata but differ in vector', () => {
    const a = { ...record('a', '{"project":"alpha"}'), vector: [1, 0] };
    const b = { ...record('b', '{"project":"alpha"}'), vector: [0, 1] };
    expect(removeDuplicates([a, b])).toHaveLength(2);
  });
});
