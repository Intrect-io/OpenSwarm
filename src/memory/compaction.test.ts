import { vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { removeDuplicates } from './compaction.js';

function record(id: string, metadata: string, vector: number[] = [1, 0]): CognitiveMemoryRecord {
  return {
    id, type: 'constraint', content: id, vector, importance: 0.5,
    confidence: 1, createdAt: 1, lastUpdated: 1, lastAccessed: 1,
    derivedFrom: 'source', repo: 'repo', title: id, metadata, trust: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

/** A vector as it actually arrives from a stored row: an Arrow Vector. */
function storedVector(values: number[]): unknown {
  return vectorFromArray(new Float32Array(values));
}

describe('memory compaction deduplication', () => {
  it('compares JSON metadata structurally regardless of key order', () => {
    expect(removeDuplicates([
      record('a', '{"project":"p","nested":{"x":1,"y":2}}'),
      record('b', '{"nested":{"y":2,"x":1},"project":"p"}'),
    ])).toHaveLength(1);
  });

  it('merges duplicates whose vectors are stored as Arrow vectors', () => {
    // Indexing an Arrow vector yields undefined, so comparing them as JS arrays
    // scored NaN, matched nothing, and let every duplicate survive a
    // compaction that still reported success.
    const merged = removeDuplicates([
      record('a', '{}', storedVector([1, 0]) as unknown as number[]),
      record('b', '{}', storedVector([1, 0]) as unknown as number[]),
      record('c', '{}', storedVector([0, 1]) as unknown as number[]),
    ]);

    expect(merged.map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it('keeps records that share identity metadata but differ in vector', () => {
    const a = { ...record('a', '{"project":"alpha"}'), vector: [1, 0] };
    const b = { ...record('b', '{"project":"alpha"}'), vector: [0, 1] };
    expect(removeDuplicates([a, b])).toHaveLength(2);
  });

  it('merges a duplicate pair split across two scan pages', () => {
    // The compaction scan feeds records in pages; a duplicate whose twin sits in
    // a later page must still be recognised, so the traversal cannot restart per
    // page. (The stored-table path is covered end to end in compaction.store.test.ts.)
    const firstPage = [
      record('page1-a', '{}', [1, 0]),
      record('page1-b', '{}', [0, 1]),
    ];
    const secondPage = [
      record('page2-a', '{}', [1, 0]),   // twin of page1-a, one page later
      record('page2-b', '{}', [-1, 0]),  // distinct from both
    ];

    // Streamed across both pages, the boundary duplicate is merged.
    expect(removeDuplicates([...firstPage, ...secondPage]).map((entry) => entry.id))
      .toEqual(['page1-a', 'page1-b', 'page2-b']);
    // Deduplicating each page on its own keeps it — the result that was
    // previously reported as a successful compaction.
    expect(removeDuplicates(firstPage).map((entry) => entry.id)).toEqual(['page1-a', 'page1-b']);
    expect(removeDuplicates(secondPage).map((entry) => entry.id)).toEqual(['page2-a', 'page2-b']);
  });
});
