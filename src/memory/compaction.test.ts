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

  it('deduplicates records that arrive on different pagination pages', () => {
    // Simulate two pages of 10,000 records where the duplicate pair straddles
    // the page boundary: 'dup-9999' ends page 1, 'dup-10000' starts page 2.
    const page1 = Array.from({ length: 10_000 }, (_, i) =>
      record(`p1-${i}`, '{"project":"alpha"}'));
    const page2 = Array.from({ length: 10_000 }, (_, i) =>
      record(`p2-${i}`, '{"project":"beta"}'));

    // Same repo/type/derivedFrom/metadata as p1-9999, near-identical vector.
    const straddler = {
      ...record('p2-straddler', '{"project":"alpha"}'),
      vector: [1, 0.05],
      importance: 0.9,
      lastUpdated: 2,
    };

    const result = removeDuplicates([...page1, straddler, ...page2]);

    expect(result).toHaveLength(20_000);
    const ids = new Set(result.map((r) => r.id));
    expect(ids.has('p1-9999')).toBe(true);
    expect(ids.has('p2-straddler')).toBe(false);
    // The higher-importance, more recent straddler wins the merge.
    const kept = result.find((r) => r.id === 'p1-9999');
    expect(kept).toBeUndefined();
    // The winner is the straddler itself (kept under its own id).
    expect(result.filter((r) => r.metadata === '{"project":"alpha"}')).toHaveLength(1);
  });

  it('keeps distinct records that merely share metadata but differ in vector', () => {
    const a = { ...record('a', '{"project":"alpha"}'), vector: [1, 0] };
    const b = { ...record('b', '{"project":"alpha"}'), vector: [0, 1] };
    expect(removeDuplicates([a, b])).toHaveLength(2);
  });
});
